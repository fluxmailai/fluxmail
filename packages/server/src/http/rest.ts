import { createHash, randomUUID } from 'node:crypto';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HttpBindings } from '@hono/node-server';
import {
  EmailError,
  isEmailError,
  mergeEmailQueries,
  parseEmailSearch,
  type EmailQuery,
  type ModifyAction,
  type PageOpts,
  type PortableEmailQuery,
  type SearchDiagnostic,
} from '@fluxmail/core';
import { MODIFY_ACTION_SCOPES } from '@fluxmail/core/mcp';
import type { ConfigurationService, FluxmailConfig } from '../config.js';
import type { AccountRegistry } from '../accounts/registry.js';
import { connectionFailureKind } from '../accounts/telemetry.js';
import type { LicenseController } from '../licensing/refresher.js';
import { batchFailureCause, type EmailService, type SendInput } from '../service/emailService.js';
import type { FluxmailDb } from '../storage/db.js';
import { authenticateBearer, isBootstrapComplete, type Principal } from '../auth.js';
import { completeIdempotencyKey, lookupIdempotencyKey, reserveIdempotencyKey } from '../storage/restIdempotency.js';
import { enableCapabilitiesInstructions, type Capability, type McpCapability } from '../permissions.js';
import { allowsCapability } from '../authorization.js';
import { captureOperation, type OperationOutcome, type Telemetry, type TelemetryProperties } from '../telemetry.js';
import { VERSION } from '../version.js';
import { administrationUsesHttps, adminOperationId, registerAdminRoutes, requestBodyExceedsLimit } from './admin.js';
import { recordAdminAuditEvent } from '../storage/adminAudit.js';
import { identityOperationId, registerIdentityRoutes } from './identity.js';
import { operationProperties } from './operationTelemetry.js';
import { logCodedFailure, logFailure, type Logger } from '../logging.js';
import {
  attachmentTooLarge,
  ClientInputError,
  isAttachmentSizeError,
  MissingCapabilityError,
  publicError,
} from '../service/publicErrors.js';

interface RestVariables {
  restAuth: Principal;
  restService: EmailService;
  restLogger?: Logger;
  restTelemetry?: TelemetryProperties;
}

type RestEnv = { Bindings: HttpBindings; Variables: RestVariables };
type RestContext = Context<RestEnv>;

export interface RestApiDeps {
  config: FluxmailConfig;
  configuration: ConfigurationService;
  db: FluxmailDb;
  service: EmailService;
  telemetry?: Telemetry;
  logger?: Logger;
  registry?: AccountRegistry;
  licenseController?: LicenseController;
}

const id = z.string().trim().min(1);
const accountId = id.openapi({ example: 'acct_123' });
const messageId = id.openapi({ example: 'msg_123' });
const threadId = id.openapi({ example: 'thread_123' });
const draftId = id.openapi({ example: 'draft_123' });
const scheduleId = id.openapi({ example: 'schedule_123' });
const attachmentId = id.describe('Opaque attachment ID returned by message metadata').openapi({ example: 'part:1.2' });
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date in YYYY-MM-DD format')
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, 'Expected a valid calendar date')
  .openapi({ format: 'date' });
const base64Content = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'Expected base64 content')
  .openapi({ format: 'byte' });
const accountParams = z.object({ accountId }).strict();
const messageParams = z.object({ accountId, messageId }).strict();
const threadParams = z.object({ accountId, threadId }).strict();
const draftParams = z.object({ accountId, draftId }).strict();
const scheduleParams = z.object({ accountId, scheduleId }).strict();
const attachmentParams = z.object({ accountId, messageId, attachmentId }).strict();

const EmailAddressSchema = z
  .object({ email: z.string().email(), name: z.string().min(1).optional() })
  .strict()
  .openapi('EmailAddress');
const MessageBodySchema = z
  .object({ text: z.string().optional(), html: z.string().optional() })
  .strict()
  .openapi('MessageBody');
const MessageInputBodySchema = z
  .object({
    text: z
      .string()
      .optional()
      .describe(
        'Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines.',
      ),
    html: z.string().optional(),
  })
  .strict()
  .openapi('MessageInputBody');
const AttachmentInputSchema = z
  .object({
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    content: base64Content.describe('Base64-encoded content'),
    contentId: z.string().min(1).optional(),
    disposition: z.enum(['inline', 'attachment']).optional(),
  })
  .strict()
  .openapi('AttachmentInput');
const AttachmentMetaSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    contentId: z.string().optional(),
    disposition: z.enum(['inline', 'attachment']).optional(),
  })
  .strict()
  .openapi('AttachmentMeta');
const FolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.enum(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'starred', 'all']).optional(),
    roleSource: z.enum(['user', 'extension', 'name']).optional(),
    unreadCount: z.number().int().nonnegative().optional(),
  })
  .strict()
  .openapi('Folder');
const LabelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z
      .object({
        background: z.string().optional(),
        text: z.string().optional(),
        preset: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .openapi('Label');
const SendAsIdentitySchema = z
  .object({
    email: z.string().email(),
    name: z.string().optional(),
    replyTo: z.string().email().optional(),
    isPrimary: z.boolean(),
    source: z.enum(['provider', 'configured']),
  })
  .strict()
  .openapi('SendAsIdentity');
const ConfiguredSendAsSchema = z
  .object({ email: z.string().email(), name: z.string().optional() })
  .strict()
  .openapi('ConfiguredSendAs');
const ReplaceSendAsRequestSchema = z
  .object({ identities: z.array(ConfiguredSendAsSchema) })
  .strict()
  .openapi('ReplaceSendAsRequest');
const MessageSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    accountId: z.string(),
    draftId: z.string().optional(),
    folder: FolderSchema.optional(),
    labels: z.array(z.string()).optional(),
    from: EmailAddressSchema.optional(),
    to: z.array(EmailAddressSchema),
    cc: z.array(EmailAddressSchema).optional(),
    bcc: z.array(EmailAddressSchema).optional(),
    replyTo: z.array(EmailAddressSchema).optional(),
    subject: z.string(),
    date: z.string(),
    snippet: z.string().optional(),
    searchContext: z
      .union([
        z.object({ status: z.literal('matched'), excerpt: z.string() }).strict(),
        z.object({ status: z.enum(['no_literal_match', 'scan_limit', 'unavailable']) }).strict(),
      ])
      .optional()
      .describe('Optional body excerpt status for a requested portable text search.'),
    body: MessageBodySchema.optional(),
    attachments: z.array(AttachmentMetaSchema).optional(),
    flags: z.object({ read: z.boolean(), starred: z.boolean(), draft: z.boolean() }).strict(),
    headers: z.record(z.string()).optional(),
  })
  .strict()
  .openapi('Message');
