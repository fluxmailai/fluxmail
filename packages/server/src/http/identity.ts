import { randomUUID } from 'node:crypto';
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { EmailError, isEmailError } from '@fluxmail/core';
import {
  changePassword,
  enrollMember,
  issueMemberAuthToken,
  listMemberSessions,
  loginWithPassword,
  resetPassword,
  revokeSession,
  type Principal,
} from '../auth.js';
import { canAccessAccount, canAdminister, canManageOwnedAccount, canSeeAccountMetadata } from '../authorization.js';
import {
  ADMIN_CAPABILITIES,
  DEFAULT_PERMISSION_PROFILE,
  MCP_CAPABILITIES,
  NAMED_PERMISSION_PROFILES,
  customPermissionPolicy,
  permissionPolicyForProfile,
} from '../permissions.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../storage/apiKeys.js';
import { listAdminAuditEvents, recordAdminAuditEvent } from '../storage/adminAudit.js';
import { memberCredentials } from '../storage/db.js';
import { addMember, findMember, listMembers, removeMember, updateMember } from '../storage/members.js';
import { eq } from 'drizzle-orm';
import type { RestApiDeps } from './rest.js';
import { prepareHostedGmailConnection, prepareHostedOutlookConnection } from '../accounts/gmailConnection.js';
import type { ImapCredentials } from '@fluxmail/provider-imap';
import { requestClientAddress } from './admin.js';
import { operationIdForRequest, type OperationRoute } from './operationRoutes.js';
import { setOperationProperties } from './operationTelemetry.js';
import {
  accountInventoryProperties,
  configuredOAuthAppKind,
  connectionProperties,
  type ConnectionStage,
} from '../accounts/telemetry.js';
import { logFailure, type Logger } from '../logging.js';

export const identityOperationRoutes = [
  { method: 'post', path: '/api/v1/auth/login', operationId: 'login' },
  { method: 'post', path: '/api/v1/auth/enroll', operationId: 'enrollMember' },
  { method: 'post', path: '/api/v1/auth/password-reset', operationId: 'resetPassword' },
  { method: 'post', path: '/api/v1/auth/logout', operationId: 'logout' },
  { method: 'get', path: '/api/v1/me', operationId: 'getCurrentMember' },
  { method: 'patch', path: '/api/v1/me', operationId: 'updateCurrentMember' },
  { method: 'put', path: '/api/v1/me/password', operationId: 'changePassword' },
  { method: 'get', path: '/api/v1/me/sessions', operationId: 'listSessions' },
  { method: 'delete', path: '/api/v1/me/sessions/{sessionId}', operationId: 'revokeSession' },
  { method: 'get', path: '/api/v1/me/api-keys', operationId: 'listOwnApiKeys' },
  { method: 'post', path: '/api/v1/me/api-keys', operationId: 'createOwnApiKey' },
  { method: 'delete', path: '/api/v1/me/api-keys/{keyId}', operationId: 'revokeOwnApiKey' },
  { method: 'post', path: '/api/v1/accounts/connections', operationId: 'connectOwnAccount' },
  { method: 'delete', path: '/api/v1/accounts/{accountId}/connection', operationId: 'removeOwnAccount' },
  { method: 'patch', path: '/api/v1/accounts/{accountId}/imap/folders', operationId: 'updateOwnedImapFolders' },
  { method: 'get', path: '/api/v1/admin/members', operationId: 'listMembers' },
  { method: 'post', path: '/api/v1/admin/members', operationId: 'createMember' },
  { method: 'patch', path: '/api/v1/admin/members/{memberId}', operationId: 'updateMember' },
  { method: 'delete', path: '/api/v1/admin/members/{memberId}', operationId: 'deleteMember' },
  { method: 'post', path: '/api/v1/admin/members/{memberId}/invitation', operationId: 'inviteMember' },
  {
    method: 'post',
    path: '/api/v1/admin/members/{memberId}/password-reset',
    operationId: 'createMemberPasswordReset',
  },
  { method: 'get', path: '/api/v1/admin/members/{memberId}/sessions', operationId: 'listMemberSessions' },
  {
    method: 'delete',
    path: '/api/v1/admin/members/{memberId}/sessions/{sessionId}',
    operationId: 'revokeMemberSession',
  },
  { method: 'get', path: '/api/v1/admin/accounts', operationId: 'listAdminAccounts' },
  { method: 'patch', path: '/api/v1/admin/accounts/{accountId}', operationId: 'updateAccountAccess' },
  { method: 'delete', path: '/api/v1/admin/accounts/{accountId}', operationId: 'deleteAdminAccount' },
  { method: 'get', path: '/api/v1/admin/audit-events', operationId: 'listAuditEvents' },
] as const satisfies readonly OperationRoute[];

