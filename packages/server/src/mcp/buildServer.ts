import { VERSION } from '../version.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  McpServer,
  ResourceTemplate,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import type {
  Transport,
  CallToolResult,
  Tool,
  ServerContext,
  StandardSchemaWithJSON,
  ToolCallback,
  CallToolRequest,
} from '@modelcontextprotocol/server';
import {
  isEmailError,
  mergeEmailQueries,
  parseEmailSearch,
  parseSingleAddress,
  type EmailAddress,
  type EmailQuery,
  type Message,
  type ModifyAction,
  type PageOpts,
  type PortableEmailQuery,
  type SendAsIdentity,
} from '@fluxmail/core';
import { batchFailureCause, type EmailService, type SendInput } from '../service/emailService.js';
import type { DeliveryOperation } from '../service/deliveryCoordinator.js';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from '../config.js';
import {
  DEFAULT_PERMISSION_POLICY,
  MCP_CAPABILITIES,
  MCP_CAPABILITY_DESCRIPTIONS,
  enableCapabilitiesInstructions,
  hasCapability,
  normalizePermissionPolicy,
  type McpCapability,
  type PermissionPolicy,
  type PermissionSource,
} from '../permissions.js';
import { captureOperation, type Telemetry, type TelemetryProperties } from '../telemetry.js';
import { logFailure, type Logger } from '../logging.js';
import { ClientInputError, MissingCapabilityError, publicError } from '../service/publicErrors.js';
import { outputSchemas } from './outputSchemas.js';
import { mcpClientProperties, trackMcpInitialization, type McpClientProperties } from './clientTelemetry.js';
import {
  attachmentContents,
  inlineContent,
  mediaType,
  pageRange,
  pdfText,
  pdfTextContent,
} from './attachmentContent.js';

const MAX_BODY_CHARS = 50_000;
const BYTES_PER_MEGABYTE = 1024 * 1024;

function sizeLabel(bytes: number): string {
  return bytes % BYTES_PER_MEGABYTE === 0 ? `${bytes / BYTES_PER_MEGABYTE} MB` : `${bytes} bytes`;
}
const TELEMETRY_ERROR = Symbol('telemetryError');
/** The error behind a partial failure, read only for telemetry failure detail. */
const TELEMETRY_FAILURE = Symbol('telemetryFailure');
type TelemetryCallToolResult = CallToolResult & { [TELEMETRY_ERROR]?: true; [TELEMETRY_FAILURE]?: unknown };
const EMPTY_INPUT_SCHEMA: Tool['inputSchema'] = {
  type: 'object',
  properties: {},
  $schema: 'http://json-schema.org/draft-07/schema#',
};

function toolJsonSchema(shape: z.ZodRawShape, pipeStrategy: 'input' | 'output'): Tool['inputSchema'] {
  const schema = zodToJsonSchema(z.object(shape), { strictUnions: true, pipeStrategy });
  // MCP clients use JSON Schema 2020-12 when no dialect is declared.
  if (pipeStrategy === 'output') delete schema.$schema;
  return schema as Tool['inputSchema'];
}

// Retain the existing validators, transforms and JSON Schemas at the SDK boundary.
// The rest of the server also uses Zod 3; the SDK consumes only Standard Schema here.
function mcpSchema<Shape extends z.ZodRawShape>(
  shape: Shape,
): StandardSchemaWithJSON<unknown, z.output<z.ZodObject<Shape>>> {
  const schema = z.object(shape);
  return {
    '~standard': {
      version: 1,
      vendor: 'fluxmail',
      validate: async (value) => {
        const result = await schema.safeParseAsync(value);
        return result.success ? { value: result.data } : { issues: result.error.issues };
      },
      jsonSchema: {
        input: () => toolJsonSchema(shape, 'input'),
        output: () => toolJsonSchema(shape, 'output'),
      },
    },
  };
}

type NullableOptionalInputs<Shape extends z.ZodRawShape> = {
  [Key in keyof Shape]: Shape[Key] extends z.ZodOptional<infer Inner>
    ? z.ZodEffects<z.ZodOptional<z.ZodNullable<Inner>>, z.output<Shape[Key]>, z.input<Shape[Key]> | null>
    : Shape[Key];
};

function nullableOptionalInputs<Shape extends z.ZodRawShape>(shape: Shape): NullableOptionalInputs<Shape> {
  return Object.fromEntries(
    Object.entries(shape).map(([name, schema]) => {
      if (!(schema instanceof z.ZodOptional)) return [name, schema];
      // Keep optional outside nullable so JSON Schema does not include an undefined branch.
      const normalized = schema
        .unwrap()
        .nullable()
        .optional()
        .transform((value: unknown) => (value === null ? undefined : value));
      return [name, schema.description ? normalized.describe(schema.description) : normalized];
    }),
  ) as NullableOptionalInputs<Shape>;
}

const accountIdParam = z
  .string()
  .min(1)
  .optional()
  .describe('Account to operate on. Optional when exactly one account is connected.');

const idParam = z.string().min(1);
const attachmentIdParam = idParam.describe('Opaque attachment ID returned by message metadata');

const addressList = z.array(z.string().min(1)).describe('Recipients, each "Name <a@x.com>" or "a@x.com"');

const queryShape = {
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
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
  hasAttachment: z.boolean().optional(),
  after: z.string().min(1).optional().describe('YYYY-MM-DD received date, inclusive in UTC'),
  before: z.string().min(1).optional().describe('YYYY-MM-DD received date, exclusive in UTC'),
  rawProviderQuery: z
    .string()
    .optional()
    .describe('Provider-native Gmail syntax or Outlook KQL for one compatible account'),
  pageSize: z.number().int().min(1).max(100).optional().describe('Defaults to 25'),
  pageToken: z.string().min(1).optional().describe('nextPageToken from a previous call'),
  includeSnippet: z.boolean().optional().describe('Request or suppress message previews'),
  includeSearchContext: z
    .boolean()
    .optional()
    .describe('Include a match-centered body excerpt; requires a portable text query'),
};

