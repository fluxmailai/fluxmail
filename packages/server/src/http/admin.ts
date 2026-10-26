import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { isIP } from 'node:net';
import { EmailError, isEmailError } from '@fluxmail/core';
import type { ImapCredentials } from '@fluxmail/provider-imap';
import type { AccountRegistry } from '../accounts/registry.js';
import { prepareHostedGmailConnection, prepareHostedOutlookConnection } from '../accounts/gmailConnection.js';
import { EnvironmentControlledSettingError, type ConfigurationService, type FluxmailConfig } from '../config.js';
import { LICENSE_KEY_PATTERN, releaseLicense } from '../licensing/client.js';
import { activateLicense } from '../licensing/activation.js';
import { checkLicenseState, clearLease, readLeaseRow } from '../licensing/entitlements.js';
import { loadInstanceId, type LicenseController } from '../licensing/refresher.js';
import {
  ADMIN_CAPABILITIES,
  MCP_CAPABILITIES,
  NAMED_PERMISSION_PROFILES,
  customPermissionPolicy,
  permissionPolicyForProfile,
  type AdminCapability,
  type PermissionPolicy,
} from '../permissions.js';
import { createApiKey, listApiKeys, revokeApiKey, updateApiKey } from '../storage/apiKeys.js';
import type { FluxmailDb } from '../storage/db.js';
import { findMember } from '../storage/members.js';
import type { Principal } from '../auth.js';
import { canAdminister, canSeeAccountMetadata } from '../authorization.js';
import { operationIdForRequest } from './operationRoutes.js';
import { setOperationProperties } from './operationTelemetry.js';
import { accountInventoryProperties, configuredOAuthAppKind, connectionProperties } from '../accounts/telemetry.js';
import { logCodedFailure, logFailure, type Logger } from '../logging.js';

export const ADMIN_BODY_LIMIT = 64 * 1024;
export const ADMIN_CONNECTION_TIMEOUT_MS = 30_000;

export const adminOperationRoutes = {
  createConnection: {
    method: 'post',
    path: '/api/v1/admin/connections',
    operationId: 'createAdministrativeConnection',
  },
  testImapConnection: {
    method: 'post',
    path: '/api/v1/admin/imap/tests',
    operationId: 'testAdministrativeImapConnection',
  },
  updateImapFolders: {
    method: 'patch',
    path: '/api/v1/admin/accounts/{accountId}/imap/folders',
    operationId: 'updateAdministrativeImapFolders',
  },
  listApiKeys: {
    method: 'get',
    path: '/api/v1/admin/api-keys',
    operationId: 'listAdministrativeApiKeys',
  },
  createApiKey: {
    method: 'post',
    path: '/api/v1/admin/api-keys',
    operationId: 'createAdministrativeApiKey',
  },
  updateApiKey: {
    method: 'patch',
    path: '/api/v1/admin/api-keys/{keyId}',
    operationId: 'updateAdministrativeApiKey',
  },
  revokeApiKey: {
    method: 'delete',
    path: '/api/v1/admin/api-keys/{keyId}',
    operationId: 'revokeAdministrativeApiKey',
  },
  getOauthApps: {
    method: 'get',
    path: '/api/v1/admin/oauth-apps',
    operationId: 'getAdministrativeOAuthApps',
  },
  putOauthApp: {
    method: 'put',
    path: '/api/v1/admin/oauth-apps/{provider}',
    operationId: 'putAdministrativeOAuthApp',
  },
  deleteOauthApp: {
    method: 'delete',
    path: '/api/v1/admin/oauth-apps/{provider}',
    operationId: 'deleteAdministrativeOAuthApp',
  },
  getLicense: {
    method: 'get',
    path: '/api/v1/admin/license',
    operationId: 'getAdministrativeLicense',
  },
  activateLicense: {
    method: 'post',
    path: '/api/v1/admin/license/activate',
    operationId: 'activateAdministrativeLicense',
  },
  deactivateLicense: {
    method: 'delete',
    path: '/api/v1/admin/license',
    operationId: 'deactivateAdministrativeLicense',
  },
} as const;

export function adminOperationId(method: string, path: string): string | undefined {
  return operationIdForRequest(Object.values(adminOperationRoutes), method, path);
}

export interface AdminConnectionSecurity {
  remoteAddress?: string;
  encrypted?: boolean;
}

function firstForwardedElement(value: string | null): string | undefined {
  return value?.split(',', 1)[0]?.trim() || undefined;
}

function forwardedParameter(request: Request, name: 'for' | 'proto'): string | undefined {
  const first = firstForwardedElement(request.headers.get('forwarded'));
  if (!first) return undefined;
  for (const parameter of first.split(';')) {
    const [key, ...parts] = parameter.split('=');
    if (key?.trim().toLowerCase() !== name) continue;
    return parts.join('=').trim().replace(/^"|"$/g, '');
  }
  return undefined;
}