export function identityOperationId(method: string, path: string): string | undefined {
  return operationIdForRequest(identityOperationRoutes, method, path);
}

const protectedRoute = { security: [{ bearerAuth: [] }] };
const sessionRoute = { security: [{ memberSessionAuth: [] }] };
const genericData = z.object({ data: z.unknown() }).passthrough();
const genericError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().uuid().optional(),
    diagnostics: z
      .object({
        connectionStage: z.enum([
          'cli_validation',
          'connection_request',
          'server_validation',
          'provider_check',
          'account_persist',
          'oauth_prepare',
          'complete',
        ]),
      })
      .optional(),
  }),
});
const responses = {
  200: { content: { 'application/json': { schema: genericData } }, description: 'Success' },
  400: { content: { 'application/json': { schema: genericError } }, description: 'Invalid request' },
  401: { content: { 'application/json': { schema: genericError } }, description: 'Authentication required' },
  403: { content: { 'application/json': { schema: genericError } }, description: 'Permission denied' },
  404: { content: { 'application/json': { schema: genericError } }, description: 'Not found' },
  409: { content: { 'application/json': { schema: genericError } }, description: 'Conflict' },
  413: { content: { 'application/json': { schema: genericError } }, description: 'Request body too large' },
  429: { content: { 'application/json': { schema: genericError } }, description: 'Too many attempts' },
} as const;
const providerResponses = {
  422: { content: { 'application/json': { schema: genericError } }, description: 'Unsupported capability' },
  503: { content: { 'application/json': { schema: genericError } }, description: 'Provider unavailable' },
} as const;

const loginBody = z
  .object({ email: z.string().email(), password: z.string(), deviceName: z.string().trim().min(1).max(200) })
  .strict();
const tokenPasswordBody = z
  .object({ token: z.string().trim().min(1), password: z.string(), deviceName: z.string().trim().min(1).max(200) })
  .strict();
const memberParams = z.object({ memberId: z.string().trim().min(1) });
const sessionParams = z.object({ sessionId: z.string().trim().min(1) });
const memberSessionParams = z.object({ memberId: z.string().trim().min(1), sessionId: z.string().trim().min(1) });
const keyParams = z.object({ keyId: z.string().trim().min(1) });
const accountParams = z.object({ accountId: z.string().trim().min(1) });
const CapabilitySchema = z.enum([...MCP_CAPABILITIES, ...ADMIN_CAPABILITIES]);
const AdminCapabilitySchema = z.enum(ADMIN_CAPABILITIES);
const ownApiKeyBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    permissionProfile: z.enum(NAMED_PERMISSION_PROFILES).optional(),
    capabilities: z
      .array(CapabilitySchema)
      .min(1)
      .max(MCP_CAPABILITIES.length + ADMIN_CAPABILITIES.length)
      .optional(),
    supplementalCapabilities: z.array(AdminCapabilitySchema).max(ADMIN_CAPABILITIES.length).optional(),
    accountIds: z.array(z.string()).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.capabilities && (value.permissionProfile || value.supplementalCapabilities)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'capabilities cannot be combined with a named profile.',
      });
    }
  });
const folderRoles = ['sent', 'drafts', 'trash', 'archive', 'spam'] as const;
const mailServerSettings = z
  .object({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
    security: z.enum(['tls', 'starttls']),
    user: z.string().min(1).max(320),
    password: z.string().min(1).max(4096),
  })
  .strict();
const folderOverrides = z
  .object({
    sent: z.string().min(1).max(1024).optional(),
    drafts: z.string().min(1).max(1024).optional(),
    trash: z.string().min(1).max(1024).optional(),
    archive: z.string().min(1).max(1024).optional(),
    spam: z.string().min(1).max(1024).optional(),
  })
  .strict();
const folderPatch = z
  .object({
    sent: z.string().min(1).max(1024).nullable().optional(),
    drafts: z.string().min(1).max(1024).nullable().optional(),
    trash: z.string().min(1).max(1024).nullable().optional(),
    archive: z.string().min(1).max(1024).nullable().optional(),
    spam: z.string().min(1).max(1024).nullable().optional(),
  })
  .strict();