const draftShape = {
  accountId: accountIdParam,
  from: z.string().email().optional().describe('Connected address or an available send-as address'),
  to: addressList.optional(),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z.string().optional().describe('Defaults to "Re: ..." when replying'),
  bodyText: z
    .string()
    .optional()
    .describe(
      'Plain-text body. Line breaks appear in the sent email. Keep each prose paragraph on one continuous line and separate paragraphs with blank lines.',
    ),
  bodyHtml: z.string().optional().describe('HTML body'),
  replyToMessageId: idParam
    .optional()
    .describe('Message being replied to; threads correctly and computes recipients if "to" is omitted'),
  replyAll: z.boolean().optional().describe('With replyToMessageId: reply to all original recipients'),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        content: z.string().describe('base64'),
      }),
    )
    .optional(),
};

function parseAddresses(raw: string[] | undefined): EmailAddress[] | undefined {
  if (!raw) return undefined;
  const parsed = raw.map((r) => {
    const addr = parseSingleAddress(r);
    if (!addr) throw new ClientInputError('invalid_request', `Could not parse email address: "${r}"`);
    return addr;
  });
  return parsed;
}

type DraftArgs = {
  accountId?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  replyToMessageId?: string;
  replyAll?: boolean;
  attachments?: Array<{ filename: string; mimeType: string; content: string }>;
};

function toSendInput(args: DraftArgs): SendInput {
  if (args.replyAll && !args.replyToMessageId) {
    throw new ClientInputError('invalid_request', 'replyAll requires replyToMessageId');
  }
  const input: SendInput = {
    body: {
      ...(args.bodyText !== undefined ? { text: args.bodyText } : {}),
      ...(args.bodyHtml !== undefined ? { html: args.bodyHtml } : {}),
    },
  };
  if (args.from !== undefined) input.from = args.from;
  const to = parseAddresses(args.to);
  if (to?.length) input.to = to;
  const cc = parseAddresses(args.cc);
  if (cc?.length) input.cc = cc;
  const bcc = parseAddresses(args.bcc);
  if (bcc?.length) input.bcc = bcc;
  if (args.subject !== undefined) input.subject = args.subject;
  if (args.replyToMessageId) input.replyToMessageId = args.replyToMessageId;
  if (args.replyAll !== undefined) input.replyAll = args.replyAll;
  if (args.attachments?.length) input.attachments = args.attachments;
  return input;
}

export function toSendRequest(args: DraftArgs & { draftId?: string }): SendInput | { draftId: string } {
  if (args.draftId !== undefined) {
    const contentKeys = [
      'to',
      'cc',
      'bcc',
      'subject',
      'bodyText',
      'bodyHtml',
      'replyToMessageId',
      'replyAll',
      'attachments',
      'from',
    ] as const;
    if (contentKeys.some((key) => args[key] !== undefined)) {
      throw new ClientInputError(
        'invalid_request',
        'draftId cannot be combined with message content; update the draft before sending it',
      );
    }
    return { draftId: args.draftId };
  }
  return toSendInput(args);
}

type BodyFormat = 'text' | 'html' | 'both' | 'none';

function selectBody(
  message: Message,
  format: BodyFormat,
  budget: number,
): Message & {
  bodyTruncation?: Record<string, { totalChars: number; nextOffset?: number }>;
} {
  if (!message.body || format === 'none') return { ...message, body: undefined };
  const body: { text?: string; html?: string } = {};
  const bodyTruncation: Record<string, { totalChars: number; nextOffset?: number }> = {};
  let remaining = budget;
  for (const key of ['text', 'html'] as const) {
    if (format !== 'both' && format !== key) continue;
    const value = message.body[key];
    if (value === undefined) continue;
    const selected = value.slice(0, remaining);
    body[key] = selected;
    bodyTruncation[key] = {
      totalChars: value.length,
      ...(selected.length < value.length ? { nextOffset: selected.length } : {}),
    };
    remaining -= selected.length;
  }
  return { ...message, body, bodyTruncation };
}

function ok(data: unknown): CallToolResult {
  return {
    structuredContent: { data },
    content: [{ type: 'text', text: JSON.stringify({ data }, null, 2) }],
  };
}

function deliveryResult(operation: DeliveryOperation): CallToolResult {
  const result = ok(operation) as TelemetryCallToolResult;
  if (operation.status === 'failed' || operation.status === 'uncertain') {
    result.isError = true;
    result[TELEMETRY_ERROR] = true;
  }
  return result;
}