function forwardedProtocol(request: Request): string | undefined {
  return (
    forwardedParameter(request, 'proto') ?? firstForwardedElement(request.headers.get('x-forwarded-proto'))
  )?.toLowerCase();
}

function forwardedAddress(request: Request): string | undefined {
  const value = forwardedParameter(request, 'for') ?? firstForwardedElement(request.headers.get('x-forwarded-for'));
  if (!value || value.toLowerCase() === 'unknown' || value.startsWith('_')) return undefined;
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    const address = closingBracket > 0 ? value.slice(1, closingBracket) : '';
    return isIP(address) ? address : undefined;
  }
  if (isIP(value)) return value;
  const ipv4WithPort = value.match(/^(.*):(\d+)$/)?.[1];
  return ipv4WithPort && isIP(ipv4WithPort) === 4 ? ipv4WithPort : undefined;
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%', 1)[0]!;
  return normalized === '::1' || normalized.startsWith('::ffff:127.') || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isLoopbackHostname(value: string): boolean {
  return value.toLowerCase() === 'localhost' || isLoopbackAddress(value);
}

export function administrationUsesHttps(
  request: Request,
  connection?: AdminConnectionSecurity,
  trustProxy = false,
): boolean {
  if (connection?.encrypted) return true;
  if (connection?.remoteAddress !== undefined && isLoopbackAddress(connection.remoteAddress)) return true;
  if (trustProxy && forwardedProtocol(request) === 'https') return true;
  if (connection?.remoteAddress !== undefined) return false;

  const requestUrl = new URL(request.url);
  // No socket is available in Hono's in-memory helper or in non-Node adapters.
  // These paths use the request URL itself. Node requests must pass the peer
  // and TLS state above so headers and configuration cannot bless plaintext.
  return requestUrl.protocol === 'https:' || isLoopbackHostname(requestUrl.hostname);
}

export function requestClientAddress(
  request: Request,
  connection?: AdminConnectionSecurity,
  trustProxy = false,
): string {
  if (trustProxy) {
    const forwarded = forwardedAddress(request);
    if (forwarded) return forwarded;
  }
  return connection?.remoteAddress ?? 'unknown';
}

export async function requestBodyExceedsLimit(request: Request, limit = ADMIN_BODY_LIMIT): Promise<boolean> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > limit) return true;
  }

  const body = request.clone().body;
  if (!body) return false;
  const reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      received += chunk.value.byteLength;
      if (received > limit) {
        void reader.cancel().catch(() => {});
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface AdminApiDeps {
  config: FluxmailConfig;
  configuration: ConfigurationService;
  db: FluxmailDb;
  registry?: AccountRegistry;
  licenseController?: LicenseController;
  logger?: Logger;
}

const identifier = z.string().trim().min(1).max(200);
const boundedName = z.string().trim().min(1).max(200);
const host = z.string().trim().min(1).max(255);
const username = z.string().min(1).max(320);
const password = z.string().min(1).max(4096);
const folderPath = z.string().min(1).max(1024);
const security = z.enum(['tls', 'starttls']);
const folderRoles = ['sent', 'drafts', 'trash', 'archive', 'spam'] as const;

const FolderOverridesSchema = z
  .object({
    sent: folderPath.optional(),
    drafts: folderPath.optional(),
    trash: folderPath.optional(),
    archive: folderPath.optional(),
    spam: folderPath.optional(),
  })
  .strict();
const FolderPatchSchema = z
  .object({
    sent: folderPath.nullable().optional(),
    drafts: folderPath.nullable().optional(),
    trash: folderPath.nullable().optional(),
    archive: folderPath.nullable().optional(),
    spam: folderPath.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one folder override is required.')
  .openapi({ example: { sent: 'Sent' } });
const ServerSettingsSchema = z
  .object({ host, port: z.number().int().min(1).max(65_535), security, user: username, password })
  .strict();
const ImapSettingsSchema = z
  .object({
    email: z.string().email().max(320),
    displayName: z.string().trim().min(1).max(200).optional(),
    imap: ServerSettingsSchema,
    smtp: ServerSettingsSchema,
    saveSent: z.boolean().optional(),
    folderOverrides: FolderOverridesSchema.optional(),
  })
  .strict()
  .openapi({
    example: {
      email: 'you@example.com',
      imap: {
        host: 'imap.example.com',
        port: 993,
        security: 'tls',
        user: 'you@example.com',
        password: 'app-password',
      },
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        security: 'tls',
        user: 'you@example.com',
        password: 'app-password',
      },
    },
  });
const SharingSchema = {
  ownerMemberId: identifier.optional(),
  reauthorizeAccountId: identifier.optional(),
  sharedWithAll: z.boolean().optional(),
  grantedMemberIds: z.array(identifier).max(100).optional(),
};
const ConnectionSchema = z
  .discriminatedUnion('provider', [
    z.object({ provider: z.literal('gmail'), ...SharingSchema }).strict(),
    z.object({ provider: z.literal('outlook'), ...SharingSchema }).strict(),
    z.object({ provider: z.literal('imap'), ...SharingSchema, ...ImapSettingsSchema.shape }).strict(),
  ])
  .openapi({ example: { provider: 'gmail', ownerMemberId: 'you@example.com' } });

const CapabilitySchema = z.enum([...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES]);
const AdminCapabilitySchema = z.enum(ADMIN_CAPABILITIES);
const ApiKeyCreateSchema = z
  .object({
    name: boundedName,
    member: identifier,
    accounts: z.array(identifier).max(100).nullable().optional(),
    permissionProfile: z.enum(NAMED_PERMISSION_PROFILES).optional(),
    supplementalCapabilities: z.array(AdminCapabilitySchema).max(ADMIN_CAPABILITIES.length).optional(),
    customCapabilities: z
      .array(CapabilitySchema)
      .min(1)
      .max(MCP_CAPABILITIES.length + ADMIN_CAPABILITIES.length)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.customCapabilities && (value.permissionProfile || value.supplementalCapabilities)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customCapabilities cannot be combined with a named profile.',
      });
    }
    if (!value.customCapabilities && !value.permissionProfile) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose permissionProfile or customCapabilities.' });
    }
  })
  .openapi({ example: { name: 'reporting', member: 'you@example.com', permissionProfile: 'read-only' } });