const SearchDiagnosticSchema = z
  .object({
    code: z.string(),
    severity: z.enum(['error', 'warning']),
    message: z.string(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    suggestion: z.string().optional(),
  })
  .strict()
  .openapi('SearchDiagnostic');
const ThreadSchema = z
  .object({ id: z.string(), subject: z.string(), messages: z.array(MessageSchema) })
  .strict()
  .openapi('Thread');
const AccountSchema = z
  .object({
    id: z.string(),
    provider: z.enum(['gmail', 'outlook', 'imap']),
    email: z.string(),
    displayName: z.string().optional(),
    status: z.enum(['active', 'auth_error', 'disabled']),
    capabilities: z
      .object({
        labels: z.boolean(),
        serverThreads: z.boolean(),
        serverSearch: z.enum(['rich', 'basic']),
        search: z
          .object({
            filters: z.array(
              z.enum([
                'folder',
                'text',
                'from',
                'to',
                'subject',
                'read',
                'starred',
                'hasAttachment',
                'after',
                'before',
              ]),
            ),
            folderRoles: z
              .object({
                inbox: z.enum(['available', 'unavailable', 'unknown']),
                sent: z.enum(['available', 'unavailable', 'unknown']),
                drafts: z.enum(['available', 'unavailable', 'unknown']),
                archive: z.enum(['available', 'unavailable', 'unknown']),
                spam: z.enum(['available', 'unavailable', 'unknown']),
                trash: z.enum(['available', 'unavailable', 'unknown']),
                all: z.enum(['available', 'unavailable', 'unknown']),
              })
              .strict(),
            nativeQuery: z
              .object({
                syntax: z.enum(['gmail', 'outlook-kql']),
                availability: z.enum(['available', 'unavailable', 'unknown']),
                unavailableReason: z.string().optional(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
        snippets: z.boolean(),
        searchContext: z.boolean().optional().describe('Supports optional match-centered body excerpts.'),
      })
      .strict(),
    ownerMemberId: z.string(),
    sharedWithAll: z.boolean(),
    grantedMemberIds: z.array(z.string()),
  })
  .strict()
  .openapi('Account');
const ScheduledSendSchema = z
  .object({
    scheduleId: z.string(),
    operationId: z.string().optional(),
    accountId: z.string(),
    draftId: z.string(),
    sendAt: z.string(),
    status: z.enum(['pending', 'sending', 'sent', 'failed', 'uncertain', 'canceled']),
    attempts: z.number().int().nonnegative(),
    subject: z.string().optional(),
    to: z.string().optional(),
    lastError: z.string().optional(),
    sentMessageId: z.string().optional(),
    sentThreadId: z.string().optional(),
  })
  .strict()
  .openapi('ScheduledSend');
const SendResultSchema = z
  .object({ id: z.string(), threadId: z.string(), warnings: z.array(z.string()).optional() })
  .strict()
  .openapi('SendResult');
const DeliveryOperationSchema = z
  .object({
    operationId: z.string(),
    accountId: z.string(),
    kind: z.enum(['send', 'forward', 'scheduled']),
    status: z.enum(['queued', 'sending', 'succeeded', 'failed', 'uncertain']),
    result: SendResultSchema.optional(),
    error: z.object({ code: z.string() }).strict().optional(),
    scheduleId: z.string().optional(),
  })
  .strict()
  .openapi('DeliveryOperation');
const SendPreviewSchema = z
  .object({
    accountId: z.string(),
    from: z.string(),
    to: z.array(EmailAddressSchema),
    cc: z.array(EmailAddressSchema),
    bcc: z.array(EmailAddressSchema),
    subject: z.string(),
    attachments: z.array(
      z.object({ filename: z.string(), mimeType: z.string(), sizeBytes: z.number().int() }).strict(),
    ),
    bodyTextChars: z.number().int(),
    bodyHtmlChars: z.number().int(),
  })
  .strict()
  .openapi('SendPreview');
const ModifyResultSchema = z
  .object({
    action: z.string(),
    succeededIds: z.array(z.string()),
    failed: z.array(z.object({ messageId: z.string(), code: z.string() }).strict()),
    uncertainIds: z.array(z.string()),
  })
  .strict();
const ErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string().optional(),
        data: z.record(z.unknown()).optional(),
      })
      .strict(),
  })
  .strict()
  .openapi('RestError');

function dataEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ data: schema, warnings: z.array(z.string()).optional() }).strict();
}

const SearchPageMetaSchema = z
  .object({
    nextPageToken: z.string().optional(),
    exhausted: z.boolean(),
    diagnostics: z.array(SearchDiagnosticSchema).optional(),
    incomplete: z.literal(true).optional(),
    incompleteReason: z.enum(['scan_limit', 'provider_limit', 'time_limit']).optional(),
    inspectedCandidates: z.number().int().nonnegative().optional(),
  })
  .strict()
  .openapi('SearchPageMeta');

function pagedEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z
    .object({
      data: z.array(schema),
      meta: SearchPageMetaSchema,
      warnings: z.array(z.string()).optional(),
    })
    .strict();
}

const BatchSearchResponseSchema = z
  .object({
    data: z.array(
      z.union([
        z.object({ accountId: z.string(), data: z.array(MessageSchema), meta: SearchPageMetaSchema }).strict(),
        z
          .object({
            accountId: z.string(),
            error: z
              .object({
                code: z.string(),
                message: z.string(),
                data: z.record(z.unknown()).optional(),
                exhausted: z.literal(false),
              })
              .strict(),
          })
          .strict(),
      ]),
    ),
    meta: z.object({ exhausted: z.boolean() }).strict(),
    warnings: z.array(z.string()).optional(),
  })
  .strict()
  .openapi('BatchSearchResponse');

const errorResponses = {
  400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid request' },
  401: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Authentication required' },
  403: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Permission or plan denied' },
  404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Resource not found' },
  409: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Request conflict' },
  422: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Unsupported capability' },
  429: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Provider rate limit' },
  500: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Internal error' },
  503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Provider unavailable' },
} as const;

const protectedRoute: { security: Array<Record<string, string[]>> } = {
  security: [{ bearerAuth: [] }],
};
export const REST_OPENAPI_DOCUMENT = {
  openapi: '3.1.0' as const,
  info: {
    title: 'Fluxmail REST API',
    version: VERSION,
    description: 'Read, draft, send, schedule, and organize email through connected Fluxmail accounts.',
  },
};
const idempotencyHeaders = z.object({
  'Idempotency-Key': z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must contain printable ASCII without spaces')
    .describe('A unique key for one intended delivery. Reuse it when retrying the same request.'),
});

const draftShape = {
  from: z.string().email().optional(),
  to: z.array(EmailAddressSchema).optional(),
  cc: z.array(EmailAddressSchema).optional(),
  bcc: z.array(EmailAddressSchema).optional(),
  subject: z.string().optional(),
  body: MessageInputBodySchema,
  replyToMessageId: messageId.optional(),
  replyAll: z.boolean().optional().describe('Requires replyToMessageId when true.'),
  attachments: z.array(AttachmentInputSchema).optional(),
};

function requireReplyTarget(value: { replyAll?: boolean; replyToMessageId?: string }, ctx: z.RefinementCtx): void {
  if (value.replyAll && !value.replyToMessageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replyAll'], message: 'replyAll requires replyToMessageId' });
  }
}

const DraftRequestSchema = z.object(draftShape).strict().superRefine(requireReplyTarget).openapi('DraftRequest');
const SendContentSchema = z
  .object({ ...draftShape, sendAt: z.string().datetime({ offset: true }).optional() })
  .strict()
  .superRefine(requireReplyTarget);
const SendDraftSchema = z.object({ draftId, sendAt: z.string().datetime({ offset: true }).optional() }).strict();
const SendRequestSchema = z.union([SendDraftSchema, SendContentSchema]).openapi('SendRequest');
const ForwardRequestSchema = z
  .object({
    from: z.string().email().optional(),
    to: z.array(EmailAddressSchema).min(1),
    cc: z.array(EmailAddressSchema).optional(),
    comment: z
      .string()
      .optional()
      .describe(
        'Comment above the forwarded message. Keep prose paragraphs on one continuous line and separate paragraphs with blank lines.',
      ),
    includeAttachments: z
      .boolean()
      .optional()
      .openapi({ description: 'Include attachments from the original message. Defaults to true.', default: true }),
  })
  .strict()
  .openapi('ForwardRequest');

const modifyActionNames = [
  'markRead',
  'markUnread',
  'star',
  'unstar',
  'archive',
  'trash',
  'untrash',
  'delete',
  'move',
  'addLabels',
  'removeLabels',
] as const;
const ModifyRequestSchema = z
  .object({
    messageIds: z
      .array(messageId)
      .min(1)
      .refine((ids) => new Set(ids).size <= 100, 'At most 100 distinct message IDs are allowed.'),
    action: z.enum(modifyActionNames),
    folder: z
      .string()
      .min(1)
      .optional()
      .describe('Required when action is move. Use archive or trash instead of moving to those folders.'),
    labels: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        'Required when action is addLabels or removeLabels. Change Gmail system labels with dedicated actions.',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'move' && !value.folder) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['folder'], message: 'action=move requires folder' });
    }
    if ((value.action === 'addLabels' || value.action === 'removeLabels') && !value.labels?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['labels'],
        message: `action=${value.action} requires labels`,
      });
    }
  })
  .openapi('ModifyMessagesRequest');