function toolError(err: unknown, requestId: string): CallToolResult {
  const safe = publicError(err, requestId);
  const payload = { error: safe.code, message: safe.message, requestId, ...(safe.data ? { data: safe.data } : {}) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export type McpTransport = 'http' | 'stdio' | 'unknown';

export interface BuildMcpServerOptions {
  permissions?: PermissionPolicy;
  /** How the connection's permissions can be changed. Defaults to the stdio options for stdio transport. */
  permissionSource?: PermissionSource;
  maxAttachmentBytes?: number;
  telemetry?: Telemetry;
  transport?: McpTransport;
  logger?: Logger;
}

export type McpServerOptions = BuildMcpServerOptions;

interface ToolHandlerOptions extends BuildMcpServerOptions {
  /** The client properties for the tool call's request context. */
  clientProperties?: (ctx: unknown) => McpClientProperties;
}

function toolFeatureProperties(tool: string, args: unknown): TelemetryProperties {
  const modifyAction = MODIFY_ACTION_BY_TOOL.get(tool);
  if (modifyAction) return { action: modifyAction };
  if (!args || typeof args !== 'object') return {};
  const input = args as Record<string, unknown>;

  switch (tool) {
    case 'create_draft':
      return { reply: input.replyToMessageId !== undefined, reply_all: input.replyAll === true };
    case 'send_email':
      return {
        mode: input.draftId !== undefined ? 'draft' : input.replyToMessageId !== undefined ? 'reply' : 'direct',
        scheduled: input.sendAt !== undefined,
        reply_all: input.replyAll === true,
      };
    case 'forward_email':
      return { include_attachments: input.includeAttachments !== false };
    case 'download_attachment':
      return {
        destination: input.inline === true ? 'inline' : typeof input.pages === 'string' ? 'pdf_pages' : 'resource',
      };
    default:
      return {};
  }
}

function toolTelemetryProperties(tool: string, args: unknown[], options: ToolHandlerOptions): TelemetryProperties {
  return {
    ...toolFeatureProperties(tool, args[0]),
    ...options.clientProperties?.(args[1]),
  };
}

function handleResult<A extends unknown[]>(
  tool: string,
  fn: (...args: A) => Promise<CallToolResult>,
  gate?: () => string | undefined,
  options: ToolHandlerOptions = {},
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    const finishActivity = options.telemetry?.beginActivity?.();
    const startedAt = performance.now();
    try {
      // The gate throws when a lapsed license leaves the instance over quota,
      // and yields a renewal warning to attach while the license is in grace.
      const warning = gate?.();
      const result = await fn(...args);
      if (warning) result.content.push({ type: 'text', text: `Note: ${warning}` });
      const telemetryFailed = (result as TelemetryCallToolResult)[TELEMETRY_ERROR] === true;
      captureOperation(options.telemetry, {
        productSurface: 'mcp',
        operation: tool,
        outcome: telemetryFailed ? 'error' : 'success',
        ...(telemetryFailed
          ? { errorCode: 'account_failure', error: (result as TelemetryCallToolResult)[TELEMETRY_FAILURE] }
          : {}),
        durationMs: performance.now() - startedAt,
        transport: options.transport ?? 'unknown',
        properties: toolTelemetryProperties(tool, args, options),
      });
      return result;
    } catch (err) {
      const requestId = randomUUID();
      logFailure(options.logger, 'mcp.operation_failed', err, {
        productSurface: 'mcp',
        operation: tool,
        durationMs: performance.now() - startedAt,
        details: { request_id: requestId },
      });
      captureOperation(options.telemetry, {
        productSurface: 'mcp',
        operation: tool,
        outcome: 'error',
        errorCode: isEmailError(err) ? err.code : 'internal',
        error: err,
        durationMs: performance.now() - startedAt,
        transport: options.transport ?? 'unknown',
        properties: toolTelemetryProperties(tool, args, options),
      });
      return toolError(err, requestId);
    } finally {
      finishActivity?.();
    }
  };
}

function handle<A extends unknown[]>(
  tool: string,
  fn: (...args: A) => Promise<unknown>,
  gate?: () => string | undefined,
  options: ToolHandlerOptions = {},
): (...args: A) => Promise<CallToolResult> {
  return handleResult(tool, async (...args: A) => ok(await fn(...args)), gate, options);
}

function pageOpts(args: {
  pageSize?: number;
  pageToken?: string;
  includeSnippet?: boolean;
  includeSearchContext?: boolean;
}): PageOpts {
  return {
    ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
    ...(args.pageToken !== undefined ? { pageToken: args.pageToken } : {}),
    ...(args.includeSnippet !== undefined ? { includeSnippet: args.includeSnippet } : {}),
    ...(args.includeSearchContext !== undefined ? { includeSearchContext: args.includeSearchContext } : {}),
  };
}

function emailQuery(args: Record<string, unknown>): EmailQuery {
  const keys = [
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
    'rawProviderQuery',
  ] as const;
  const q: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) q[key] = args[key];
  return q as EmailQuery;
}

type ModifyActionName = Exclude<ModifyAction, object> | 'move' | 'addLabels' | 'removeLabels';

interface ModifyTool {
  name: string;
  title: string;
  description: string;
  capability: McpCapability;
  destructive: boolean;
  /** The extra input the action needs, if any. */
  input?: 'folder' | 'labels';
}

/** One MCP tool per modify action, all served by the same implementation. */
export const MODIFY_TOOLS: Record<ModifyActionName, ModifyTool> = {
  markRead: {
    name: 'mark_emails_read',
    title: 'Mark emails read',
    description: 'Mark messages as read.',
    capability: 'mail.organize',
    destructive: false,
  },
  markUnread: {
    name: 'mark_emails_unread',
    title: 'Mark emails unread',
    description: 'Mark messages as unread.',
    capability: 'mail.organize',
    destructive: false,
  },
  star: {
    name: 'star_emails',
    title: 'Star emails',
    description: 'Star messages.',
    capability: 'mail.organize',
    destructive: false,
  },
  unstar: {
    name: 'unstar_emails',
    title: 'Unstar emails',
    description: 'Remove the star from messages.',
    capability: 'mail.organize',
    destructive: false,
  },
  archive: {
    name: 'archive_emails',
    title: 'Archive emails',
    description: 'Move messages out of the inbox into the archive.',
    capability: 'mail.organize',
    destructive: false,
  },
  // Spam and Junk folders delete their mail after a while, so a move can lose it.
  move: {
    name: 'move_emails',
    title: 'Move emails',
    description: 'Move messages to a folder other than the archive or trash.',
    capability: 'mail.organize',
    destructive: true,
    input: 'folder',
  },
  addLabels: {
    name: 'add_labels',
    title: 'Add labels',
    description: 'Add labels, or Outlook categories, to messages.',
    capability: 'mail.organize',
    destructive: false,
    input: 'labels',
  },
  removeLabels: {
    name: 'remove_labels',
    title: 'Remove labels',
    description: 'Remove labels, or Outlook categories, from messages.',
    capability: 'mail.organize',
    destructive: false,
    input: 'labels',
  },
  // Providers empty the trash automatically, so trashed mail is eventually gone.
  trash: {
    name: 'trash_emails',
    title: 'Move emails to trash',
    description: 'Move messages to the trash, where they can be restored until the provider empties it.',
    capability: 'mail.trash',
    destructive: true,
  },
  untrash: {
    name: 'restore_emails',
    title: 'Restore emails from trash',
    description: 'Move messages out of the trash.',
    capability: 'mail.trash',
    destructive: false,
  },
  delete: {
    name: 'delete_emails',
    title: 'Delete emails permanently',
    description:
      "Permanently delete messages. This cannot be undone. Gmail accounts connected through Fluxmail's built-in " +
      'Google app cannot delete permanently; move their messages to the trash instead.',
    capability: 'mail.delete',
    destructive: true,
  },
};

const MODIFY_TOOL_ENTRIES = Object.entries(MODIFY_TOOLS) as Array<[ModifyActionName, ModifyTool]>;
const MODIFY_ACTION_BY_TOOL = new Map(MODIFY_TOOL_ENTRIES.map(([action, tool]) => [tool.name, action]));

type ModifyArgs = { accountId?: string; messageIds: string[]; folder?: string; labels?: string[] };

const PROTECTED_MOVE_DESTINATIONS = new Set(['archive', 'trash']);