const ApiKeyPatchSchema = z
  .object({
    permissionProfile: z.enum(NAMED_PERMISSION_PROFILES).optional(),
    supplementalCapabilities: z.array(AdminCapabilitySchema).max(ADMIN_CAPABILITIES.length).optional(),
    customCapabilities: z
      .array(CapabilitySchema)
      .min(1)
      .max(MCP_CAPABILITIES.length + ADMIN_CAPABILITIES.length)
      .optional(),
    accounts: z.array(identifier).max(100).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required.')
  .superRefine((value, ctx) => {
    if (value.customCapabilities && (value.permissionProfile || value.supplementalCapabilities)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customCapabilities cannot be combined with a named profile.',
      });
    }
  })
  .openapi({ example: { permissionProfile: 'read-only' } });
const LicenseActivationSchema = z.object({ licenseKey: z.string().max(200) }).strict();

const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), data: z.record(z.unknown()).optional() }).strict(),
  })
  .strict()
  .openapi('AdminRestError');
const ApiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    memberId: z.string(),
    permissionProfile: z.enum([...NAMED_PERMISSION_PROFILES, 'custom']),
    capabilities: z.array(CapabilitySchema),
    supplementalCapabilities: z.array(AdminCapabilitySchema),
    accountIds: z.array(z.string()).nullable(),
  })
  .strict()
  .openapi('AdministrativeApiKey');
const GenericDataSchema = z.object({ data: z.record(z.unknown()) }).strict();
const ApiKeyCreateResponseSchema = z.object({ data: ApiKeySchema.extend({ key: z.string() }) }).strict();
const OAuthProviderSchema = z.enum(['google', 'outlook']).openapi({ example: 'google' });
const OAuthAppInputSchema = z
  .object({
    clientId: z.string().trim().min(1).max(2048).openapi({ example: 'client-id.apps.example.com' }),
    clientSecret: z.string().trim().min(1).max(16_384).optional().openapi({ example: 'client-secret' }),
    tenantId: z.string().trim().min(1).max(2048).optional().openapi({ example: 'common' }),
    publicClient: z.boolean().optional(),
  })
  .strict()
  .openapi({ example: { clientId: 'client-id.apps.example.com', clientSecret: 'client-secret' } });
const OAuthAppsResponseSchema = z
  .object({
    data: z.object({
      google: z.object({
        clientId: z.string(),
        clientSecretConfigured: z.boolean(),
        source: z.enum(['built-in', 'stored', 'environment', 'environment-file']),
        mutable: z.boolean(),
      }),
      outlook: z.object({
        clientId: z.string(),
        tenantId: z.string(),
        clientSecretConfigured: z.boolean(),
        source: z.enum(['built-in', 'stored', 'environment', 'environment-file']),
        mutable: z.boolean(),
      }),
    }),
  })
  .strict();