const messageQuerySchema = z
  .object({
    query: z.string().min(1).optional().describe('Typed portable search syntax'),
    folder: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Folder role (inbox, sent, drafts, trash, spam, starred, archive, all) or a label/folder name. Use all or omit this field to search all mail except Spam and Trash. An IMAP server's \\All mailbox may use different rules.",
      ),
    text: z.string().optional().describe('Literal full-text search terms'),
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    read: z.enum(['true', 'false']).optional(),
    starred: z.enum(['true', 'false']).optional(),
    hasAttachment: z.enum(['true', 'false']).optional(),
    after: isoDate.optional(),
    before: isoDate.optional(),
    rawProviderQuery: z.string().optional().describe('Provider-native Gmail syntax or Outlook KQL'),
    pageSize: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .optional(),
    pageToken: z.string().min(1).optional(),
    includeSnippet: z.enum(['true', 'false']).optional(),
    includeSearchContext: z
      .enum(['true', 'false'])
      .optional()
      .describe('Include a match-centered body excerpt. Requires a portable text query.'),
  })
  .strict();

const getMessageQuerySchema = z
  .object({
    includeHeaders: z
      .enum(['true', 'false'])
      .optional()
      .describe('Include Message-ID, References, In-Reply-To, and other threading headers.'),
  })
  .strict();

const portableFolder = z.enum(['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'all']);
const BatchSearchRequestSchema = z
  .object({
    accounts: z
      .array(z.object({ accountId, pageToken: z.string().min(1).optional() }).strict())
      .min(1)
      .max(20),
    query: z.string().min(1),
    folder: portableFolder.optional(),
    text: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    read: z.boolean().optional(),
    starred: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
    after: isoDate.optional(),
    before: isoDate.optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    includeSnippet: z.boolean().optional(),
    includeSearchContext: z
      .boolean()
      .optional()
      .describe('Include a match-centered body excerpt. Requires a portable text query.'),
  })
  .strict()
  .openapi('BatchSearchRequest');

const PROTECTED_MOVE_DESTINATIONS = new Set(['archive', 'trash']);
interface ApiFailure {
  status: number;
  payload: { error: { code: string; message: string; requestId?: string; data?: Record<string, unknown> } };
  retryAfter?: string;
}

class RestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly data?: Record<string, unknown>,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

function logRestFailure(
  deps: RestApiDeps,
  operation: string,
  error: unknown,
  startedAt: number,
  requestId?: string,
): void {
  const context = {
    productSurface: 'rest' as const,
    operation,
    durationMs: performance.now() - startedAt,
    ...(requestId ? { details: { request_id: requestId } } : {}),
  };
  if (error instanceof RestFailure) {
    logCodedFailure(deps.logger, 'rest.operation_failed', error.code, error.message, context);
  } else {
    logFailure(deps.logger, 'rest.operation_failed', error, context);
  }
}

function apiFailure(err: unknown, requestId = randomUUID()): ApiFailure {
  if (err instanceof RestFailure) {
    return {
      status: err.status,
      payload: { error: { code: err.code, message: err.message, requestId, ...(err.data ? { data: err.data } : {}) } },
      ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
    };
  }
  if (isEmailError(err)) {
    const status: Record<string, number> = {
      invalid_request: 400,
      idempotency_conflict: 409,
      permission_denied: 403,
      entitlement_exceeded: 403,
      not_found: 404,
      auth_expired: 409,
      unsupported_capability: 422,
      rate_limited: 429,
      provider_unavailable: 503,
    };
    const safe = publicError(err, requestId);
    const retryAfterMs = safe.data?.retryAfterMs;
    return {
      status: status[err.code] ?? 500,
      payload: { error: safe },
      ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? { retryAfter: String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
        : {}),
    };
  }
  return {
    status: 500,
    payload: { error: publicError(err, requestId) },
  };
}

function normalizeUnhandledError(err: unknown): unknown {
  return err instanceof SyntaxError || (err instanceof HTTPException && err.status === 400)
    ? new ClientInputError('invalid_request', 'Malformed JSON body.')
    : err;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(operation: string, request: unknown): string {
  return createHash('sha256').update(canonicalJson({ operation, request })).digest('hex');
}

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeAttachmentFilename(filename: string): string {
  let safe = '';
  for (const character of filename) {
    const code = character.charCodeAt(0);
    safe += code < 32 || code === 127 || '/\\:*?"<>|'.includes(character) ? '_' : character;
  }
  return safe || 'attachment';
}

interface JsonResult {
  data: unknown;
  meta?: Record<string, unknown>;
  operationFailed?: boolean;
  /** The error behind a partial failure, read only for telemetry failure detail. */
  failureCause?: unknown;
}

async function runJson(
  c: RestContext,
  deps: RestApiDeps,
  options: {
    operation: string;
    capabilities: Capability[];
    quota?: boolean;
    successStatus?: number;
    request?: unknown;
    idempotent?: boolean;
    legacyReplay?: boolean;
    accountId?: string;
    telemetry?: TelemetryProperties;
  },
  fn: () => Promise<JsonResult> | JsonResult,
): Promise<never> {
  const finishActivity = deps.telemetry?.beginActivity?.();
  const startedAt = performance.now();
  const requestId = randomUUID();
  let outcome: OperationOutcome = 'error';
  let errorCode: string | undefined;
  let failureCause: unknown;
  let idempotencyStatus: string | undefined;
  let reservation: { principalId: string; idempotencyKey: string; requestHash: string } | undefined;

  try {
    const auth = c.get('restAuth');
    const missing = options.capabilities.filter((capability) => !allowsCapability(auth, capability));
    if (missing.length) {
      const source = auth.kind === 'api_key' ? { kind: 'api_key' as const, keyId: auth.keyId } : undefined;
      throw new MissingCapabilityError(
        `This API key does not allow: ${missing.join(', ')}. ` +
          enableCapabilitiesInstructions(auth.permissions, missing, source),
        missing,
      );
    }
    const service = c.get('restService');

    if (options.legacyReplay) {
      const key = c.req.header('idempotency-key');
      if (!key || !/^[\x21-\x7e]{1,255}$/.test(key)) {
        throw new RestFailure('invalid_request', 'Idempotency-Key is required.', 400);
      }
      if (options.accountId !== undefined) service.assertAccountAccess(options.accountId);
      const legacy = lookupIdempotencyKey(deps.db, auth.principalId, key);
      if (legacy) {
        if (legacy.requestHash !== requestHash(options.operation, options.request)) {
          throw new RestFailure(
            'idempotency_conflict',
            'This Idempotency-Key was already used for a different request.',
            409,
          );
        }
        if (legacy.state !== 'completed' || legacy.responseStatus === null || legacy.responseBody === null) {
          throw new RestFailure('idempotency_in_progress', 'The earlier delivery outcome is uncertain.', 409);
        }
        return new Response(legacy.responseBody, {
          status: legacy.responseStatus,
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'cache-control': 'no-store',
            'idempotency-replayed': 'true',
            'x-request-id': requestId,
          },
        }) as never;
      }
    }

    if (options.idempotent) {
      const idempotencyKey = c.req.header('idempotency-key');
      if (!idempotencyKey || !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
        throw new RestFailure(
          'invalid_request',
          'Idempotency-Key is required and must contain 1 to 255 printable ASCII characters without spaces.',
          400,
        );
      }
      if (options.accountId !== undefined) service.assertAccountAccess(options.accountId);
      const hash = requestHash(options.operation, options.request);
      const principalId = auth.principalId;
      const result = reserveIdempotencyKey(deps.db, {
        principalId,
        idempotencyKey,
        requestHash: hash,
      });
      idempotencyStatus = result.status;
      if (result.status === 'conflict') {
        throw new RestFailure(
          'idempotency_conflict',
          'This Idempotency-Key was already used for a different request.',
          409,
        );
      }
      if (result.status === 'in_progress') {
        throw new RestFailure(
          'idempotency_in_progress',
          'A request with this Idempotency-Key is still in progress or ended with an uncertain outcome.',
          409,
          undefined,
          '1',
        );
      }
      if (result.status === 'replay') {
        outcome = result.responseStatus < 400 ? 'success' : 'error';
        try {
          const parsed = JSON.parse(result.responseBody) as { error?: { code?: string } };
          errorCode = parsed.error?.code;
        } catch {
          errorCode = result.responseStatus >= 400 ? 'internal' : undefined;
        }
        return new Response(result.responseBody, {
          status: result.responseStatus,
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'cache-control': 'no-store',
            'idempotency-replayed': 'true',
            'x-request-id': requestId,
          },
        }) as never;
      }
      reservation = { principalId, idempotencyKey, requestHash: hash };
    }

    try {
      const warning = options.quota === false ? undefined : service.enforceQuota();
      const result = await fn();
      const payload = {
        data: result.data,
        ...(result.meta ? { meta: result.meta } : {}),
        ...(warning ? { warnings: [warning] } : {}),
      };
      const status = options.successStatus ?? 200;
      const body = JSON.stringify(payload);
      if (reservation) {
        completeIdempotencyKey(deps.db, { ...reservation, responseStatus: status, responseBody: body });
      }
      outcome = result.operationFailed ? 'error' : 'success';
      if (result.operationFailed) {
        errorCode = 'account_failure';
        failureCause = result.failureCause;
      }
      return new Response(body, {
        status,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'cache-control': 'no-store',
          'x-request-id': requestId,
        },
      }) as never;
    } catch (err) {
      logRestFailure(deps, options.operation, err, startedAt, requestId);
      failureCause = err;
      const failure = apiFailure(err, requestId);
      const body = JSON.stringify(failure.payload);
      if (reservation) {
        completeIdempotencyKey(deps.db, {
          ...reservation,
          responseStatus: failure.status,
          responseBody: body,
        });
      }
      errorCode = failure.payload.error.code;
      return new Response(body, {
        status: failure.status,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'cache-control': 'no-store',
          'x-request-id': requestId,
          ...(failure.retryAfter ? { 'retry-after': failure.retryAfter } : {}),
        },
      }) as never;
    }
  } catch (err) {
    logRestFailure(deps, options.operation, err, startedAt, requestId);
    const failure = apiFailure(err, requestId);
    errorCode = failure.payload.error.code;
    failureCause = err;
    return jsonResponse(failure.payload, failure.status, {
      'x-request-id': requestId,
      ...(failure.retryAfter ? { 'retry-after': failure.retryAfter } : {}),
    }) as never;
  } finally {
    captureOperation(deps.telemetry, {
      productSurface: 'rest',
      operation: options.operation,
      outcome,
      durationMs: performance.now() - startedAt,
      errorCode,
      error: failureCause,
      properties: {
        ...(idempotencyStatus ? { idempotency_status: idempotencyStatus } : {}),
        ...options.telemetry,
      },
    });
    finishActivity?.();
  }
}