// oxlint-disable-next-line typescript/no-explicit-any -- Route handlers have different Hono context types.
function jsonError(
  c: any,
  error: unknown,
  diagnostics?: { requestId: string; connectionStage: ConnectionStage },
): Response {
  const responseDetails = diagnostics
    ? { request_id: diagnostics.requestId, connection_stage: diagnostics.connectionStage }
    : undefined;
  logFailure(c.get?.('restLogger') as Logger | undefined, 'rest.operation_failed', error, {
    productSurface: 'rest',
    operation: identityOperationId(c.req.method, c.req.path) ?? 'identity_request',
    ...(responseDetails ? { details: responseDetails } : {}),
  });
  if (isEmailError(error)) {
    const statuses: Record<string, number> = {
      invalid_request: 400,
      permission_denied: 403,
      entitlement_exceeded: 403,
      not_found: 404,
      auth_expired: 409,
      unsupported_capability: 422,
      rate_limited: 429,
      provider_unavailable: 503,
    };
    const status = statuses[error.code] ?? 500;
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(diagnostics
            ? { requestId: diagnostics.requestId, diagnostics: { connectionStage: diagnostics.connectionStage } }
            : {}),
        },
      },
      status,
      diagnostics ? { 'x-request-id': diagnostics.requestId } : undefined,
    );
  }
  return c.json(
    {
      error: {
        code: 'internal',
        message: 'The request could not be completed.',
        ...(diagnostics
          ? { requestId: diagnostics.requestId, diagnostics: { connectionStage: diagnostics.connectionStage } }
          : {}),
      },
    },
    500,
    diagnostics ? { 'x-request-id': diagnostics.requestId } : undefined,
  );
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestIdFromHeader(value: string | undefined): string {
  return value && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

function requireSession(principal: Principal): Extract<Principal, { kind: 'session' }> {
  if (principal.kind !== 'session') {
    throw new EmailError('permission_denied', 'This operation requires an interactive member session.');
  }
  return principal;
}

function requireAdministrator(principal: Principal, capability: Parameters<typeof canAdminister>[1]): void {
  if (!canAdminister(principal, capability)) {
    throw new EmailError('permission_denied', 'Administrator access is required.');
  }
}

function memberData(member: ReturnType<typeof findMember>) {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    status: member.status,
    accountCount: member.accountCount,
    apiKeyCount: member.apiKeyCount,
    createdAt: member.createdAt,
  };
}