const errors = {
  400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid request' },
  401: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Authentication required' },
  403: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Administrative access denied' },
  404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Resource not found' },
  409: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Request conflict' },
  413: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Request body too large' },
  415: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Unsupported media type' },
  500: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Internal error' },
  502: { content: { 'application/json': { schema: ErrorSchema } }, description: 'License could not be verified' },
} as const;
const protectedRoute = { security: [{ bearerAuth: [] }] };

class AdminFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function failureResponse(error: unknown): Response {
  if (error instanceof AdminFailure) return json({ error: { code: error.code, message: error.message } }, error.status);
  if (isEmailError(error)) {
    const status = error.code === 'not_found' ? 404 : error.code === 'permission_denied' ? 403 : 400;
    return json({ error: { code: error.code, message: error.message } }, status);
  }
  return json({ error: { code: 'internal', message: 'The administrative request could not be completed.' } }, 500);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

function requireAdmin(auth: Principal, capability: AdminCapability): void {
  if (!canAdminister(auth, capability)) {
    throw new AdminFailure('permission_denied', `This credential does not allow ${capability}.`, 403);
  }
}

function requireAdminAccount(auth: Principal, account: ReturnType<AccountRegistry['getAccount']>): void {
  if (!canSeeAccountMetadata(auth, account)) {
    throw new EmailError('not_found', 'Mailbox not found.');
  }
}

function requireUnscopedAccountCreation(auth: Principal): void {
  if (auth.accountIds !== null) {
    throw new EmailError('permission_denied', 'This API key is limited to existing mailboxes.');
  }
}

function registry(deps: AdminApiDeps): AccountRegistry {
  if (!deps.registry) throw new AdminFailure('unavailable', 'Account administration is unavailable.', 500);
  return deps.registry;
}

function resolveSharing(
  deps: AdminApiDeps,
  input: {
    ownerMemberId?: string;
    reauthorizeAccountId?: string;
    sharedWithAll?: boolean;
    grantedMemberIds?: string[];
  },
): { ownerMemberId?: string; reauthorizeAccountId?: string; sharedWithAll?: boolean; grantedMemberIds?: string[] } {
  const grantedMemberIds = input.grantedMemberIds ?? [];
  if (
    input.reauthorizeAccountId &&
    (input.ownerMemberId || input.sharedWithAll !== undefined || grantedMemberIds.length)
  ) {
    throw new EmailError(
      'invalid_request',
      'Ownership and sharing settings cannot be combined with reauthorizeAccountId.',
    );
  }
  if (input.reauthorizeAccountId)
    return { reauthorizeAccountId: registry(deps).getAccount(input.reauthorizeAccountId).id };
  if (!input.ownerMemberId) throw new EmailError('invalid_request', 'ownerMemberId is required for a new mailbox.');
  return {
    ownerMemberId: findMember(deps.db, input.ownerMemberId).id,
    sharedWithAll: input.sharedWithAll ?? false,
    grantedMemberIds: grantedMemberIds.map((ref) => findMember(deps.db, ref).id),
  };
}

function permissions(input: {
  permissionProfile?: (typeof NAMED_PERMISSION_PROFILES)[number];
  supplementalCapabilities?: AdminCapability[];
  customCapabilities?: Array<(typeof MCP_CAPABILITIES)[number] | AdminCapability>;
}): PermissionPolicy {
  return input.customCapabilities
    ? customPermissionPolicy(input.customCapabilities)
    : permissionPolicyForProfile(input.permissionProfile!, input.supplementalCapabilities ?? []);
}

function accountIds(deps: AdminApiDeps, refs: string[] | null | undefined): string[] | null | undefined {
  if (refs === undefined || refs === null) return refs;
  return [...new Set(refs.map((ref) => registry(deps).findAccount(ref).id))];
}

function serializeApiKey(key: ReturnType<typeof listApiKeys>[number]) {
  return {
    ...key,
    createdAt: new Date(key.createdAt).toISOString(),
    lastUsedAt: key.lastUsedAt === null ? null : new Date(key.lastUsedAt).toISOString(),
  };
}

// oxlint-disable-next-line typescript/no-explicit-any -- OpenAPI handlers require route-specific typed responses.
async function run<T extends Response>(deps: AdminApiDeps, fn: () => Promise<T> | T): Promise<any> {
  try {
    return await fn();
  } catch (error) {
    const context = {
      productSurface: 'rest',
      operation: 'administrative_request',
    } as const;
    if (error instanceof AdminFailure) {
      logCodedFailure(deps.logger, 'rest.operation_failed', error.code, error.message, context);
    } else {
      logFailure(deps.logger, 'rest.operation_failed', error, context);
    }
    return failureResponse(error);
  }
}

// oxlint-disable-next-line typescript/no-explicit-any -- The caller supplies a route-specific Hono environment.
export function registerAdminRoutes(app: OpenAPIHono<any>, deps: AdminApiDeps): void {
  const connectionsRoute = createRoute({
    ...adminOperationRoutes.createConnection,
    summary: 'Create or reauthorize a connection',
    description: 'Create or reauthorize a Gmail, Outlook, or IMAP connection. Requires admin.accounts.',
    ...protectedRoute,
    request: { body: { required: true, content: { 'application/json': { schema: ConnectionSchema } } } },
    responses: {
      201: {
        content: { 'application/json': { schema: GenericDataSchema } },
        description: 'Connection prepared or saved',
      },
      ...errors,
    },
  });
  app.openapi(connectionsRoute, (c) =>
    run(deps, async () => {
      const auth = c.get('restAuth') as Principal;
      requireAdmin(auth, 'admin.accounts');
      const input = c.req.valid('json');
      setOperationProperties(
        c,
        connectionProperties({
          provider: input.provider,
          reauthorize: input.reauthorizeAccountId !== undefined,
          ...(input.provider === 'imap' ? {} : { flow: 'hosted' as const }),
          oauthApp: configuredOAuthAppKind(deps.config, input.provider),
        }),
      );
      const access = resolveSharing(deps, input);
      if (access.reauthorizeAccountId) {
        requireAdminAccount(auth, registry(deps).getAccount(access.reauthorizeAccountId));
      } else {
        requireUnscopedAccountCreation(auth);
      }
      if (input.provider === 'gmail' || input.provider === 'outlook') {
        if (!access.reauthorizeAccountId) registry(deps).assertCanAddAccount();
        if (access.reauthorizeAccountId) {
          const existing = registry(deps).getAccount(access.reauthorizeAccountId);
          if (existing.provider !== input.provider) {
            throw new EmailError(
              'invalid_request',
              `Account ${existing.id} uses ${existing.provider}, not ${input.provider}.`,
            );
          }
        }
        const prepared =
          input.provider === 'gmail'
            ? prepareHostedGmailConnection(deps.db, deps.config, access)
            : prepareHostedOutlookConnection(deps.db, deps.config, access);
        return json(
          {
            data: {
              provider: input.provider,
              connectionUrl: prepared.connectionUrl,
              expiresAt: new Date(prepared.expiresAt).toISOString(),
            },
          },
          201,
        );
      }

      const existing = access.reauthorizeAccountId ? registry(deps).getAccount(access.reauthorizeAccountId) : undefined;
      const duplicate = existing
        ? undefined
        : registry(deps)
            .listAccounts()
            .find((account) => account.email.toLowerCase() === input.email.toLowerCase());
      if (existing && (existing.provider !== 'imap' || existing.email.toLowerCase() !== input.email.toLowerCase())) {
        throw new EmailError('invalid_request', `Account ${existing.id} does not match IMAP mailbox ${input.email}.`);
      }
      if (!existing) registry(deps).assertCanAddAccount();
      const previous = existing ? registry(deps).loadImapCredentials(existing.id) : undefined;
      const credentials: ImapCredentials = {
        imap: input.imap,
        smtp: input.smtp,
        saveSent: input.saveSent ?? previous?.saveSent ?? true,
        folderOverrides: { ...previous?.folderOverrides, ...input.folderOverrides },
      };
      const warnings = await registry(deps).testImapCredentials(
        input.email,
        credentials,
        input.displayName,
        ADMIN_CONNECTION_TIMEOUT_MS,
      );
      const connected = registry(deps).addImapAccount(
        input.email,
        credentials,
        input.displayName,
        access.ownerMemberId,
        access.reauthorizeAccountId,
        access.ownerMemberId
          ? { sharedWithAll: access.sharedWithAll ?? false, grantedMemberIds: access.grantedMemberIds }
          : undefined,
      );
      setOperationProperties(c, {
        reauthorize: existing !== undefined || duplicate !== undefined,
        ...accountInventoryProperties(registry(deps)),
      });
      return json({ data: { account: connected, warnings } }, 201);
    }),
  );

  const imapTestRoute = createRoute({
    ...adminOperationRoutes.testImapConnection,
    summary: 'Test an IMAP connection',
    description: 'Test IMAP and SMTP settings without saving an account. Requires admin.accounts.',
    ...protectedRoute,
    request: { body: { required: true, content: { 'application/json': { schema: ImapSettingsSchema } } } },
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'Connection test result' },
      ...errors,
    },
  });
  app.openapi(imapTestRoute, (c) =>
    run(deps, async () => {
      requireAdmin(c.get('restAuth'), 'admin.accounts');
      const input = c.req.valid('json');
      const warnings = await registry(deps).testImapCredentials(
        input.email,
        {
          imap: input.imap,
          smtp: input.smtp,
          saveSent: input.saveSent ?? true,
          folderOverrides: input.folderOverrides,
        },
        input.displayName,
        ADMIN_CONNECTION_TIMEOUT_MS,
      );
      return json({ data: { ok: true, warnings } });
    }),
  );

  const folderRoute = createRoute({
    ...adminOperationRoutes.updateImapFolders,
    summary: 'Update IMAP folders',
    description: 'Update the folder overrides for an IMAP account. Requires admin.accounts.',
    ...protectedRoute,
    request: {
      params: z.object({ accountId: identifier }).strict(),
      body: { required: true, content: { 'application/json': { schema: FolderPatchSchema } } },
    },
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'Updated folder overrides' },
      ...errors,
    },
  });
  app.openapi(folderRoute, (c) =>
    run(deps, async () => {
      const auth = c.get('restAuth') as Principal;
      requireAdmin(auth, 'admin.accounts');
      const { accountId } = c.req.valid('param');
      const patch = c.req.valid('json');
      const account = registry(deps).getAccount(accountId);
      requireAdminAccount(auth, account);
      const current = registry(deps).loadImapCredentials(account.id);
      const nextOverrides = { ...current.folderOverrides };
      for (const role of folderRoles) {
        if (!(role in patch)) continue;
        const value = patch[role];
        if (value === null) delete nextOverrides[role];
        else if (value !== undefined) nextOverrides[role] = value;
      }
      const proposed = { ...current, folderOverrides: nextOverrides };
      const warnings = await registry(deps).testImapFolderOverrides(
        account.email,
        proposed,
        account.displayName,
        ADMIN_CONNECTION_TIMEOUT_MS,
      );
      const invalid = warnings.find(
        (warning) => warning.reason === 'stale_override' && typeof patch[warning.role] === 'string',
      );
      if (invalid) throw new EmailError('invalid_request', invalid.message);
      registry(deps).saveImapCredentials(account.id, proposed);
      return json({ data: { accountId: account.id, folderOverrides: nextOverrides, warnings } });
    }),
  );

  const listKeysRoute = createRoute({
    ...adminOperationRoutes.listApiKeys,
    summary: 'List API keys',
    description: 'List API key metadata without returning plaintext secrets. Requires admin.api_keys.',
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: z.object({ data: z.array(ApiKeySchema) }) } },
        description: 'API keys',
      },
      ...errors,
    },
  });
  app.openapi(listKeysRoute, (c) =>
    run(deps, () => {
      requireAdmin(c.get('restAuth'), 'admin.api_keys');
      return json({ data: listApiKeys(deps.db).map(serializeApiKey) });
    }),
  );

  const createKeyRoute = createRoute({
    ...adminOperationRoutes.createApiKey,
    summary: 'Create an API key',
    description: 'Create an API key and return its plaintext secret once. Requires admin.api_keys.',
    ...protectedRoute,
    request: { body: { required: true, content: { 'application/json': { schema: ApiKeyCreateSchema } } } },
    responses: {
      201: {
        content: { 'application/json': { schema: ApiKeyCreateResponseSchema } },
        description: 'Created API key with one-time plaintext secret',
      },
      ...errors,
    },
  });
  app.openapi(createKeyRoute, (c) =>
    run(deps, () => {
      requireAdmin(c.get('restAuth'), 'admin.api_keys');
      const input = c.req.valid('json');
      const member = findMember(deps.db, input.member);
      const created = createApiKey(
        deps.db,
        input.name,
        member.id,
        permissions(input),
        accountIds(deps, input.accounts),
      );
      return json({ data: { ...serializeApiKey(created.info), key: created.key } }, 201);
    }),
  );

  const patchKeyRoute = createRoute({
    ...adminOperationRoutes.updateApiKey,
    summary: 'Update an API key',
    description: 'Update the permissions or mailbox scope of an API key. Requires admin.api_keys.',
    ...protectedRoute,
    request: {
      params: z.object({ keyId: identifier }).strict(),
      body: { required: true, content: { 'application/json': { schema: ApiKeyPatchSchema } } },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: z.object({ data: ApiKeySchema }) } },
        description: 'Updated API key',
      },
      ...errors,
    },
  });
  app.openapi(patchKeyRoute, (c) =>
    run(deps, () => {
      requireAdmin(c.get('restAuth'), 'admin.api_keys');
      const { keyId } = c.req.valid('param');
      const input = c.req.valid('json');
      const existing = listApiKeys(deps.db).find((key) => key.id === keyId);
      if (!existing) throw new EmailError('not_found', `No API key with id "${keyId}".`);

      let nextPermissions: PermissionPolicy | undefined;
      if (input.customCapabilities || input.permissionProfile) {
        nextPermissions = permissions(input);
      } else if (input.supplementalCapabilities) {
        if (existing.permissionProfile === 'custom') {
          throw new EmailError('invalid_request', 'supplementalCapabilities cannot be applied to a custom policy.');
        }
        nextPermissions = permissionPolicyForProfile(existing.permissionProfile, input.supplementalCapabilities);
      }
      const updated = updateApiKey(deps.db, keyId, {
        ...(nextPermissions ? { permissions: nextPermissions } : {}),
        ...(input.accounts !== undefined ? { accountIds: accountIds(deps, input.accounts) } : {}),
      });
      return json({ data: serializeApiKey(updated!) });
    }),
  );

  const deleteKeyRoute = createRoute({
    ...adminOperationRoutes.revokeApiKey,
    summary: 'Revoke an API key',
    description: 'Revoke an API key. Requires admin.api_keys.',
    ...protectedRoute,
    request: { params: z.object({ keyId: identifier }).strict() },
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'Revoked API key' },
      ...errors,
    },
  });
  app.openapi(deleteKeyRoute, (c) =>
    run(deps, () => {
      requireAdmin(c.get('restAuth'), 'admin.api_keys');
      const { keyId } = c.req.valid('param');
      if (!revokeApiKey(deps.db, keyId)) throw new EmailError('not_found', `No API key with id "${keyId}".`);
      return json({ data: { id: keyId, revoked: true } });
    }),
  );

  const getOauthAppsRoute = createRoute({
    ...adminOperationRoutes.getOauthApps,
    summary: 'Get OAuth application status',
    description: 'Get safe OAuth application metadata without returning client secrets. Requires admin.accounts.',
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: OAuthAppsResponseSchema } }, description: 'OAuth applications' },
      ...errors,
    },
  });
  app.openapi(getOauthAppsRoute, (c) =>
    run(deps, () => {
      requireAdmin(c.get('restAuth'), 'admin.accounts');
      return json({ data: deps.configuration.oauthStatus() });
    }),
  );

  const putOauthAppRoute = createRoute({
    ...adminOperationRoutes.putOauthApp,
    summary: 'Configure an OAuth application',
    description: 'Save an OAuth application in encrypted instance settings. Requires admin.accounts.',
    ...protectedRoute,
    request: {
      params: z.object({ provider: OAuthProviderSchema }).strict(),
      body: { required: true, content: { 'application/json': { schema: OAuthAppInputSchema } } },
    },
    responses: {
      200: { content: { 'application/json': { schema: OAuthAppsResponseSchema } }, description: 'OAuth applications' },
      ...errors,
    },
  });
  app.openapi(putOauthAppRoute, (c) =>
    run(deps, () => {
      requireAdmin(c.get('restAuth'), 'admin.accounts');
      const { provider } = c.req.valid('param');
      const input = c.req.valid('json');
      try {
        if (provider === 'google') {
          if (!input.clientSecret) {
            throw new AdminFailure('invalid_request', 'Google OAuth requires a client secret.', 400);
          }
          if (input.tenantId !== undefined || input.publicClient !== undefined) {
            throw new AdminFailure('invalid_request', 'Google OAuth does not accept Microsoft settings.', 400);
          }
          deps.configuration.setGoogle({ clientId: input.clientId, clientSecret: input.clientSecret });
        } else {
          if (input.publicClient === true && input.clientSecret) {
            throw new AdminFailure('invalid_request', 'A public client cannot include a client secret.', 400);
          }
          if (input.publicClient !== true && !input.clientSecret) {
            throw new AdminFailure('invalid_request', 'Choose a public client or provide a client secret.', 400);
          }
          deps.configuration.setMicrosoft({
            clientId: input.clientId,
            tenantId: input.tenantId ?? 'common',
            ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
          });
        }
      } catch (error) {
        if (error instanceof AdminFailure) throw error;
        if (!(error instanceof EnvironmentControlledSettingError)) throw error;
        throw new AdminFailure(
          'oauth_from_environment',
          'Remove the OAuth environment overrides before changing this application.',
          409,
        );
      }
      return json({ data: deps.configuration.oauthStatus() });
    }),
  );

  const deleteOauthAppRoute = createRoute({
    ...adminOperationRoutes.deleteOauthApp,
    summary: 'Reset an OAuth application',
    description: 'Remove a stored OAuth application. Requires admin.accounts.',
    ...protectedRoute,
    request: { params: z.object({ provider: OAuthProviderSchema }).strict() },
    responses: {
      200: { content: { 'application/json': { schema: OAuthAppsResponseSchema } }, description: 'OAuth applications' },
      ...errors,
    },
  });
  app.openapi(deleteOauthAppRoute, (c) =>
    run(deps, () => {
      requireAdmin(c.get('restAuth'), 'admin.accounts');
      const { provider } = c.req.valid('param');
      try {
        if (provider === 'google') deps.configuration.resetGoogle();
        else deps.configuration.resetMicrosoft();
      } catch (error) {
        if (!(error instanceof EnvironmentControlledSettingError)) throw error;
        throw new AdminFailure(
          'oauth_from_environment',
          'Remove the OAuth environment overrides before resetting this application.',
          409,
        );
      }
      return json({ data: deps.configuration.oauthStatus() });
    }),
  );

  const licenseRoute = createRoute({
    ...adminOperationRoutes.getLicense,
    summary: 'Get license status',
    description: 'Get license status and usage without returning the configured license key. Requires admin.license.',
    ...protectedRoute,
    responses: {
      200: {
        content: { 'application/json': { schema: GenericDataSchema } },
        description: 'License status without the configured key',
      },
      ...errors,
    },
  });
  app.openapi(licenseRoute, (c) =>
    run(deps, () => {
      requireAdmin(c.get('restAuth'), 'admin.license');
      const state = checkLicenseState(deps.db);
      const row = readLeaseRow(deps.db);
      const configured = Boolean(deps.licenseController?.configuredKey() ?? deps.config.licenseKey);
      return json({
        data: {
          configured,
          source: configured ? deps.configuration.licenseSource() : null,
          entitlements: state.entitlements,
          usage: { accounts: state.accountCount, members: state.memberCount, overQuota: state.overQuota },
          lastValidatedAt: row ? new Date(row.updatedAt).toISOString() : null,
          warning: state.warning ?? null,
        },
      });
    }),
  );

  const activateRoute = createRoute({
    ...adminOperationRoutes.activateLicense,
    summary: 'Activate a license',
    description: 'Validate and activate a Fluxmail license key. Requires admin.license.',
    ...protectedRoute,
    request: { body: { required: true, content: { 'application/json': { schema: LicenseActivationSchema } } } },
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'Validated activation' },
      202: {
        content: { 'application/json': { schema: GenericDataSchema } },
        description: 'Saved for retry after an outage',
      },
      ...errors,
    },
  });
  app.openapi(activateRoute, (c) =>
    run(deps, async () => {
      requireAdmin(c.get('restAuth'), 'admin.license');
      const { licenseKey } = c.req.valid('json');
      if (!LICENSE_KEY_PATTERN.test(licenseKey)) {
        throw new AdminFailure('invalid_license_key', 'The license key format is invalid.', 400);
      }
      if (deps.config.licenseKeyFromEnvironment) {
        throw new AdminFailure(
          'license_from_environment',
          'REST cannot replace FLUXMAIL_LICENSE_KEY from the environment.',
          409,
        );
      }
      const result = await activateLicense(deps.db, deps.configuration, {
        licenseKey,
        serverUrl: deps.config.licenseServerUrl,
        dataDir: deps.config.dataDir,
      });
      if (result.outcome === 'refreshed') {
        deps.licenseController?.wake();
        return json({ data: { outcome: 'activated', lease: result.lease } });
      }
      if (result.outcome === 'outage') {
        deps.licenseController?.wake();
        return json({ data: { outcome: 'saved_for_retry' } }, 202);
      }
      if (result.outcome === 'bad_lease') {
        throw new AdminFailure('unverifiable_lease', 'The license lease could not be verified.', 502);
      }
      const status = result.outcome === 'in_use' ? 409 : result.outcome === 'inactive' ? 403 : 400;
      throw new AdminFailure(`license_${result.outcome}`, result.message, status);
    }),
  );

  const deactivateRoute = createRoute({
    method: 'delete',
    path: '/api/v1/admin/license',
    operationId: 'deactivateAdministrativeLicense',
    summary: 'Deactivate a license',
    description: 'Release the stored license and return this instance to Personal limits. Requires admin.license.',
    ...protectedRoute,
    responses: {
      200: { content: { 'application/json': { schema: GenericDataSchema } }, description: 'License deactivated' },
      ...errors,
    },
  });
  app.openapi(deactivateRoute, (c) =>
    run(deps, async () => {
      requireAdmin(c.get('restAuth'), 'admin.license');
      if (deps.config.licenseKeyFromEnvironment) {
        throw new AdminFailure(
          'license_from_environment',
          'REST cannot remove FLUXMAIL_LICENSE_KEY from the environment.',
          409,
        );
      }
      const licenseKey = deps.licenseController?.configuredKey() ?? deps.config.licenseKey;
      const released = licenseKey
        ? await releaseLicense({
            serverUrl: deps.config.licenseServerUrl,
            licenseKey,
            instanceId: loadInstanceId(deps.config.dataDir),
          })
        : false;
      const removed = deps.configuration.removeLicenseKey();
      clearLease(deps.db);
      deps.licenseController?.wake();
      return json({ data: { deactivated: true, released, removedStoredKey: removed } });
    }),
  );
}