async function runAttachment(
  c: RestContext,
  deps: RestApiDeps,
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<never> {
  const finishActivity = deps.telemetry?.beginActivity?.();
  const startedAt = performance.now();
  const requestId = randomUUID();
  let outcome: OperationOutcome = 'error';
  let errorCode: string | undefined;
  let failureCause: unknown;
  try {
    const auth = c.get('restAuth');
    if (!allowsCapability(auth, 'mail.read')) {
      throw new EmailError('permission_denied', 'This API key does not allow: mail.read.');
    }
    const service = c.get('restService');
    const warning = service.enforceQuota();
    const { meta, content } = await service
      .getAttachment(accountId, messageId, attachmentId, deps.config.maxAttachmentBytes)
      .catch((error: unknown) => {
        if (!isAttachmentSizeError(error)) throw error;
        const sizeBytes = error.data?.sizeBytes;
        throw attachmentTooLarge(
          'the REST API',
          deps.config.maxAttachmentBytes,
          typeof sizeBytes === 'number' ? sizeBytes : undefined,
        );
      });
    if (content.length > deps.config.maxAttachmentBytes) {
      throw attachmentTooLarge('the REST API', deps.config.maxAttachmentBytes, content.length);
    }
    const safeName = safeAttachmentFilename(meta.filename);
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_');
    const mimeType = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(meta.mimeType)
      ? meta.mimeType
      : 'application/octet-stream';
    outcome = 'success';
    return new Response(new Uint8Array(content), {
      status: 200,
      headers: {
        'content-type': mimeType,
        'content-length': String(content.length),
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeContentDispositionFilename(safeName)}`,
        'cache-control': 'no-store',
        'x-request-id': requestId,
        ...(warning ? { 'fluxmail-warning': warning.replace(/[\r\n]/g, ' ') } : {}),
      },
    }) as never;
  } catch (err) {
    logRestFailure(deps, 'downloadAttachment', err, startedAt, requestId);
    const failure = apiFailure(err, requestId);
    errorCode = failure.payload.error.code;
    failureCause = err;
    return jsonResponse(failure.payload, failure.status, { 'x-request-id': requestId }) as never;
  } finally {
    captureOperation(deps.telemetry, {
      productSurface: 'rest',
      operation: 'downloadAttachment',
      outcome,
      durationMs: performance.now() - startedAt,
      errorCode,
      error: failureCause,
    });
    finishActivity?.();
  }
}

function toSendInput(input: z.infer<typeof DraftRequestSchema>): SendInput {
  return {
    body: input.body,
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.cc ? { cc: input.cc } : {}),
    ...(input.bcc ? { bcc: input.bcc } : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    ...(input.replyAll !== undefined ? { replyAll: input.replyAll } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  };
}

function toEmailQuery(input: z.infer<typeof messageQuerySchema>): {
  query: EmailQuery;
  page: PageOpts;
  diagnostics: SearchDiagnostic[];
} {
  const structured: EmailQuery = {};
  for (const key of ['folder', 'text', 'from', 'to', 'subject', 'after', 'before', 'rawProviderQuery'] as const) {
    if (input[key] !== undefined) structured[key] = input[key];
  }
  for (const key of ['read', 'starred', 'hasAttachment'] as const) {
    if (input[key] !== undefined) structured[key] = input[key] === 'true';
  }
  let query = structured;
  let diagnostics: SearchDiagnostic[] = [];
  if (input.query !== undefined) {
    const parsed = parseEmailSearch(input.query);
    diagnostics = parsed.diagnostics;
    if (!parsed.valid) {
      throw new ClientInputError('invalid_request', parsed.diagnostics.map((item) => item.message).join(' '), {
        diagnostics: parsed.diagnostics,
      });
    }
    const merged = mergeEmailQueries(parsed.query, structured);
    if (!merged.success) {
      throw new ClientInputError('invalid_request', merged.diagnostics.map((item) => item.message).join(' '), {
        diagnostics: merged.diagnostics,
      });
    }
    query = merged.query;
  }
  return {
    query,
    diagnostics,
    page: {
      ...(input.pageSize ? { pageSize: Number(input.pageSize) } : {}),
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      ...(input.includeSnippet !== undefined ? { includeSnippet: input.includeSnippet === 'true' } : {}),
      ...(input.includeSearchContext !== undefined
        ? { includeSearchContext: input.includeSearchContext === 'true' }
        : {}),
    },
  };
}

const FIXED_ADMIN_AUDIT_PATHS = new Set([
  '/api/v1/admin/connections',
  '/api/v1/admin/imap/tests',
  '/api/v1/admin/api-keys',
  '/api/v1/admin/license/activate',
]);

function adminAuditPath(path: string): string {
  if (FIXED_ADMIN_AUDIT_PATHS.has(path)) return path;
  if (/^\/api\/v1\/admin\/api-keys\/[^/]+$/.test(path)) return '/api/v1/admin/api-keys/:id';
  if (/^\/api\/v1\/admin\/accounts\/[^/]+\/imap\/folders$/.test(path)) {
    return '/api/v1/admin/accounts/:id/imap/folders';
  }
  if (/^\/api\/v1\/admin\/oauth-apps\/(google|outlook)$/.test(path)) {
    return '/api/v1/admin/oauth-apps/:provider';
  }
  return '/api/v1/admin/*';
}

function modifyAction(input: z.infer<typeof ModifyRequestSchema>): ModifyAction {
  if (input.action === 'move') {
    const folder = input.folder!;
    if (PROTECTED_MOVE_DESTINATIONS.has(folder.trim().toLowerCase())) {
      throw new ClientInputError(
        'invalid_request',
        'Archive or trash these messages instead of moving them to this folder.',
      );
    }
    return { move: folder };
  }
  if (input.action === 'addLabels' || input.action === 'removeLabels') {
    const labels = input.labels!;
    return input.action === 'addLabels' ? { addLabels: labels } : { removeLabels: labels };
  }
  return input.action;
}

export function createRestApi(deps: RestApiDeps): OpenAPIHono<RestEnv> {
  const app = new OpenAPIHono<RestEnv>({
    defaultHook(result, c) {
      if (result.success) return;
      logCodedFailure(deps.logger, 'rest.operation_failed', 'invalid_request', 'Request validation failed', {
        productSurface: 'rest',
        operation:
          identityOperationId(c.req.method, c.req.path) ??
          adminOperationId(c.req.method, c.req.path) ??
          'request_validation',
      });
      return jsonResponse(
        {
          error: {
            code: 'invalid_request',
            message: 'Request validation failed.',
            data: {
              issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
            },
          },
        },
        400,
      );
    },
  });

  app.use('/api/v1/*', async (c, next) => {
    const telemetryOperation = identityOperationId(c.req.method, c.req.path);
    if (!telemetryOperation) return next();
    const finishActivity = deps.telemetry?.beginActivity?.();
    const startedAt = performance.now();
    let errorCode: string | undefined;
    let threw = false;
    let thrownError: unknown;
    try {
      await next();
      if (c.res.status >= 400) {
        try {
          const payload = (await c.res.clone().json()) as { error?: { code?: unknown } };
          if (typeof payload.error?.code === 'string') errorCode = payload.error.code;
        } catch {
          errorCode = 'internal';
        }
      }
    } catch (error) {
      threw = true;
      thrownError = normalizeUnhandledError(error);
      errorCode = isEmailError(thrownError) ? thrownError.code : 'internal';
      throw error;
    } finally {
      const httpStatus = threw && c.res.status < 400 ? apiFailure(thrownError).status : c.res.status;
      const safeOperationProperties = operationProperties(c) ?? {};
      captureOperation(deps.telemetry, {
        productSurface: 'rest',
        operation: telemetryOperation,
        outcome: httpStatus < 400 && !errorCode ? 'success' : 'error',
        durationMs: performance.now() - startedAt,
        errorCode,
        properties: {
          ...safeOperationProperties,
          ...(telemetryOperation === 'connectOwnAccount' && !safeOperationProperties.connection_stage
            ? { connection_stage: 'server_validation' }
            : {}),
          ...(telemetryOperation === 'connectOwnAccount' ? { http_status: httpStatus } : {}),
          ...(telemetryOperation === 'connectOwnAccount' && (httpStatus >= 400 || errorCode)
            ? { failure_kind: connectionFailureKind(errorCode ?? 'internal', httpStatus) }
            : {}),
        },
      });
      finishActivity?.();
    }
  });

  app.use('/api/v1/admin/*', async (c, next) => {
    const telemetryOperation = adminOperationId(c.req.method, c.req.path);
    const identityOperation = identityOperationId(c.req.method, c.req.path);
    const finishActivity = telemetryOperation ? deps.telemetry?.beginActivity?.() : undefined;
    const startedAt = performance.now();
    await next();
    let errorCode: string | undefined;
    if (c.res.status >= 400) {
      try {
        const payload = (await c.res.clone().json()) as { error?: { code?: unknown } };
        if (typeof payload.error?.code === 'string') errorCode = payload.error.code;
      } catch {
        errorCode = 'internal';
      }
    }
    if (telemetryOperation) {
      captureOperation(deps.telemetry, {
        productSurface: 'rest',
        operation: telemetryOperation,
        outcome: c.res.status < 400 ? 'success' : 'error',
        durationMs: performance.now() - startedAt,
        errorCode,
        properties: operationProperties(c),
      });
      finishActivity?.();
    }
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method) || (identityOperation && c.res.status < 400)) return;
    const auth = c.get('restAuth');
    if (!auth) return;
    const resource = c.req.path.match(/\/(api-keys|accounts)\/((?:key|acct)_[^/]+)/);
    const operation = `${c.req.method.toLowerCase()} ${adminAuditPath(c.req.path)}`;
    try {
      recordAdminAuditEvent(deps.db, {
        operation,
        outcome: c.res.status < 400 ? 'success' : 'error',
        actorKeyId: auth.kind === 'api_key' ? auth.keyId : undefined,
        actorSessionId: auth.kind === 'session' ? auth.sessionId : undefined,
        actorMemberId: auth.memberId,
        ...(resource
          ? { resourceType: resource[1] === 'api-keys' ? 'api_key' : 'account', resourceId: resource[2] }
          : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Auditing must not replace the API response.
    }
  });

  app.use('/api/v1/accounts/:accountId/send-as', async (c, next) => {
    await next();
    if (c.req.method !== 'PUT') return;
    const auth = c.get('restAuth');
    if (!auth) return;
    let errorCode: string | undefined;
    if (c.res.status >= 400) {
      try {
        const payload = (await c.res.clone().json()) as { error?: { code?: unknown } };
        if (typeof payload.error?.code === 'string') errorCode = payload.error.code;
      } catch {
        errorCode = 'internal';
      }
    }
    try {
      recordAdminAuditEvent(deps.db, {
        operation: 'put /api/v1/accounts/:id/send-as',
        outcome: c.res.status < 400 ? 'success' : 'error',
        actorKeyId: auth.kind === 'api_key' ? auth.keyId : undefined,
        actorSessionId: auth.kind === 'session' ? auth.sessionId : undefined,
        actorMemberId: auth.memberId,
        resourceType: 'account',
        resourceId: c.req.param('accountId'),
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Auditing must not replace the API response.
    }
  });

  app.use('/api/v1/*', async (c, next) => {
    c.set('restLogger', deps.logger);
    if (
      c.req.path.startsWith('/api/v1/auth/') ||
      c.req.path === '/api/v1/me' ||
      c.req.path.startsWith('/api/v1/me/') ||
      c.req.path === '/api/v1/accounts/connections'
    ) {
      c.header('cache-control', 'no-store');
      c.header('x-content-type-options', 'nosniff');
      c.header('referrer-policy', 'no-referrer');
    }
    const publicPaths = new Set([
      '/api/v1',
      '/api/v1/openapi.json',
      '/api/v1/auth/login',
      '/api/v1/auth/enroll',
      '/api/v1/auth/password-reset',
    ]);
    const publicAuthRequest =
      c.req.method === 'POST' &&
      (c.req.path === '/api/v1/auth/login' ||
        c.req.path === '/api/v1/auth/enroll' ||
        c.req.path === '/api/v1/auth/password-reset');
    if (publicAuthRequest && (await requestBodyExceedsLimit(c.req.raw))) {
      logCodedFailure(
        deps.logger,
        'rest.request_rejected',
        'request_too_large',
        'Authentication request body exceeded the size limit',
        { productSurface: 'rest', operation: identityOperationId(c.req.method, c.req.path) ?? 'request' },
      );
      return jsonResponse(
        { error: { code: 'request_too_large', message: 'Authentication request bodies are limited to 64 KiB.' } },
        413,
      );
    }
    if (publicPaths.has(c.req.path)) return next();
    const administrative =
      c.req.path.startsWith('/api/v1/admin/') ||
      (c.req.method === 'PUT' && /^\/api\/v1\/accounts\/[^/]+\/send-as$/.test(c.req.path));
    if (administrative) {
      c.header('cache-control', 'no-store');
      c.header('x-content-type-options', 'nosniff');
      c.header('referrer-policy', 'no-referrer');
      if (
        !administrationUsesHttps(
          c.req.raw,
          {
            remoteAddress: c.env?.incoming?.socket.remoteAddress,
            encrypted: Boolean((c.env?.incoming?.socket as { encrypted?: boolean } | undefined)?.encrypted),
          },
          deps.config.trustProxy,
        )
      ) {
        logCodedFailure(
          deps.logger,
          'rest.request_rejected',
          'https_required',
          'Administrative request did not use HTTPS',
          { productSurface: 'rest', operation: adminOperationId(c.req.method, c.req.path) ?? 'admin_request' },
        );
        return jsonResponse(
          { error: { code: 'https_required', message: 'Administrative routes require HTTPS outside loopback.' } },
          400,
        );
      }
    }
    if (!isBootstrapComplete(deps.db)) {
      logCodedFailure(deps.logger, 'rest.request_rejected', 'setup_required', 'Fluxmail setup is incomplete', {
        productSurface: 'rest',
        operation:
          identityOperationId(c.req.method, c.req.path) ?? adminOperationId(c.req.method, c.req.path) ?? 'request',
      });
      return jsonResponse(
        { error: { code: 'setup_required', message: 'Run "fluxmail setup" on the server before using Fluxmail.' } },
        503,
      );
    }
    const authorization = c.req.header('authorization');
    const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    // OAuth access tokens are issued for the MCP endpoint only.
    const principal = bearer ? authenticateBearer(deps.db, bearer) : null;
    const auth = principal?.kind === 'oauth' ? null : principal;
    if (!auth) {
      logCodedFailure(deps.logger, 'rest.request_rejected', 'unauthorized', 'REST request was not authorized', {
        productSurface: 'rest',
        operation:
          identityOperationId(c.req.method, c.req.path) ?? adminOperationId(c.req.method, c.req.path) ?? 'request',
      });
      return jsonResponse(
        { error: { code: 'unauthorized', message: 'Pass a member session or API key as a Bearer token.' } },
        401,
        { 'www-authenticate': 'Bearer' },
      );
    }
    c.set('restAuth', auth);
    if (!administrative && ['POST', 'PATCH', 'PUT'].includes(c.req.method)) {
      const limit = Math.ceil((deps.config.maxAttachmentBytes * 4) / 3) + 2 * 1024 * 1024;
      if (await requestBodyExceedsLimit(c.req.raw, limit)) {
        return jsonResponse(
          { error: { code: 'request_too_large', message: 'Mail request body exceeds the size limit.' } },
          413,
        );
      }
    }
    if (administrative && (c.req.method === 'POST' || c.req.method === 'PATCH' || c.req.method === 'PUT')) {
      const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        logCodedFailure(
          deps.logger,
          'rest.request_rejected',
          'unsupported_media_type',
          'Administrative request did not use application/json',
          { productSurface: 'rest', operation: adminOperationId(c.req.method, c.req.path) ?? 'admin_request' },
        );
        return jsonResponse(
          { error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' } },
          415,
        );
      }
      if (await requestBodyExceedsLimit(c.req.raw)) {
        logCodedFailure(
          deps.logger,
          'rest.request_rejected',
          'request_too_large',
          'Administrative request body exceeded the size limit',
          { productSurface: 'rest', operation: adminOperationId(c.req.method, c.req.path) ?? 'admin_request' },
        );
        return jsonResponse(
          { error: { code: 'request_too_large', message: 'Administrative request bodies are limited to 64 KiB.' } },
          413,
        );
      }
    }
    c.set('restService', deps.service.withPrincipal(auth));
    return next();
  });

  registerIdentityRoutes(app, deps);
  registerAdminRoutes(app, deps);

  const discoveryRoute = createRoute({
    method: 'get',
    path: '/api/v1',
    operationId: 'getApiInfo',
    summary: 'Get API information',
    description: 'Return the Fluxmail version and the URL of the OpenAPI document.',
    responses: {
      200: {
        content: {
          'application/json': {
            schema: dataEnvelope(
              z.object({ name: z.literal('fluxmail'), version: z.string(), openapi: z.string() }).strict(),
            ),
          },
        },
        description: 'REST API discovery',
      },
    },
  });
  app.openapi(discoveryRoute, (c) => {
    const startedAt = performance.now();
    const response = c.json(
      { data: { name: 'fluxmail' as const, version: VERSION, openapi: '/api/v1/openapi.json' } },
      200,
    );
    captureOperation(deps.telemetry, {
      productSurface: 'rest',
      operation: 'getApiInfo',
      outcome: 'success',
      durationMs: performance.now() - startedAt,
    });
    return response;
  });

  const statusRoute = createRoute({
    method: 'get',
    path: '/api/v1/status',
    operationId: 'getStatus',
    summary: 'Get server status',
    description: 'Return provider and mailbox status for the accounts available to the API key.',
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(z.record(z.unknown())) } }, description: 'Status' },
      ...errorResponses,
    },
  });
  app.openapi(statusRoute, (c) =>
    runJson(c, deps, { operation: 'getStatus', capabilities: ['mail.read'], quota: false }, async () => ({
      data: await c.get('restService').status(),
    })),
  );

  const accountsRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts',
    operationId: 'listAccounts',
    summary: 'List accounts',
    description: 'List the email accounts available to the API key.',
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(z.array(AccountSchema)) } },
        description: 'Accounts',
      },
      ...errorResponses,
    },
  });
  app.openapi(accountsRoute, (c) =>
    runJson(c, deps, { operation: 'listAccounts', capabilities: ['mail.read'] }, () => ({
      data: c.get('restService').listAccounts(),
    })),
  );

  const foldersRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/folders',
    operationId: 'listFolders',
    summary: 'List folders',
    description: 'List folders in an email account.',
    request: { params: accountParams },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(z.array(FolderSchema)) } }, description: 'Folders' },
      ...errorResponses,
    },
  });
  app.openapi(foldersRoute, (c) => {
    const { accountId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'listFolders', capabilities: ['mail.read'] }, async () => ({
      data: await c.get('restService').listFolders(accountId),
    }));
  });

  const labelsRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/labels',
    operationId: 'listLabels',
    summary: 'List labels',
    description: 'List Gmail user labels or Outlook categories in an email account.',
    request: { params: accountParams },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(z.array(LabelSchema)) } }, description: 'Labels' },
      ...errorResponses,
    },
  });
  app.openapi(labelsRoute, (c) => {
    const { accountId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'listLabels', capabilities: ['mail.read'] }, async () => ({
      data: await c.get('restService').listLabels(accountId),
    }));
  });

  const listSendAsRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/send-as',
    operationId: 'listSendAs',
    summary: 'List sender addresses',
    description: 'List sender addresses available for an email account.',
    request: { params: accountParams },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(z.array(SendAsIdentitySchema)) } },
        description: 'Sender addresses',
      },
      ...errorResponses,
    },
  });
  app.openapi(listSendAsRoute, (c) => {
    const { accountId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'listSendAs', capabilities: ['mail.read'] }, async () => ({
      data: await c.get('restService').listSendAs(accountId),
    }));
  });

  const replaceSendAsRoute = createRoute({
    method: 'put',
    path: '/api/v1/accounts/{accountId}/send-as',
    operationId: 'replaceSendAs',
    summary: 'Replace configured sender addresses',
    description: 'Replace the configured Outlook or IMAP aliases for an email account.',
    request: {
      params: accountParams,
      body: { required: true, content: { 'application/json': { schema: ReplaceSendAsRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(z.array(SendAsIdentitySchema)) } },
        description: 'Sender addresses replaced',
      },
      ...errorResponses,
    },
  });
  app.openapi(replaceSendAsRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const { identities } = c.req.valid('json');
    return runJson(
      c,
      deps,
      { operation: 'replaceSendAs', capabilities: ['admin.accounts'], quota: false },
      async () => ({
        data: await c.get('restService').replaceSendAs(accountId, identities),
      }),
    );
  });

  const listMessagesRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/messages',
    operationId: 'listMessages',
    summary: 'List messages',
    description: 'List and filter messages in an email account.',
    request: { params: accountParams, query: messageQuerySchema },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: pagedEnvelope(MessageSchema) } }, description: 'Messages' },
      ...errorResponses,
    },
  });
  app.openapi(listMessagesRoute, (c) => {
    const { accountId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'listMessages', capabilities: ['mail.read'] }, async () => {
      const { query, page, diagnostics } = toEmailQuery(c.req.valid('query'));
      const result = await c.get('restService').listMessages(accountId, query, page);
      return {
        data: result.items,
        meta: {
          ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
          exhausted: result.exhausted,
          ...([...diagnostics, ...(result.diagnostics ?? [])].length
            ? { diagnostics: [...diagnostics, ...(result.diagnostics ?? [])] }
            : {}),
          ...(result.incomplete ? { incomplete: true as const } : {}),
          ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {}),
          ...(result.inspectedCandidates !== undefined ? { inspectedCandidates: result.inspectedCandidates } : {}),
        },
      };
    });
  });

  const batchSearchRoute = createRoute({
    method: 'post',
    path: '/api/v1/messages/search',
    operationId: 'searchMessages',
    summary: 'Search multiple accounts',
    description: 'Search up to 20 email accounts with one portable query.',
    request: {
      body: { content: { 'application/json': { schema: BatchSearchRequestSchema } }, required: true },
    },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: BatchSearchResponseSchema } },
        description: 'Grouped search results',
      },
      ...errorResponses,
    },
  });
  app.openapi(batchSearchRoute, (c) =>
    runJson(c, deps, { operation: 'searchMessages', capabilities: ['mail.read'] }, async () => {
      const input = c.req.valid('json');
      const parsed = parseEmailSearch(input.query);
      if (!parsed.valid) {
        throw new ClientInputError('invalid_request', parsed.diagnostics.map((item) => item.message).join(' '), {
          diagnostics: parsed.diagnostics,
        });
      }
      const structured: EmailQuery = {};
      for (const key of ['folder', 'text', 'from', 'to', 'subject', 'after', 'before'] as const) {
        if (input[key] !== undefined) structured[key] = input[key];
      }
      for (const key of ['read', 'starred', 'hasAttachment'] as const) {
        if (input[key] !== undefined) structured[key] = input[key];
      }
      const merged = mergeEmailQueries(parsed.query, structured);
      if (!merged.success) {
        throw new ClientInputError('invalid_request', merged.diagnostics.map((item) => item.message).join(' '), {
          diagnostics: merged.diagnostics,
        });
      }
      const result = await c.get('restService').searchMessagesBatch({
        accounts: input.accounts,
        query: merged.query as PortableEmailQuery,
        ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
        ...(input.includeSnippet !== undefined ? { includeSnippet: input.includeSnippet } : {}),
        ...(input.includeSearchContext !== undefined ? { includeSearchContext: input.includeSearchContext } : {}),
      });
      return {
        data: result.groups.map((group) => {
          if (!group.page) return { accountId: group.accountId, error: group.error };
          const diagnostics = [...parsed.diagnostics, ...(group.page.diagnostics ?? [])];
          return {
            accountId: group.accountId,
            data: group.page.items,
            meta: {
              exhausted: group.page.exhausted,
              ...(group.page.nextPageToken ? { nextPageToken: group.page.nextPageToken } : {}),
              ...(diagnostics.length ? { diagnostics } : {}),
              ...(group.page.incomplete ? { incomplete: true as const } : {}),
              ...(group.page.incompleteReason ? { incompleteReason: group.page.incompleteReason } : {}),
              ...(group.page.inspectedCandidates !== undefined
                ? { inspectedCandidates: group.page.inspectedCandidates }
                : {}),
            },
          };
        }),
        meta: { exhausted: result.exhausted },
        operationFailed: result.groups.some((group) => group.error !== undefined),
        failureCause: batchFailureCause(result.groups),
      };
    }),
  );

  const getMessageRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/messages/{messageId}',
    operationId: 'getMessage',
    summary: 'Get a message',
    description: 'Get one message by its provider ID.',
    request: { params: messageParams, query: getMessageQuerySchema },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(MessageSchema) } }, description: 'Message' },
      ...errorResponses,
    },
  });
  app.openapi(getMessageRoute, (c) => {
    const { accountId, messageId } = c.req.valid('param');
    const { includeHeaders } = c.req.valid('query');
    return runJson(c, deps, { operation: 'getMessage', capabilities: ['mail.read'] }, async () => ({
      data: await c
        .get('restService')
        .getMessage(
          accountId,
          messageId,
          includeHeaders !== undefined ? { includeHeaders: includeHeaders === 'true' } : undefined,
        ),
    }));
  });

  const getThreadRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/threads/{threadId}',
    operationId: 'getThread',
    summary: 'Get a thread',
    description: 'Get a complete email thread by its provider ID.',
    request: { params: threadParams },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(ThreadSchema) } }, description: 'Thread' },
      ...errorResponses,
    },
  });
  app.openapi(getThreadRoute, (c) => {
    const { accountId, threadId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'getThread', capabilities: ['mail.read'] }, async () => ({
      data: await c.get('restService').getThread(accountId, threadId),
    }));
  });

  const getDraftRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/drafts/{draftId}',
    operationId: 'getDraft',
    summary: 'Get a draft',
    description: 'Read an existing draft by its provider ID. Requires mail.drafts.',
    request: { params: draftParams },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(MessageSchema) } }, description: 'Draft' },
      ...errorResponses,
    },
  });
  app.openapi(getDraftRoute, (c) => {
    const { accountId, draftId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'getDraft', capabilities: ['mail.drafts'] }, async () => ({
      data: await c.get('restService').getDraft(accountId, draftId),
    }));
  });

  const createDraftRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/drafts',
    operationId: 'createDraft',
    summary: 'Create a draft',
    description: 'Create a new draft or a reply draft in an email account.',
    request: {
      params: accountParams,
      body: { required: true, content: { 'application/json': { schema: DraftRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      201: { content: { 'application/json': { schema: dataEnvelope(MessageSchema) } }, description: 'Draft created' },
      ...errorResponses,
    },
  });
  app.openapi(createDraftRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capabilities: McpCapability[] = ['mail.drafts', ...(input.replyToMessageId ? ['mail.read' as const] : [])];
    return runJson(c, deps, { operation: 'createDraft', capabilities, successStatus: 201 }, async () => ({
      data: await c.get('restService').createDraft(accountId, toSendInput(input)),
    }));
  });

  const updateDraftRoute = createRoute({
    method: 'put',
    path: '/api/v1/accounts/{accountId}/drafts/{draftId}',
    operationId: 'updateDraft',
    summary: 'Replace a draft',
    description: 'Replace the full content of an existing draft.',
    request: {
      params: draftParams,
      body: { required: true, content: { 'application/json': { schema: DraftRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: dataEnvelope(MessageSchema) } }, description: 'Draft replaced' },
      ...errorResponses,
    },
  });
  app.openapi(updateDraftRoute, (c) => {
    const { accountId, draftId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capabilities: McpCapability[] = ['mail.drafts', ...(input.replyToMessageId ? ['mail.read' as const] : [])];
    return runJson(c, deps, { operation: 'updateDraft', capabilities }, async () => ({
      data: await c.get('restService').updateDraft(accountId, draftId, toSendInput(input)),
    }));
  });

  const deleteDraftRoute = createRoute({
    method: 'delete',
    path: '/api/v1/accounts/{accountId}/drafts/{draftId}',
    operationId: 'deleteDraft',
    summary: 'Delete a draft',
    description: 'Delete an existing draft from an email account.',
    request: { params: draftParams },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(z.object({ deleted: z.string() }).strict()) } },
        description: 'Draft deleted',
      },
      ...errorResponses,
    },
  });
  app.openapi(deleteDraftRoute, (c) => {
    const { accountId, draftId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'deleteDraft', capabilities: ['mail.drafts'] }, async () => {
      await c.get('restService').deleteDraft(accountId, draftId);
      return { data: { deleted: draftId } };
    });
  });

  const previewSendRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/send/preview',
    operationId: 'previewSend',
    summary: 'Preview a send',
    description:
      'Resolve the sender, recipients and attachments without sending mail. Requires mail.send, plus mail.drafts for an existing draft or mail.read for a reply.',
    request: {
      params: accountParams,
      body: { required: true, content: { 'application/json': { schema: SendRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(SendPreviewSchema) } },
        description: 'Resolved send details',
      },
      ...errorResponses,
    },
  });
  app.openapi(previewSendRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capabilities: McpCapability[] = ['mail.send'];
    if ('draftId' in input) capabilities.push('mail.drafts');
    if ('replyToMessageId' in input && input.replyToMessageId) capabilities.push('mail.read');
    const request: SendInput | { draftId: string } =
      'draftId' in input ? { draftId: input.draftId } : toSendInput(input);
    return runJson(c, deps, { operation: 'previewSend', capabilities }, async () => ({
      data: await c.get('restService').previewSend(accountId, request),
    }));
  });

  const sendRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/send',
    operationId: 'sendMessage',
    summary: 'Send or schedule a message',
    description: 'Send a message now or schedule it for a specified time.',
    request: {
      params: accountParams,
      headers: idempotencyHeaders,
      body: { required: true, content: { 'application/json': { schema: SendRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(DeliveryOperationSchema) } },
        description: 'Delivery operation',
      },
      202: {
        content: { 'application/json': { schema: dataEnvelope(DeliveryOperationSchema) } },
        description: 'Message scheduled',
      },
      ...errorResponses,
    },
  });
  app.openapi(sendRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capabilities: McpCapability[] = [
      'mail.send',
      ...('replyToMessageId' in input && input.replyToMessageId ? ['mail.read' as const] : []),
    ];
    const sendAt = input.sendAt;
    const request: SendInput | { draftId: string } =
      'draftId' in input ? { draftId: input.draftId } : toSendInput(input);
    return runJson(
      c,
      deps,
      {
        operation: 'sendMessage',
        capabilities,
        successStatus: sendAt ? 202 : 200,
        request: { accountId, input },
        legacyReplay: true,
        accountId,
        telemetry: {
          mode: 'draftId' in input ? 'draft' : input.replyToMessageId ? 'reply' : 'direct',
          scheduled: sendAt !== undefined,
          reply_all: 'replyAll' in input && input.replyAll === true,
        },
      },
      async () => {
        const service = c.get('restService');
        const key = c.req.header('idempotency-key')!;
        if (sendAt) {
          const operation = await service.scheduleDelivery(accountId, request, sendAt, key);
          return {
            data: operation,
            operationFailed: operation.status === 'failed' || operation.status === 'uncertain',
          };
        }
        const operation = await service.deliver(accountId, request, key);
        return { data: operation, operationFailed: operation.status === 'failed' || operation.status === 'uncertain' };
      },
    );
  });

  const deliveryStatusRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/delivery-operations/{operationId}',
    operationId: 'getDeliveryOperation',
    summary: 'Get a delivery outcome',
    description: 'Check whether a send or forward succeeded, failed or has an uncertain outcome. Requires mail.send.',
    request: { params: z.object({ accountId, operationId: id }).strict() },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(DeliveryOperationSchema) } },
        description: 'Delivery outcome',
      },
      ...errorResponses,
    },
  });
  app.openapi(deliveryStatusRoute, (c) => {
    const { accountId, operationId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'getDeliveryOperation', capabilities: ['mail.send'], quota: false }, () => ({
      data: c.get('restService').getDelivery(accountId, operationId),
    }));
  });

  const listScheduledRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/scheduled-sends',
    operationId: 'listScheduledSends',
    summary: 'List scheduled sends',
    description: 'List scheduled messages in an email account.',
    request: { params: accountParams },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(z.array(ScheduledSendSchema)) } },
        description: 'Scheduled sends',
      },
      ...errorResponses,
    },
  });
  app.openapi(listScheduledRoute, (c) => {
    const { accountId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'listScheduledSends', capabilities: ['mail.read'] }, () => ({
      data: c.get('restService').listScheduled(accountId),
    }));
  });

  const cancelScheduledRoute = createRoute({
    method: 'delete',
    path: '/api/v1/accounts/{accountId}/scheduled-sends/{scheduleId}',
    operationId: 'cancelScheduledSend',
    summary: 'Cancel a scheduled send',
    description: 'Cancel a pending scheduled send and keep its provider draft.',
    request: { params: scheduleParams },
    ...protectedRoute,
    responses: {
      200: {
        content: {
          'application/json': {
            schema: dataEnvelope(
              z.object({ scheduleId: z.string(), draftId: z.string(), draftKept: z.literal(true) }).strict(),
            ),
          },
        },
        description: 'Scheduled send canceled',
      },
      ...errorResponses,
    },
  });
  app.openapi(cancelScheduledRoute, (c) => {
    const { accountId, scheduleId } = c.req.valid('param');
    return runJson(c, deps, { operation: 'cancelScheduledSend', capabilities: ['mail.drafts'] }, () => {
      const exists = c
        .get('restService')
        .listScheduled(accountId)
        .some((schedule) => schedule.scheduleId === scheduleId);
      if (!exists) throw new EmailError('not_found', `No scheduled send with id ${scheduleId}`);
      return { data: c.get('restService').cancelScheduled(scheduleId) };
    });
  });

  const forwardRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/messages/{messageId}/forward',
    operationId: 'forwardMessage',
    summary: 'Forward a message',
    description: 'Forward a message to one or more recipients.',
    request: {
      params: messageParams,
      headers: idempotencyHeaders,
      body: { required: true, content: { 'application/json': { schema: ForwardRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: dataEnvelope(DeliveryOperationSchema) } },
        description: 'Forward delivery operation',
      },
      ...errorResponses,
    },
  });
  app.openapi(forwardRoute, (c) => {
    const { accountId, messageId } = c.req.valid('param');
    const input = c.req.valid('json');
    return runJson(
      c,
      deps,
      {
        operation: 'forwardMessage',
        capabilities: ['mail.send', 'mail.read'],
        request: { accountId, messageId, input },
        legacyReplay: true,
        accountId,
        telemetry: { include_attachments: input.includeAttachments !== false },
      },
      async () => {
        const operation = await c
          .get('restService')
          .deliverForward(accountId, { messageId, ...input }, c.req.header('idempotency-key')!);
        return { data: operation, operationFailed: operation.status === 'failed' || operation.status === 'uncertain' };
      },
    );
  });

  const modifyRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/{accountId}/messages/actions',
    operationId: 'modifyMessages',
    summary: 'Modify messages',
    description: 'Apply one mailbox action to a batch of messages.',
    request: {
      params: accountParams,
      body: { required: true, content: { 'application/json': { schema: ModifyRequestSchema } } },
    },
    ...protectedRoute,
    responses: {
      200: {
        content: {
          'application/json': {
            schema: dataEnvelope(ModifyResultSchema),
          },
        },
        description: 'Messages modified',
      },
      ...errorResponses,
    },
  });
  app.openapi(modifyRoute, (c) => {
    const { accountId } = c.req.valid('param');
    const input = c.req.valid('json');
    const capability = MODIFY_ACTION_SCOPES[input.action];
    return runJson(
      c,
      deps,
      {
        operation: 'modifyMessages',
        capabilities: [capability],
        telemetry: { action: input.action },
      },
      async () => {
        const result = await c.get('restService').modify(accountId, input.messageIds, modifyAction(input));
        return {
          data: { ...result, action: input.action },
          operationFailed: result.failed.length > 0 || result.uncertainIds.length > 0,
        };
      },
    );
  });

  const attachmentRoute = createRoute({
    method: 'get',
    path: '/api/v1/accounts/{accountId}/messages/{messageId}/attachments/{attachmentId}',
    operationId: 'downloadAttachment',
    summary: 'Download an attachment',
    description: 'Download one attachment as raw bytes.',
    request: { params: attachmentParams },
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
        description: 'Attachment bytes',
      },
      ...errorResponses,
    },
  });
  app.openapi(attachmentRoute, (c) => {
    const { accountId, messageId, attachmentId } = c.req.valid('param');
    return runAttachment(c, deps, accountId, messageId, attachmentId);
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'Fluxmail member session or API key',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'memberSessionAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'Fluxmail member session',
  });
  app.doc31('/api/v1/openapi.json', REST_OPENAPI_DOCUMENT);

  app.all('/api/v1/*', () =>
    jsonResponse({ error: { code: 'not_found', message: 'No REST route matches this request.' } }, 404),
  );
  app.onError((err) => {
    const requestId = randomUUID();
    const malformedJson = normalizeUnhandledError(err);
    logFailure(deps.logger, 'rest.unhandled_error', malformedJson, {
      productSurface: 'rest',
      details: { request_id: requestId },
    });
    const failure = apiFailure(malformedJson, requestId);
    return jsonResponse(failure.payload, failure.status, { 'x-request-id': requestId });
  });

  return app;
}