function disabledCapabilitiesInstructions(permissions: PermissionPolicy, source: PermissionSource | undefined): string {
  const disabled = MCP_CAPABILITIES.filter((capability) => !hasCapability(permissions, capability));
  if (!disabled.length) return '';
  const actions = disabled.map(
    (capability) =>
      `- ${capability} (${MCP_CAPABILITY_DESCRIPTIONS[capability].replace(/\.$/, '')}). ` +
      enableCapabilitiesInstructions(permissions, [capability], source),
  );
  return (
    '\n\nThis connection has limited permissions. Tools for the disabled actions below are not available. ' +
    'When the user asks for a disabled action, such as sending, replying to, or forwarding mail, tell them ' +
    'it is disabled for this Fluxmail connection and how to enable it. Before changing permissions, explain ' +
    "the access the change grants and get the user's explicit approval for that permission change. A request " +
    'to perform an email action does not authorize changing permissions.\n' +
    actions.join('\n')
  );
}

export function buildMcpServer(service: EmailService, options: BuildMcpServerOptions = {}): McpServer {
  const permissions = normalizePermissionPolicy(options.permissions ?? DEFAULT_PERMISSION_POLICY);
  const permissionSource =
    options.permissionSource ?? (options.transport === 'stdio' ? { kind: 'stdio' as const } : undefined);
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const can = (capability: McpCapability): boolean => hasCapability(permissions, capability);
  const canAll = (capabilities: readonly McpCapability[]): boolean => capabilities.every(can);
  const requireCapabilities = (capabilities: readonly McpCapability[]): void => {
    const missing = capabilities.filter((capability) => !can(capability));
    if (missing.length) {
      throw new MissingCapabilityError(
        `This MCP connection does not allow: ${missing.join(', ')}. ` +
          enableCapabilitiesInstructions(permissions, missing, permissionSource),
        missing,
      );
    }
  };
  const downloadAttachment = async (accountId: string | undefined, messageId: string, attachmentId: string) => {
    const attachment = await service.getAttachment(accountId, messageId, attachmentId, maxAttachmentBytes);
    if (attachment.content.length > maxAttachmentBytes) {
      throw new ClientInputError('invalid_request', 'Attachment is too large to return through MCP.', {
        sizeBytes: attachment.content.length,
        maxBytes: maxAttachmentBytes,
      });
    }
    return attachment;
  };
  // Modern requests carry the client in their envelope; legacy stdio keeps it from initialization.
  const toolOptions: ToolHandlerOptions = {
    ...options,
    clientProperties: (ctx) => {
      const context = ctx as ServerContext | undefined;
      // The SDK types the lifted envelope as empty, but it holds the reserved _meta keys.
      const envelope = context?.mcpReq.envelope as Record<string, unknown> | undefined;
      return mcpClientProperties(
        envelope?.[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion(),
        envelope?.[PROTOCOL_VERSION_META_KEY] ?? (context ? protocolVersionOf(context) : undefined),
      );
    },
  };
  // Every tool except get_status (the diagnostic way out) enforces the plan quota.
  const gated = <A extends unknown[]>(tool: string, capability: McpCapability, fn: (...args: A) => Promise<unknown>) =>
    handle(
      tool,
      async (...args: A) => {
        requireCapabilities([capability]);
        return fn(...args);
      },
      () => service.enforceQuota(),
      toolOptions,
    );
  const allowed = <A extends unknown[]>(
    tool: string,
    capability: McpCapability,
    fn: (...args: A) => Promise<unknown>,
  ) =>
    handle(
      tool,
      async (...args: A) => {
        requireCapabilities([capability]);
        return fn(...args);
      },
      undefined,
      toolOptions,
    );
  const gatedResult = <A extends unknown[]>(
    tool: string,
    capability: McpCapability,
    fn: (...args: A) => Promise<CallToolResult>,
  ) =>
    handleResult(
      tool,
      async (...args: A) => {
        requireCapabilities([capability]);
        return fn(...args);
      },
      () => service.enforceQuota(),
      toolOptions,
    );
  const server = new McpServer(
    { name: 'fluxmail', title: 'Fluxmail Email', version: VERSION },
    {
      instructions:
        "Fluxmail is the user's email integration, already authenticated against their real mailboxes. " +
        'Tool results are structured for you, not for display. Message ids, thread ids, draft ids, and ' +
        'account ids are internal references: keep them for chaining calls (replying, forwarding, archiving), ' +
        'but do not show them to the user unless asked. Report outcomes in plain language with details people ' +
        "care about, e.g. 'Sent \"Quarterly report\" to ann@example.com' or 'Archived the thread', rather " +
        'than echoing raw payloads, ids, or field names.' +
        disabledCapabilitiesInstructions(permissions, permissionSource),
    },
  );
  // Observe successful handshakes/discovery without interpreting protocol negotiation ourselves.
  const connect = server.connect.bind(server);
  server.connect = (transport: Transport) => {
    const start = transport.start.bind(transport);
    transport.start = () => {
      if (options.telemetry && (options.transport === 'stdio' || options.transport === 'http')) {
        trackMcpInitialization(transport, options.telemetry, options.transport);
      }
      return start();
    };
    return connect(transport);
  };
  const protocolVersionOf = (ctx: ServerContext): string | undefined =>
    ctx.http?.req?.headers.get('mcp-protocol-version') ?? server.server.getNegotiatedProtocolVersion();
  const supportsResourceLinks = (ctx: ServerContext): boolean =>
    (protocolVersionOf(ctx) ?? '2025-03-26') >= '2025-06-18';
  // v1 returned unavailable-tool errors as tool results. Keep that public behavior while
  // delegating validation, execution and protocol projection to the SDK's own handler.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = ((method: string, ...args: unknown[]) => {
    if (method === 'tools/call' && typeof args[0] === 'function') {
      const handler = args[0] as (request: CallToolRequest, ctx: ServerContext) => Promise<CallToolResult>;
      return setRequestHandler('tools/call', async (request, ctx) => {
        try {
          return await handler(request, ctx);
        } catch (error) {
          if (
            error instanceof ProtocolError &&
            error.code === ProtocolErrorCode.InvalidParams &&
            error.message === `Tool ${request.params.name} not found`
          ) {
            return { isError: true, content: [{ type: 'text', text: `MCP error -32602: ${error.message}` }] };
          }
          throw error;
        }
      });
    }
    return Reflect.apply(setRequestHandler, undefined, [method, ...args]);
  }) as typeof server.server.setRequestHandler;
  const listedTools: Tool[] = [];
  const registerTool = (
    name: string,
    config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations?: Tool['annotations'] },
    callback: unknown,
  ) => {
    const outputSchema = outputSchemas[name as keyof typeof outputSchemas];
    const inputShape = config.inputSchema as z.ZodRawShape | undefined;
    const inputSchema = inputShape ? nullableOptionalInputs(inputShape) : undefined;
    const registered = server.registerTool(
      name,
      { ...config, inputSchema: mcpSchema(inputSchema ?? {}), outputSchema: mcpSchema(outputSchema) },
      callback as ToolCallback<StandardSchemaWithJSON>,
    );
    listedTools.push({
      name,
      title: config.title as string | undefined,
      description: config.description as string | undefined,
      inputSchema:
        inputSchema && Object.keys(inputSchema).length ? toolJsonSchema(inputSchema, 'input') : EMPTY_INPUT_SCHEMA,
      outputSchema: toolJsonSchema(outputSchema, 'output'),
      annotations: config.annotations as Tool['annotations'],
      execution: { taskSupport: 'forbidden' },
    });
    return registered;
  };

  if (can('mail.read'))
    registerTool(
      'list_accounts',
      {
        title: 'List accounts',
        description: 'List connected email accounts (id, provider, email, status, capabilities).',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      gated('list_accounts', 'mail.read', async () => service.listAccounts()),
    );

  if (can('mail.read'))
    registerTool(
      'get_status',
      {
        title: 'Get status',
        description:
          'Account connection and scheduled-send status, including accounts that need re-authentication. ' +
          'Administrators also see plan details.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      allowed('get_status', 'mail.read', async () => service.status()),
    );

  if (can('mail.read'))
    registerTool(
      'list_folders',
      {
        title: 'List folders',
        description: 'List navigable folders for an account, with roles (inbox, sent, drafts, trash, spam, starred).',
        inputSchema: { accountId: accountIdParam },
        annotations: { readOnlyHint: true },
      },
      gated('list_folders', 'mail.read', async (args: { accountId?: string }) => service.listFolders(args.accountId)),
    );

  if (can('mail.read'))
    registerTool(
      'list_labels',
      {
        title: 'List labels',
        description: 'List Gmail user labels or Outlook categories for an account.',
        inputSchema: { accountId: accountIdParam },
        annotations: { readOnlyHint: true },
      },
      gated('list_labels', 'mail.read', async (args: { accountId?: string }) => service.listLabels(args.accountId)),
    );

  if (can('mail.read'))
    registerTool(
      'list_send_as',
      {
        title: 'List sender addresses',
        description: 'List sender addresses available for an account.',
        inputSchema: { accountId: accountIdParam },
        annotations: { readOnlyHint: true },
      },
      gated(
        'list_send_as',
        'mail.read',
        async (args: { accountId?: string }): Promise<SendAsIdentity[]> => service.listSendAs(args.accountId),
      ),
    );

  if (can('mail.read'))
    registerTool(
      'list_emails',
      {
        title: 'List emails',
        description:
          "List emails from the user's connected mailbox with metadata and optional previews. Filter by folder, " +
          'sender, unread, dates, etc. Paginate with pageToken. Use get_email for full bodies.',
        inputSchema: { accountId: accountIdParam, ...queryShape },
        annotations: { readOnlyHint: true },
      },
      gated(
        'list_emails',
        'mail.read',
        async (args: { accountId?: string; pageSize?: number; pageToken?: string } & Record<string, unknown>) =>
          service.listMessages(args.accountId, emailQuery(args), pageOpts(args)),
      ),
    );

  const { text: _text, ...searchFilterShape } = queryShape;
  if (can('mail.read'))
    registerTool(
      'search_emails',
      {
        title: 'Search emails',
        description:
          'Search one account with typed portable syntax. The query supports text, from:, to:, subject:, in:, ' +
          'read and starred states, attachments, and date filters.',
        inputSchema: {
          accountId: accountIdParam,
          query: z.string().min(1).describe('Typed portable search syntax'),
          ...searchFilterShape,
        },
        annotations: { readOnlyHint: true },
      },
      gated(
        'search_emails',
        'mail.read',
        async (
          args: { accountId?: string; query: string; pageSize?: number; pageToken?: string } & Record<string, unknown>,
        ) => {
          const parsed = parseEmailSearch(args.query);
          if (!parsed.valid) {
            throw new ClientInputError('invalid_request', parsed.diagnostics.map((item) => item.message).join(' '), {
              diagnostics: parsed.diagnostics,
            });
          }
          const merged = mergeEmailQueries(parsed.query, emailQuery(args));
          if (!merged.success) {
            throw new ClientInputError('invalid_request', merged.diagnostics.map((item) => item.message).join(' '), {
              diagnostics: merged.diagnostics,
            });
          }
          const result = await service.listMessages(args.accountId, merged.query, pageOpts(args));
          return {
            ...result,
            ...([...parsed.diagnostics, ...(result.diagnostics ?? [])].length
              ? { diagnostics: [...parsed.diagnostics, ...(result.diagnostics ?? [])] }
              : {}),
          };
        },
      ),
    );

  const {
    pageToken: _batchPageToken,
    rawProviderQuery: _batchRawProviderQuery,
    ...batchSearchFilterShape
  } = searchFilterShape;
  if (can('mail.read'))
    registerTool(
      'search_emails_batch',
      {
        title: 'Search multiple accounts',
        description: 'Search up to 20 accounts with one portable query and return one result group per account.',
        inputSchema: {
          accounts: z
            .array(
              z
                .object(
                  nullableOptionalInputs({ accountId: z.string().min(1), pageToken: z.string().min(1).optional() }),
                )
                .strict(),
            )
            .min(1)
            .max(20),
          query: z.string().min(1).describe('Typed portable search syntax'),
          ...batchSearchFilterShape,
          folder: z.enum(['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'all']).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      gatedResult(
        'search_emails_batch',
        'mail.read',
        async (
          args: {
            accounts: Array<{ accountId: string; pageToken?: string }>;
            query: string;
            pageSize?: number;
            includeSnippet?: boolean;
            includeSearchContext?: boolean;
          } & Record<string, unknown>,
        ) => {
          const parsed = parseEmailSearch(args.query);
          if (!parsed.valid) {
            throw new ClientInputError('invalid_request', parsed.diagnostics.map((item) => item.message).join(' '), {
              diagnostics: parsed.diagnostics,
            });
          }
          const merged = mergeEmailQueries(parsed.query, emailQuery(args));
          if (!merged.success) {
            throw new ClientInputError('invalid_request', merged.diagnostics.map((item) => item.message).join(' '), {
              diagnostics: merged.diagnostics,
            });
          }
          const result = await service.searchMessagesBatch({
            accounts: args.accounts,
            query: merged.query as PortableEmailQuery,
            ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
            ...(args.includeSnippet !== undefined ? { includeSnippet: args.includeSnippet } : {}),
            ...(args.includeSearchContext !== undefined ? { includeSearchContext: args.includeSearchContext } : {}),
          });
          const response = ok({
            ...result,
            groups: result.groups.map((group) => {
              if (!group.page) return group;
              const diagnostics = [...parsed.diagnostics, ...(group.page.diagnostics ?? [])];
              return {
                ...group,
                page: { ...group.page, ...(diagnostics.length ? { diagnostics } : {}) },
              };
            }),
          });
          if (result.groups.every((group) => group.error)) response.isError = true;
          if (result.groups.some((group) => group.error)) {
            (response as TelemetryCallToolResult)[TELEMETRY_ERROR] = true;
            (response as TelemetryCallToolResult)[TELEMETRY_FAILURE] = batchFailureCause(result.groups);
          }
          return response;
        },
      ),
    );

  if (can('mail.read'))
    registerTool(
      'get_email',
      {
        title: 'Get email',
        description: 'Fetch one email in full: body (text and/or HTML), recipients, attachment metadata.',
        inputSchema: {
          accountId: accountIdParam,
          messageId: idParam,
          bodyFormat: z.enum(['text', 'html', 'both', 'none']).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      gated(
        'get_email',
        'mail.read',
        async (args: { accountId?: string; messageId: string; bodyFormat?: BodyFormat }) =>
          selectBody(
            await service.getMessage(args.accountId, args.messageId),
            args.bodyFormat ?? 'both',
            MAX_BODY_CHARS,
          ),
      ),
    );

  if (can('mail.read'))
    registerTool(
      'get_email_body',
      {
        title: 'Read email body',
        description: 'Read a bounded portion of one email body. Use nextOffset to continue.',
        inputSchema: {
          accountId: accountIdParam,
          messageId: idParam,
          format: z.enum(['text', 'html']),
          offset: z.number().int().min(0).optional(),
          maxChars: z.number().int().min(1).max(MAX_BODY_CHARS).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      gated(
        'get_email_body',
        'mail.read',
        async (args: {
          accountId?: string;
          messageId: string;
          format: 'text' | 'html';
          offset?: number;
          maxChars?: number;
        }) => {
          const message = await service.getMessage(args.accountId, args.messageId);
          const value = message.body?.[args.format] ?? '';
          const offset = args.offset ?? 0;
          const text = value.slice(offset, offset + (args.maxChars ?? MAX_BODY_CHARS));
          return {
            format: args.format,
            text,
            offset,
            totalChars: value.length,
            ...(offset + text.length < value.length ? { nextOffset: offset + text.length } : {}),
          };
        },
      ),
    );

  if (can('mail.read'))
    registerTool(
      'get_thread',
      {
        title: 'Get thread',
        description: 'Fetch a page of conversation messages with bounded body content.',
        inputSchema: {
          accountId: accountIdParam,
          threadId: idParam,
          pageSize: z.number().int().min(1).max(25).optional(),
          pageToken: z.string().min(1).optional(),
          bodyFormat: z.enum(['text', 'html', 'both', 'none']).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      gated(
        'get_thread',
        'mail.read',
        async (args: {
          accountId?: string;
          threadId: string;
          pageSize?: number;
          pageToken?: string;
          bodyFormat?: BodyFormat;
        }) => {
          const thread = await service.getThread(args.accountId, args.threadId);
          let offset = 0;
          if (args.pageToken) {
            try {
              const parsed = JSON.parse(Buffer.from(args.pageToken, 'base64url').toString('utf8')) as {
                threadId: string;
                offset: number;
              };
              if (parsed.threadId !== args.threadId || !Number.isInteger(parsed.offset) || parsed.offset < 0)
                throw new Error('token');
              offset = parsed.offset;
            } catch {
              throw new ClientInputError('invalid_request', 'Invalid thread page token.');
            }
          }
          const pageSize = args.pageSize ?? 10;
          let budget = MAX_BODY_CHARS;
          const messages = thread.messages.slice(offset, offset + pageSize).map((message) => {
            const selected = selectBody(message, args.bodyFormat ?? 'both', budget);
            budget -= (selected.body?.text?.length ?? 0) + (selected.body?.html?.length ?? 0);
            return selected;
          });
          const nextOffset = offset + messages.length;
          return {
            id: thread.id,
            subject: thread.subject,
            messages,
            ...(nextOffset < thread.messages.length
              ? {
                  nextPageToken: Buffer.from(JSON.stringify({ threadId: args.threadId, offset: nextOffset })).toString(
                    'base64url',
                  ),
                }
              : {}),
          };
        },
      ),
    );

  if (can('mail.drafts'))
    registerTool(
      'get_draft',
      {
        title: 'Get draft',
        description: 'Read an existing draft by its draft ID.',
        inputSchema: { accountId: accountIdParam, draftId: idParam },
        annotations: { readOnlyHint: true },
      },
      gated('get_draft', 'mail.drafts', async (args: { accountId?: string; draftId: string }) =>
        service.getDraft(args.accountId, args.draftId),
      ),
    );

  if (can('mail.drafts'))
    registerTool(
      'create_draft',
      {
        title: 'Create draft',
        description:
          'Create a draft. For a reply draft, pass replyToMessageId (recipients/subject are derived; replyAll for reply-all).',
        inputSchema: draftShape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      gated('create_draft', 'mail.drafts', async (args: DraftArgs) => {
        if (args.replyToMessageId) requireCapabilities(['mail.read']);
        return service.createDraft(args.accountId, toSendInput(args));
      }),
    );

  if (can('mail.drafts'))
    registerTool(
      'update_draft',
      {
        title: 'Update draft',
        description: 'Replace the content of an existing draft (full replacement, not a patch).',
        inputSchema: { draftId: idParam, ...draftShape },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      gated('update_draft', 'mail.drafts', async (args: DraftArgs & { draftId: string }) => {
        if (args.replyToMessageId) requireCapabilities(['mail.read']);
        return service.updateDraft(args.accountId, args.draftId, toSendInput(args));
      }),
    );

  if (can('mail.drafts'))
    registerTool(
      'delete_draft',
      {
        title: 'Delete draft',
        description: 'Delete a draft.',
        inputSchema: { accountId: accountIdParam, draftId: idParam },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      gated('delete_draft', 'mail.drafts', async (args: { accountId?: string; draftId: string }) => {
        await service.deleteDraft(args.accountId, args.draftId);
        return { deleted: args.draftId };
      }),
    );

  if (can('mail.send'))
    registerTool(
      'preview_send',
      {
        title: 'Preview send',
        description: 'Show the resolved sender, recipients, subject, and attachments without sending.',
        inputSchema: { draftId: idParam.optional(), ...draftShape },
        annotations: { readOnlyHint: true },
      },
      gated('preview_send', 'mail.send', async (args: DraftArgs & { draftId?: string }) => {
        if (args.draftId) requireCapabilities(['mail.drafts']);
        if (args.replyToMessageId) requireCapabilities(['mail.read']);
        return service.previewSend(args.accountId, toSendRequest(args));
      }),
    );

  if (can('mail.send'))
    registerTool(
      'send_email',
      {
        title: 'Send email',
        description:
          "Send an email from the user's connected account. Three modes: direct (to + subject + body), sending " +
          'an existing draft (draftId), or replying (replyToMessageId, optionally replyAll) ' +
          'where recipients, subject, and threading are derived from the original. Confirm with the user when ' +
          'intent is ambiguous. Add sendAt to any mode to schedule instead of sending now.',
        inputSchema: {
          idempotencyKey: z
            .string()
            .regex(/^[\x21-\x7e]{1,255}$/)
            .describe('Reuse this key when retrying the same delivery'),
          draftId: idParam.optional().describe('Send this existing draft'),
          ...draftShape,
          sendAt: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              'Schedule delivery instead of sending now: ISO 8601 with timezone offset or Z ' +
                '(e.g. 2026-07-11T09:00:00-07:00). Fluxmail saves the message as a real draft in the mailbox ' +
                'for delivery by fluxmail serve or fluxmail scheduled run using the same store. Stdio does not ' +
                'deliver schedules. Overdue mail may send when a worker starts. Returns a scheduleId for list/cancel.',
            ),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      handleResult(
        'send_email',
        async (args: DraftArgs & { draftId?: string; sendAt?: string; idempotencyKey: string }) => {
          requireCapabilities(['mail.send']);
          if (args.replyToMessageId !== undefined) requireCapabilities(['mail.read']);
          const { sendAt, idempotencyKey, ...sendArgs } = args;
          return deliveryResult(
            await (sendAt !== undefined
              ? service.scheduleDelivery(args.accountId, toSendRequest(sendArgs), sendAt, idempotencyKey)
              : service.deliver(args.accountId, toSendRequest(sendArgs), idempotencyKey)),
          );
        },
        () => service.enforceQuota(),
        toolOptions,
      ),
    );

  if (can('mail.read'))
    registerTool(
      'list_scheduled_emails',
      {
        title: 'List scheduled emails',
        description:
          'List scheduled sends: pending ones first (with sendAt), then past ones (sent, failed, canceled). ' +
          'For failed entries, lastError says what went wrong. Pending sends only fire while the ' +
          'Fluxmail server is running.',
        inputSchema: { accountId: accountIdParam },
        annotations: { readOnlyHint: true },
      },
      gated('list_scheduled_emails', 'mail.read', async (args: { accountId?: string }) =>
        service.listScheduled(args.accountId),
      ),
    );

  if (can('mail.send'))
    registerTool(
      'get_delivery_operation',
      {
        title: 'Get delivery status',
        description: 'Check whether a send or forward succeeded, failed, or has an uncertain outcome.',
        inputSchema: { accountId: idParam, operationId: idParam },
        annotations: { readOnlyHint: true },
      },
      allowed('get_delivery_operation', 'mail.send', async (args: { accountId: string; operationId: string }) =>
        service.getDelivery(args.accountId, args.operationId),
      ),
    );

  if (can('mail.drafts'))
    registerTool(
      'cancel_scheduled_email',
      {
        title: 'Cancel scheduled email',
        description:
          'Cancel a pending scheduled send by scheduleId (from send_email with sendAt, or list_scheduled_emails). ' +
          'The draft stays in the Drafts folder, so the content is not lost.',
        inputSchema: { scheduleId: idParam },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      gated('cancel_scheduled_email', 'mail.drafts', async (args: { scheduleId: string }) =>
        service.cancelScheduled(args.scheduleId),
      ),
    );

  if (canAll(['mail.send', 'mail.read']))
    registerTool(
      'forward_email',
      {
        title: 'Forward email',
        description:
          'Forward an email to new recipients: quoted original body, "Fwd:" subject, original attachments included ' +
          'unless includeAttachments=false. Optional comment appears above the forwarded content.',
        inputSchema: {
          idempotencyKey: z
            .string()
            .regex(/^[\x21-\x7e]{1,255}$/)
            .describe('Reuse this key when retrying the same forward'),
          accountId: accountIdParam,
          messageId: idParam,
          from: z.string().email().optional().describe('Connected address or an available send-as address'),
          to: addressList.min(1),
          cc: addressList.optional(),
          comment: z
            .string()
            .optional()
            .describe(
              'Comment above the forwarded message. Keep prose paragraphs on one continuous line and separate paragraphs with blank lines.',
            ),
          includeAttachments: z.boolean().optional().describe('Default true'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      handleResult(
        'forward_email',
        async (args: {
          accountId?: string;
          messageId: string;
          to: string[];
          cc?: string[];
          comment?: string;
          includeAttachments?: boolean;
          from?: string;
          idempotencyKey: string;
        }) => {
          requireCapabilities(['mail.send', 'mail.read']);
          const to = parseAddresses(args.to) ?? [];
          const cc = parseAddresses(args.cc);
          return deliveryResult(
            await service.deliverForward(
              args.accountId,
              {
                messageId: args.messageId,
                to,
                ...(cc?.length ? { cc } : {}),
                ...(args.comment !== undefined ? { comment: args.comment } : {}),
                ...(args.includeAttachments !== undefined ? { includeAttachments: args.includeAttachments } : {}),
                ...(args.from !== undefined ? { from: args.from } : {}),
              },
              args.idempotencyKey,
            ),
          );
        },
        () => service.enforceQuota(),
        toolOptions,
      ),
    );

  const modifyEmails = async (action: ModifyActionName, args: ModifyArgs): Promise<CallToolResult> => {
    requireCapabilities([MODIFY_TOOLS[action].capability]);
    let modifyAction: ModifyAction;
    if (action === 'move') {
      if (!args.folder) throw new ClientInputError('invalid_request', 'Moving messages requires "folder"');
      if (PROTECTED_MOVE_DESTINATIONS.has(args.folder.trim().toLowerCase())) {
        throw new ClientInputError(
          'invalid_request',
          'Archive or trash these messages instead of moving them to this folder.',
        );
      }
      modifyAction = { move: args.folder };
    } else if (action === 'addLabels' || action === 'removeLabels') {
      if (!args.labels?.length) throw new ClientInputError('invalid_request', `${action} requires "labels"`);
      modifyAction = action === 'addLabels' ? { addLabels: args.labels } : { removeLabels: args.labels };
    } else {
      modifyAction = action;
    }
    const result = await service.modify(args.accountId, args.messageIds, modifyAction);
    const response = ok({ ...result, action }) as TelemetryCallToolResult;
    if (result.failed.length || result.uncertainIds.length) {
      response.isError = true;
      response[TELEMETRY_ERROR] = true;
    }
    return response;
  };
  const messageIdsParam = z
    .array(idParam)
    .min(1)
    .refine((ids) => new Set(ids).size <= 100, 'At most 100 distinct message IDs are allowed.')
    .describe('Messages to change, up to 100 distinct IDs');
  const modifyInputs = {
    folder: { folder: z.string().min(1).describe('Destination folder name or role') },
    labels: { labels: z.array(z.string().min(1)).min(1).max(100).describe('Gmail labels or Outlook categories') },
  };
  for (const [action, tool] of MODIFY_TOOL_ENTRIES) {
    if (!can(tool.capability)) continue;
    registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: {
          accountId: accountIdParam,
          messageIds: messageIdsParam,
          ...(tool.input ? modifyInputs[tool.input] : {}),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: tool.destructive,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handleResult(
        tool.name,
        async (args: ModifyArgs) => modifyEmails(action, args),
        () => service.enforceQuota(),
        toolOptions,
      ),
    );
  }

  if (can('mail.read'))
    registerTool(
      'download_attachment',
      {
        title: 'Download attachment',
        description:
          `Get metadata and a resource link for one attachment, up to ${sizeLabel(maxAttachmentBytes)}. ` +
          'With inline, the result also includes the content. For a PDF, inline adds extracted text, and pages ' +
          'returns the text of a page range such as 201-400.',
        inputSchema: {
          accountId: accountIdParam,
          messageId: idParam,
          attachmentId: attachmentIdParam,
          inline: z.boolean().optional(),
          pages: pageRange.optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      gatedResult(
        'download_attachment',
        'mail.read',
        async (
          args: { accountId?: string; messageId: string; attachmentId: string; inline?: boolean; pages?: string },
          extra: ServerContext,
        ) => {
          const { meta, content, accountId } = await downloadAttachment(
            args.accountId,
            args.messageId,
            args.attachmentId,
          );
          const mimeType = meta.mimeType || 'application/octet-stream';
          const pdf = mediaType(mimeType) === 'application/pdf';
          if (args.pages && !pdf) {
            throw new ClientInputError('invalid_request', 'Pages apply only to PDF attachments.');
          }
          const extracted =
            pdf && (args.inline || args.pages)
              ? await pdfText(content, extra.mcpReq.signal, args.pages, (error) =>
                  options.logger?.warn('mcp.pdf_text_failed', 'PDF text extraction failed.', error, {
                    productSurface: 'mcp',
                    operation: 'download_attachment',
                  }),
                )
              : undefined;
          const uri = [
            'fluxmail://attachment',
            ...[accountId, args.messageId, args.attachmentId, meta.filename].map(encodeURIComponent),
          ].join('/');
          const resourceLinks = supportsResourceLinks(extra);
          return {
            structuredContent: { data: meta },
            content: [
              { type: 'text', text: JSON.stringify(resourceLinks ? { data: meta } : { data: meta, uri }, null, 2) },
              ...(resourceLinks
                ? [{ type: 'resource_link' as const, name: meta.filename, uri, mimeType: meta.mimeType }]
                : []),
              ...(args.inline ? [inlineContent(uri, mimeType, content)] : []),
              ...pdfTextContent(meta.filename, extracted),
            ],
          };
        },
      ),
    );

  if (can('mail.read'))
    server.registerResource(
      'attachment',
      new ResourceTemplate('fluxmail://attachment/{accountId}/{messageId}/{attachmentId}/{filename}', {
        list: undefined,
      }),
      { description: 'Read one attachment from an authorized mailbox.' },
      async (uri, variables) => {
        requireCapabilities(['mail.read']);
        service.enforceQuota();
        const { meta, content } = await downloadAttachment(
          decodeURIComponent(String(variables.accountId)),
          decodeURIComponent(String(variables.messageId)),
          decodeURIComponent(String(variables.attachmentId)),
        );
        return { contents: [attachmentContents(uri.href, meta.mimeType || 'application/octet-stream', content)] };
      },
    );

  if (can('mail.read')) server.server.registerCapabilities({ resources: { listChanged: false } });
  if (listedTools.length) {
    server.server.registerCapabilities({ tools: { listChanged: false } });
    // Preserve the advertised schemas, including empty inputs and output schema dialects.
    server.server.setRequestHandler('tools/list', () => ({ tools: listedTools }));
  }

  server.server.setRequestHandler = setRequestHandler;
  return server;
}