function audit(
  deps: RestApiDeps,
  principal: Principal | undefined,
  operation: string,
  outcome: 'success' | 'error',
  target?: { type: string; id: string },
  errorCode?: string,
): void {
  try {
    recordAdminAuditEvent(deps.db, {
      operation,
      outcome,
      actorMemberId: principal?.memberId ?? (target?.type === 'member' ? target.id : null),
      actorKeyId: principal?.kind === 'api_key' ? principal.keyId : undefined,
      actorSessionId: principal?.kind === 'session' ? principal.sessionId : undefined,
      ...(target ? { resourceType: target.type, resourceId: target.id } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  } catch {
    // Audit storage must not replace the primary response.
  }
}

function authResult(result: Awaited<ReturnType<typeof loginWithPassword>>) {
  return {
    token: result.session.token,
    member: memberData(result.member),
    session: result.session.info,
  };
}

// oxlint-disable-next-line typescript/no-explicit-any -- The caller supplies a route-specific Hono environment.
export function registerIdentityRoutes(typedApp: OpenAPIHono<any>, deps: RestApiDeps): void {
  const app = typedApp as unknown as {
    // oxlint-disable-next-line typescript/no-explicit-any -- Each route supplies a different validated request type.
    openapi(route: unknown, handler: (context: any) => Response | Promise<Response>): void;
  };
  const loginRoute = createRoute({
    method: 'post',
    path: '/api/v1/auth/login',
    operationId: 'login',
    summary: 'Log in with a member email and password',
    request: { body: { required: true, content: { 'application/json': { schema: loginBody } } } },
    responses,
  });
  app.openapi(loginRoute, async (c) => {
    try {
      const result = await loginWithPassword(deps.db, {
        ...c.req.valid('json'),
        ipAddress: requestClientAddress(
          c.req.raw,
          { remoteAddress: c.env?.incoming?.socket.remoteAddress },
          deps.config.trustProxy,
        ),
      });
      audit(deps, undefined, 'auth.login', 'success', { type: 'member', id: result.member.id });
      return c.json({ data: authResult(result) }, 200);
    } catch (error) {
      audit(deps, undefined, 'auth.login', 'error', undefined, isEmailError(error) ? error.code : 'internal');
      return jsonError(c, error);
    }
  });

  for (const [path, operationId, kind] of [
    ['/api/v1/auth/enroll', 'enrollMember', 'enrollment'],
    ['/api/v1/auth/password-reset', 'resetPassword', 'password_reset'],
  ] as const) {
    const route = createRoute({
      method: 'post',
      path,
      operationId,
      summary: kind === 'enrollment' ? 'Enroll a member' : 'Redeem a password reset',
      request: { body: { required: true, content: { 'application/json': { schema: tokenPasswordBody } } } },
      responses,
    });
    app.openapi(route, async (c) => {
      try {
        const input = c.req.valid('json');
        const result = kind === 'enrollment' ? await enrollMember(deps.db, input) : await resetPassword(deps.db, input);
        audit(deps, undefined, `auth.${kind}`, 'success', { type: 'member', id: result.member.id });
        return c.json({ data: authResult(result) }, 200);
      } catch (error) {
        audit(deps, undefined, `auth.${kind}`, 'error', undefined, isEmailError(error) ? error.code : 'internal');
        return jsonError(c, error);
      }
    });
  }

  const meRoute = createRoute({
    method: 'get',
    path: '/api/v1/me',
    operationId: 'getCurrentMember',
    summary: 'Get the authenticated member',
    ...protectedRoute,
    responses,
  });
  app.openapi(meRoute, (c) => {
    const principal = c.get('restAuth') as Principal;
    return c.json({ data: memberData(findMember(deps.db, principal.memberId)) }, 200);
  });

  const updateMeRoute = createRoute({
    method: 'patch',
    path: '/api/v1/me',
    operationId: 'updateCurrentMember',
    summary: 'Update the current member profile',
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({ name: z.string().trim().min(1) }).strict() } },
      },
    },
    ...sessionRoute,
    responses,
  });
  app.openapi(updateMeRoute, (c) => {
    try {
      const principal = requireSession(c.get('restAuth'));
      const member = updateMember(deps.db, principal.memberId, c.req.valid('json'));
      audit(deps, principal, 'member.profile.update', 'success', { type: 'member', id: member.id });
      return c.json({ data: memberData(member) }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const logoutRoute = createRoute({
    method: 'post',
    path: '/api/v1/auth/logout',
    operationId: 'logout',
    summary: 'Revoke the current member session',
    ...sessionRoute,
    responses,
  });
  app.openapi(logoutRoute, (c) => {
    try {
      const principal = requireSession(c.get('restAuth'));
      revokeSession(deps.db, principal.memberId, principal.sessionId);
      audit(deps, principal, 'auth.logout', 'success');
      return c.json({ data: { revoked: principal.sessionId } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const passwordRoute = createRoute({
    method: 'put',
    path: '/api/v1/me/password',
    operationId: 'changePassword',
    summary: 'Change the current member password',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ currentPassword: z.string(), newPassword: z.string() }).strict(),
          },
        },
      },
    },
    ...sessionRoute,
    responses,
  });
  app.openapi(passwordRoute, async (c) => {
    try {
      const principal = requireSession(c.get('restAuth'));
      await changePassword(deps.db, {
        memberId: principal.memberId,
        keepSessionId: principal.sessionId,
        ...c.req.valid('json'),
      });
      audit(deps, principal, 'auth.password.change', 'success');
      return c.json({ data: { changed: true } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const listSessionsRoute = createRoute({
    method: 'get',
    path: '/api/v1/me/sessions',
    operationId: 'listSessions',
    summary: 'List current member sessions',
    ...sessionRoute,
    responses,
  });
  app.openapi(listSessionsRoute, (c) => {
    try {
      const principal = requireSession(c.get('restAuth'));
      return c.json({ data: listMemberSessions(deps.db, principal.memberId, principal.sessionId) }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const deleteSessionRoute = createRoute({
    method: 'delete',
    path: '/api/v1/me/sessions/{sessionId}',
    operationId: 'revokeSession',
    summary: 'Revoke a member session',
    request: { params: sessionParams },
    ...sessionRoute,
    responses,
  });
  app.openapi(deleteSessionRoute, (c) => {
    try {
      const principal = requireSession(c.get('restAuth'));
      const { sessionId } = c.req.valid('param');
      if (!revokeSession(deps.db, principal.memberId, sessionId))
        throw new EmailError('not_found', 'Session not found.');
      audit(deps, principal, 'auth.session.revoke', 'success', { type: 'session', id: sessionId });
      return c.json({ data: { revoked: sessionId } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const listOwnKeysRoute = createRoute({
    method: 'get',
    path: '/api/v1/me/api-keys',
    operationId: 'listOwnApiKeys',
    summary: 'List API keys owned by the current member',
    ...sessionRoute,
    responses,
  });
  app.openapi(listOwnKeysRoute, (c) => {
    try {
      const principal = requireSession(c.get('restAuth'));
      return c.json({ data: listApiKeys(deps.db).filter((key) => key.memberId === principal.memberId) }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const createOwnKeyRoute = createRoute({
    method: 'post',
    path: '/api/v1/me/api-keys',
    operationId: 'createOwnApiKey',
    summary: 'Create an API key for the current member',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: ownApiKeyBody,
          },
        },
      },
    },
    ...sessionRoute,
    responses: { ...responses, 201: responses[200] },
  });
  app.openapi(createOwnKeyRoute, (c) => {
    try {
      const principal = requireSession(c.get('restAuth'));
      const input = c.req.valid('json');
      const permissions = input.capabilities
        ? customPermissionPolicy(input.capabilities)
        : permissionPolicyForProfile(
            input.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
            input.supplementalCapabilities,
          );
      for (const accountId of input.accountIds ?? []) {
        if (!deps.registry) throw new EmailError('unsupported_capability', 'Account management is unavailable.');
        const account = deps.registry.getAccount(accountId);
        if (!canAccessAccount(principal, account)) {
          throw new EmailError('permission_denied', `Mailbox ${accountId} is not available to this member.`);
        }
      }
      const created = createApiKey(deps.db, input.name, principal.memberId, permissions, input.accountIds ?? null);
      audit(deps, principal, 'api_key.create', 'success', { type: 'api_key', id: created.info.id });
      return c.json({ data: { ...created.info, key: created.key } }, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const deleteOwnKeyRoute = createRoute({
    method: 'delete',
    path: '/api/v1/me/api-keys/{keyId}',
    operationId: 'revokeOwnApiKey',
    summary: 'Revoke an API key owned by the current member',
    request: { params: keyParams },
    ...sessionRoute,
    responses,
  });
  app.openapi(deleteOwnKeyRoute, (c) => {
    try {
      const principal = requireSession(c.get('restAuth'));
      const { keyId } = c.req.valid('param');
      const owned = listApiKeys(deps.db).some((key) => key.id === keyId && key.memberId === principal.memberId);
      if (!owned || !revokeApiKey(deps.db, keyId)) throw new EmailError('not_found', 'API key not found.');
      audit(deps, principal, 'api_key.revoke', 'success', { type: 'api_key', id: keyId });
      return c.json({ data: { revoked: keyId } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const connectionRoute = createRoute({
    method: 'post',
    path: '/api/v1/accounts/connections',
    operationId: 'connectOwnAccount',
    summary: 'Connect or reauthorize a mailbox account',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z
              .object({
                provider: z.enum(['gmail', 'outlook', 'imap']),
                reauthorizeAccountId: z.string().optional(),
                email: z.string().email().optional(),
                displayName: z.string().optional(),
                imap: mailServerSettings.optional(),
                smtp: mailServerSettings.optional(),
                saveSent: z.boolean().optional(),
                folderOverrides: folderOverrides.optional(),
              })
              .strict(),
          },
        },
      },
    },
    ...sessionRoute,
    responses: { ...responses, ...providerResponses, 201: responses[200] },
  });
  app.openapi(connectionRoute, async (c) => {
    const principal = c.get('restAuth') as Principal;
    const requestId = requestIdFromHeader(c.req.header('x-request-id'));
    let connectionStage: ConnectionStage = 'server_validation';
    try {
      requireSession(principal);
      if (!deps.registry) throw new EmailError('unsupported_capability', 'Account management is unavailable.');
      const input = c.req.valid('json');
      setOperationProperties(
        c,
        connectionProperties({
          provider: input.provider,
          reauthorize: input.reauthorizeAccountId !== undefined,
          ...(input.provider === 'imap' ? { flow: 'imap_credentials' as const } : { flow: 'hosted' as const }),
          stage: connectionStage,
          oauthApp: configuredOAuthAppKind(deps.config, input.provider),
        }),
      );
      let existing = input.reauthorizeAccountId ? deps.registry.getAccount(input.reauthorizeAccountId) : undefined;
      if (!existing && input.provider === 'imap' && input.email) {
        existing = deps.registry
          .listAccounts()
          .find((account) => account.email.toLowerCase() === input.email!.toLowerCase());
      }
      setOperationProperties(c, { reauthorize: existing !== undefined });
      if (existing && !canManageOwnedAccount(principal, existing)) {
        throw new EmailError('permission_denied', 'Only the mailbox owner or an administrator can reauthorize it.');
      }
      if (existing && existing.provider !== input.provider) {
        throw new EmailError(
          'invalid_request',
          `Account ${existing.id} uses ${existing.provider}, not ${input.provider}.`,
        );
      }
      if (!existing) deps.registry.assertCanAddAccount();
      const intent = existing
        ? { reauthorizeAccountId: existing.id }
        : { ownerMemberId: principal.memberId, sharedWithAll: false, grantedMemberIds: [] };
      if (input.provider === 'gmail' || input.provider === 'outlook') {
        connectionStage = 'oauth_prepare';
        setOperationProperties(c, { connection_stage: connectionStage });
        const prepared =
          input.provider === 'gmail'
            ? prepareHostedGmailConnection(deps.db, deps.config, intent)
            : prepareHostedOutlookConnection(deps.db, deps.config, intent);
        audit(deps, principal, 'account.connection.prepare', 'success');
        return c.json(
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
      if (!input.email || !input.imap || !input.smtp) {
        throw new EmailError('invalid_request', 'email, imap, and smtp are required for an IMAP connection.');
      }
      const previous = existing?.provider === 'imap' ? deps.registry.loadImapCredentials(existing.id) : undefined;
      const credentials: ImapCredentials = {
        imap: input.imap,
        smtp: input.smtp,
        saveSent: input.saveSent ?? previous?.saveSent ?? true,
        folderOverrides: { ...previous?.folderOverrides, ...input.folderOverrides },
      };
      connectionStage = 'provider_check';
      setOperationProperties(c, { connection_stage: connectionStage });
      const warnings = await deps.registry.testImapCredentials(input.email, credentials, input.displayName);
      connectionStage = 'account_persist';
      setOperationProperties(c, { connection_stage: connectionStage });
      const account = deps.registry.addImapAccount(
        input.email,
        credentials,
        input.displayName,
        existing ? undefined : principal.memberId,
        existing?.id,
        existing ? undefined : { sharedWithAll: false },
      );
      audit(deps, principal, 'account.connection.save', 'success', { type: 'account', id: account.id });
      connectionStage = 'complete';
      setOperationProperties(c, { connection_stage: connectionStage, ...accountInventoryProperties(deps.registry) });
      return c.json({ data: { account, warnings } }, 201);
    } catch (error) {
      return jsonError(c, error, { requestId, connectionStage });
    }
  });

  const removeOwnAccountRoute = createRoute({
    method: 'delete',
    path: '/api/v1/accounts/{accountId}/connection',
    operationId: 'removeOwnAccount',
    summary: 'Remove a mailbox account owned by the current member',
    request: { params: accountParams },
    ...sessionRoute,
    responses,
  });
  app.openapi(removeOwnAccountRoute, (c) => {
    const principal = c.get('restAuth') as Principal;
    try {
      requireSession(principal);
      if (!deps.registry) throw new EmailError('unsupported_capability', 'Account management is unavailable.');
      const account = deps.registry.getAccount(c.req.valid('param').accountId);
      if (!canManageOwnedAccount(principal, account)) {
        throw new EmailError('permission_denied', 'Only the mailbox owner or an administrator can remove it.');
      }
      deps.registry.removeAccount(account.id);
      audit(deps, principal, 'account.remove', 'success', { type: 'account', id: account.id });
      setOperationProperties(c, { provider: account.provider, ...accountInventoryProperties(deps.registry) });
      return c.json({ data: { removed: account.id } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const configureOwnFoldersRoute = createRoute({
    method: 'patch',
    path: '/api/v1/accounts/{accountId}/imap/folders',
    operationId: 'updateOwnedImapFolders',
    summary: 'Update folder settings for an owned IMAP mailbox',
    request: {
      params: accountParams,
      body: { required: true, content: { 'application/json': { schema: folderPatch } } },
    },
    ...sessionRoute,
    responses: { ...responses, ...providerResponses },
  });
  app.openapi(configureOwnFoldersRoute, async (c) => {
    const principal = c.get('restAuth') as Principal;
    try {
      requireSession(principal);
      if (!deps.registry) throw new EmailError('unsupported_capability', 'Account management is unavailable.');
      const account = deps.registry.getAccount(c.req.valid('param').accountId);
      if (!canManageOwnedAccount(principal, account)) {
        throw new EmailError('permission_denied', 'Only the mailbox owner or an administrator can configure it.');
      }
      if (account.provider !== 'imap')
        throw new EmailError('invalid_request', 'Folder overrides are only available for IMAP mailboxes.');
      const patch = c.req.valid('json');
      const current = deps.registry.loadImapCredentials(account.id);
      const nextOverrides = { ...current.folderOverrides };
      for (const role of folderRoles) {
        if (!(role in patch)) continue;
        const value = patch[role];
        if (value === null) delete nextOverrides[role];
        else if (value !== undefined) nextOverrides[role] = value;
      }
      const proposed = { ...current, folderOverrides: nextOverrides };
      const warnings = await deps.registry.testImapFolderOverrides(account.email, proposed, account.displayName);
      const invalid = warnings.find(
        (warning) => warning.reason === 'stale_override' && typeof patch[warning.role] === 'string',
      );
      if (invalid) throw new EmailError('invalid_request', invalid.message);
      deps.registry.saveImapCredentials(account.id, proposed);
      audit(deps, principal, 'account.folders.update', 'success', { type: 'account', id: account.id });
      return c.json({ data: { accountId: account.id, folderOverrides: nextOverrides, warnings } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const listMembersRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/members',
    operationId: 'listMembers',
    summary: 'List members',
    ...protectedRoute,
    responses,
  });
  app.openapi(listMembersRoute, (c) => {
    try {
      requireAdministrator(c.get('restAuth'), 'admin.members');
      return c.json({ data: listMembers(deps.db).map(memberData) }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const createMemberRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/members',
    operationId: 'createMember',
    summary: 'Create and invite a member',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z
              .object({ name: z.string().trim().min(1), email: z.string().email(), role: z.enum(['admin', 'member']) })
              .strict(),
          },
        },
      },
    },
    ...protectedRoute,
    responses: { ...responses, 201: responses[200] },
  });
  app.openapi(createMemberRoute, (c) => {
    const principal = c.get('restAuth') as Principal;
    try {
      requireAdministrator(principal, 'admin.members');
      const member = addMember(deps.db, { ...c.req.valid('json'), status: 'pending' });
      const invitation = issueMemberAuthToken(deps.db, {
        memberId: member.id,
        kind: 'enrollment',
        createdByMemberId: principal.memberId,
      });
      audit(deps, principal, 'member.create', 'success', { type: 'member', id: member.id });
      return c.json({ data: { ...memberData(member), invitation } }, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const patchMemberRoute = createRoute({
    method: 'patch',
    path: '/api/v1/admin/members/{memberId}',
    operationId: 'updateMember',
    summary: 'Update a member',
    request: {
      params: memberParams,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z
              .object({
                name: z.string().trim().min(1).optional(),
                email: z.string().email().optional(),
                role: z.enum(['admin', 'member']).optional(),
                status: z.enum(['active', 'suspended']).optional(),
              })
              .strict(),
          },
        },
      },
    },
    ...protectedRoute,
    responses,
  });
  app.openapi(patchMemberRoute, (c) => {
    const principal = c.get('restAuth') as Principal;
    try {
      requireAdministrator(principal, 'admin.members');
      const { memberId } = c.req.valid('param');
      const update = c.req.valid('json');
      if (update.status === 'active') {
        const member = findMember(deps.db, memberId);
        const credential = deps.db
          .select()
          .from(memberCredentials)
          .where(eq(memberCredentials.memberId, member.id))
          .get();
        if (!credential) throw new EmailError('invalid_request', 'The member must enroll before becoming active.');
      }
      const member = updateMember(deps.db, memberId, update);
      audit(deps, principal, 'member.update', 'success', { type: 'member', id: member.id });
      return c.json({ data: memberData(member) }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const deleteMemberRoute = createRoute({
    method: 'delete',
    path: '/api/v1/admin/members/{memberId}',
    operationId: 'deleteMember',
    summary: 'Remove a member',
    request: { params: memberParams },
    ...protectedRoute,
    responses,
  });
  app.openapi(deleteMemberRoute, (c) => {
    const principal = c.get('restAuth') as Principal;
    try {
      requireAdministrator(principal, 'admin.members');
      const member = findMember(deps.db, c.req.valid('param').memberId);
      removeMember(deps.db, member.id);
      audit(deps, principal, 'member.remove', 'success', { type: 'member', id: member.id });
      return c.json({ data: { removed: member.id } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  for (const [suffix, kind] of [
    ['invitation', 'enrollment'],
    ['password-reset', 'password_reset'],
  ] as const) {
    const route = createRoute({
      method: 'post',
      path: `/api/v1/admin/members/{memberId}/${suffix}`,
      operationId: kind === 'enrollment' ? 'inviteMember' : 'createMemberPasswordReset',
      summary: kind === 'enrollment' ? 'Issue a member invitation' : 'Issue a member password reset',
      request: { params: memberParams },
      ...protectedRoute,
      responses: { ...responses, 201: responses[200] },
    });
    app.openapi(route, (c) => {
      const principal = c.get('restAuth') as Principal;
      try {
        requireAdministrator(principal, 'admin.members');
        const member = findMember(deps.db, c.req.valid('param').memberId);
        const token = issueMemberAuthToken(deps.db, {
          memberId: member.id,
          kind,
          createdByMemberId: principal.memberId,
        });
        audit(deps, principal, `member.${kind}`, 'success', { type: 'member', id: member.id });
        return c.json({ data: token }, 201);
      } catch (error) {
        return jsonError(c, error);
      }
    });
  }

  const listMemberSessionsRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/members/{memberId}/sessions',
    operationId: 'listMemberSessions',
    summary: "List a member's sessions",
    request: { params: memberParams },
    ...protectedRoute,
    responses,
  });
  app.openapi(listMemberSessionsRoute, (c) => {
    try {
      requireAdministrator(c.get('restAuth'), 'admin.members');
      const member = findMember(deps.db, c.req.valid('param').memberId);
      return c.json({ data: listMemberSessions(deps.db, member.id) }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const revokeMemberSessionRoute = createRoute({
    method: 'delete',
    path: '/api/v1/admin/members/{memberId}/sessions/{sessionId}',
    operationId: 'revokeMemberSession',
    summary: "Revoke a member's session",
    request: { params: memberSessionParams },
    ...protectedRoute,
    responses,
  });
  app.openapi(revokeMemberSessionRoute, (c) => {
    const principal = c.get('restAuth') as Principal;
    try {
      requireAdministrator(principal, 'admin.members');
      const { memberId, sessionId } = c.req.valid('param');
      const member = findMember(deps.db, memberId);
      if (!revokeSession(deps.db, member.id, sessionId)) throw new EmailError('not_found', 'Session not found.');
      audit(deps, principal, 'member.session.revoke', 'success', { type: 'session', id: sessionId });
      return c.json({ data: { revoked: sessionId } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const listAdminAccountsRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/accounts',
    operationId: 'listAdminAccounts',
    summary: 'List all mailbox account metadata',
    ...protectedRoute,
    responses,
  });
  app.openapi(listAdminAccountsRoute, (c) => {
    try {
      const principal = c.get('restAuth') as Principal;
      requireAdministrator(principal, 'admin.accounts');
      return c.json(
        { data: (deps.registry?.listAccounts() ?? []).filter((account) => canSeeAccountMetadata(principal, account)) },
        200,
      );
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const patchAdminAccountRoute = createRoute({
    method: 'patch',
    path: '/api/v1/admin/accounts/{accountId}',
    operationId: 'updateAccountAccess',
    summary: 'Update mailbox ownership and access',
    request: {
      params: accountParams,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z
              .object({
                ownerMemberId: z.string().optional(),
                sharedWithAll: z.boolean().optional(),
                grantedMemberIds: z.array(z.string()).optional(),
              })
              .strict(),
          },
        },
      },
    },
    ...protectedRoute,
    responses,
  });
  app.openapi(patchAdminAccountRoute, (c) => {
    const principal = c.get('restAuth') as Principal;
    try {
      requireAdministrator(principal, 'admin.accounts');
      if (!deps.registry) throw new EmailError('unsupported_capability', 'Account management is unavailable.');
      const { accountId } = c.req.valid('param');
      const input = c.req.valid('json');
      let account = deps.registry.getAccount(accountId);
      if (!canSeeAccountMetadata(principal, account)) throw new EmailError('not_found', 'Mailbox not found.');
      if (input.ownerMemberId)
        account = deps.registry.assignAccountOwner(account.id, findMember(deps.db, input.ownerMemberId).id);
      if (input.sharedWithAll !== undefined || input.grantedMemberIds !== undefined) {
        account = deps.registry.setAccountAccess(account.id, {
          sharedWithAll: input.sharedWithAll ?? account.sharedWithAll,
          grantedMemberIds: (input.grantedMemberIds ?? account.grantedMemberIds).map(
            (ref: string) => findMember(deps.db, ref).id,
          ),
        });
      }
      audit(deps, principal, 'account.access.update', 'success', { type: 'account', id: account.id });
      return c.json({ data: account }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const deleteAdminAccountRoute = createRoute({
    method: 'delete',
    path: '/api/v1/admin/accounts/{accountId}',
    operationId: 'deleteAdminAccount',
    summary: 'Remove a mailbox account',
    request: { params: accountParams },
    ...protectedRoute,
    responses,
  });
  app.openapi(deleteAdminAccountRoute, (c) => {
    const principal = c.get('restAuth') as Principal;
    try {
      requireAdministrator(principal, 'admin.accounts');
      if (!deps.registry) throw new EmailError('unsupported_capability', 'Account management is unavailable.');
      const { accountId } = c.req.valid('param');
      const account = deps.registry.getAccount(accountId);
      if (!canSeeAccountMetadata(principal, account)) throw new EmailError('not_found', 'Mailbox not found.');
      deps.registry.removeAccount(accountId);
      audit(deps, principal, 'account.remove', 'success', { type: 'account', id: accountId });
      setOperationProperties(c, { provider: account.provider, ...accountInventoryProperties(deps.registry) });
      return c.json({ data: { removed: accountId } }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  const auditRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/audit-events',
    operationId: 'listAuditEvents',
    summary: 'List security audit events',
    request: { query: z.object({ limit: z.string().regex(/^\d+$/).optional() }) },
    ...protectedRoute,
    responses,
  });
  app.openapi(auditRoute, (c) => {
    try {
      requireAdministrator(c.get('restAuth'), 'admin.audit');
      const limit = Number(c.req.valid('query').limit ?? 100);
      return c.json({ data: listAdminAuditEvents(deps.db, limit) }, 200);
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
