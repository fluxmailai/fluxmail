import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { EmailError, isEmailError } from '@fluxmail/core';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ConfigurationService, FluxmailConfig } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import type { AccountRegistry } from '../accounts/registry.js';
import type { EmailService } from '../service/emailService.js';
import { authenticateBearer, type ApiKeyPrincipal, type Principal } from '../auth.js';
import { buildMcpServer } from '../mcp/buildServer.js';
import {
  buildAuthUrl,
  createOAuthClient,
  exchangeCode,
  gmailScopes,
  requireHostedGoogleConfig,
} from '../accounts/googleAuth.js';
import {
  claimGmailConnectionGrant,
  claimOutlookConnectionGrant,
  inspectGmailConnectionGrant,
  inspectOutlookConnectionGrant,
  type GmailConnectionGrantStatus,
  type GmailConnectionIntent,
} from '../storage/gmailConnectionGrants.js';
import { buildMicrosoftAuthUrl, exchangeMicrosoftCode, requireMicrosoftConfig } from '../accounts/microsoftAuth.js';
import { prepareHostedGmailConnection, prepareHostedOutlookConnection } from '../accounts/gmailConnection.js';
import { VERSION } from '../version.js';
import { captureOperation, type OperationOutcome, type Telemetry } from '../telemetry.js';
import { accountInventoryProperties, connectionProperties, oauthAppKind } from '../accounts/telemetry.js';
import { findMember } from '../storage/members.js';
import { createRestApi } from './rest.js';
import { canAdminister, canSeeAccountMetadata } from '../authorization.js';
import type { LicenseController } from '../licensing/refresher.js';
import { administrationUsesHttps as administrationRequestUsesHttps, requestBodyExceedsLimit } from './admin.js';
import { recordAdminAuditEvent } from '../storage/adminAudit.js';
import type { StoredGoogleOAuthApp, StoredMicrosoftOAuthApp } from '../instanceConfig.js';
import { logCodedFailure, logFailure, type Logger } from '../logging.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface AppDeps {
  config: FluxmailConfig;
  configuration: ConfigurationService;
  db: FluxmailDb;
  registry: AccountRegistry;
  service: EmailService;
  telemetry?: Telemetry;
  logger?: Logger;
  licenseController?: LicenseController;
}

export function createApp(deps: AppDeps): Hono<{ Bindings: HttpBindings }> {
  const { config, configuration, db, registry, service, telemetry, logger, licenseController } = deps;
  const app = new Hono<{ Bindings: HttpBindings }>();
  const googleOauthStates = new Map<
    string,
    { expiresAt: number; oauthClient: StoredGoogleOAuthApp; intent?: GmailConnectionIntent }
  >();
  const microsoftOauthStates = new Map<
    string,
    {
      expiresAt: number;
      verifier: string;
      oauthClient: StoredMicrosoftOAuthApp;
      intent?: GmailConnectionIntent;
    }
  >();

  const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (char) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[char]!;
    });

  const connectionLinkPage = (title: string, message: string): string =>
    `<html><body style="font-family: sans-serif"><h2>${title}</h2><p>${message}</p></body></html>`;

  const connectionLinkError = (
    status: Exclude<GmailConnectionGrantStatus, 'available'>,
    providerName: 'Gmail' | 'Outlook',
    providerCommand: 'gmail' | 'outlook',
  ): { html: string; status: 400 | 410 } => {
    if (status === 'expired') {
      return {
        html: connectionLinkPage(
          `This ${providerName} connection link has expired`,
          'Run the Fluxmail command again to get a new link.',
        ),
        status: 410,
      };
    }
    if (status === 'used') {
      return {
        html: connectionLinkPage(
          `This ${providerName} connection link has already been used`,
          `Run "fluxmail accounts add ${providerCommand}" again if you still need to connect ${providerName}.`,
        ),
        status: 410,
      };
    }
    return {
      html: connectionLinkPage(
        `This ${providerName} connection link is invalid`,
        'Run the Fluxmail command again to get a new link.',
      ),
      status: 400,
    };
  };

  const connectionConfirmationPage = (
    providerName: 'Gmail' | 'Outlook',
    identityProvider: 'Google' | 'Microsoft',
  ): string =>
    `<html><body style="font-family: sans-serif"><h2>Connect ${providerName} to Fluxmail</h2>` +
    `<p>Continue to ${identityProvider} to choose the account you want to connect.</p>` +
    '<form method="post">' +
    `<button type="submit">Continue with ${identityProvider}</button></form></body></html>`;

  /**
   * Record the browser flow that completes a hosted connection. The CLI and REST
   * routes only mint the link, so this is where a hosted mailbox is linked.
   */
  const captureHostedConnection = (
    provider: 'gmail' | 'outlook',
    startedAt: number,
    outcome: OperationOutcome,
    details: { reauthorize?: boolean; clientId?: string; errorCode?: string; linked?: boolean } = {},
  ): void => {
    captureOperation(telemetry, {
      productSurface: 'rest',
      operation: 'completeHostedConnection',
      outcome,
      durationMs: performance.now() - startedAt,
      ...(details.errorCode ? { errorCode: details.errorCode } : {}),
      properties: {
        ...connectionProperties({
          provider,
          reauthorize: details.reauthorize ?? false,
          flow: 'hosted',
          oauthApp: oauthAppKind(provider, details.clientId),
          ...(details.linked ? { stage: 'complete' as const } : {}),
        }),
        ...(details.linked ? accountInventoryProperties(registry) : {}),
      },
    });
  };

  const beginGoogleOAuth = (intent?: GmailConnectionIntent): string => {
    const oauthClient = { ...requireHostedGoogleConfig(config) };
    const now = Date.now();
    for (const [state, pending] of googleOauthStates) {
      if (pending.expiresAt < now) googleOauthStates.delete(state);
    }
    const state = randomBytes(16).toString('hex');
    googleOauthStates.set(state, {
      expiresAt: now + OAUTH_STATE_TTL_MS,
      oauthClient,
      ...(intent ? { intent } : {}),
    });
    const client = createOAuthClient(config, `${config.publicUrl}/auth/google/callback`, oauthClient);
    return buildAuthUrl(client, state, gmailScopes(config, oauthClient));
  };

  const beginMicrosoftOAuth = (intent?: GmailConnectionIntent): string => {
    const oauthClient = { ...requireMicrosoftConfig(config) };
    if (!oauthClient.clientSecret) {
      throw new EmailError('invalid_request', 'MICROSOFT_CLIENT_SECRET is required for hosted Outlook connections.');
    }
    const now = Date.now();
    for (const [state, pending] of microsoftOauthStates) {
      if (pending.expiresAt < now) microsoftOauthStates.delete(state);
    }
    const state = randomBytes(16).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    microsoftOauthStates.set(state, {
      expiresAt: now + OAUTH_STATE_TTL_MS,
      verifier,
      oauthClient,
      ...(intent ? { intent } : {}),
    });
    return buildMicrosoftAuthUrl(config, `${config.publicUrl}/auth/microsoft/callback`, state, verifier, oauthClient);
  };

  // Legacy connection routes use the same administrator policy as the REST API.
  const adminAuth = (c: { req: { header(name: string): string | undefined } }): Principal | null => {
    const authorization = c.req.header('authorization');
    const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    return bearer ? authenticateBearer(db, bearer) : null;
  };

  const canAdministerAccounts = (auth: Principal): boolean => canAdminister(auth, 'admin.accounts');

  const administrationUsesHttps = (c: { req: { raw: Request }; env?: Partial<HttpBindings> }): boolean =>
    administrationRequestUsesHttps(
      c.req.raw,
      {
        remoteAddress: c.env?.incoming?.socket.remoteAddress,
        encrypted: Boolean((c.env?.incoming?.socket as { encrypted?: boolean } | undefined)?.encrypted),
      },
      config.trustProxy,
    );

  // Authenticate an MCP request. The service applies member grants and the key's
  // optional mailbox allowlist before any provider call.
  const authForRequest = (c: { req: { header(name: string): string | undefined } }): ApiKeyPrincipal | null => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const principal = bearer ? authenticateBearer(db, bearer) : null;
    return principal?.kind === 'api_key' ? principal : null;
  };

  app.use('/auth/connections', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    return next();
  });

  app.post('/auth/connections', async (c) => {
    const auth = adminAuth(c);
    if (!auth) return c.json({ error: 'An administrator session or API key is required.' }, 401);

    const audit = (outcome: 'success' | 'error', errorCode?: string): void => {
      try {
        recordAdminAuditEvent(db, {
          operation: 'post /auth/connections',
          outcome,
          actorKeyId: auth.kind === 'api_key' ? auth.keyId : undefined,
          actorSessionId: auth.kind === 'session' ? auth.sessionId : undefined,
          actorMemberId: auth.memberId,
          ...(errorCode ? { errorCode } : {}),
        });
      } catch {
        // Auditing must not replace the API response.
      }
    };
    if (!canAdministerAccounts(auth)) {
      audit('error', 'permission_denied');
      return c.json({ error: 'The API key cannot manage accounts.' }, 403);
    }
    if (!administrationUsesHttps(c)) {
      audit('error', 'https_required');
      return c.json({ error: 'Administrative routes require HTTPS outside loopback.' }, 400);
    }
    const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      audit('error', 'unsupported_media_type');
      return c.json({ error: 'Content-Type must be application/json.' }, 415);
    }
    if (await requestBodyExceedsLimit(c.req.raw)) {
      audit('error', 'request_too_large');
      return c.json({ error: 'Request body is limited to 64 KiB.' }, 413);
    }

    let input: {
      provider?: unknown;
      ownerMemberId?: unknown;
      reauthorizeAccountId?: unknown;
      sharedWithAll?: unknown;
      grantedMemberIds?: unknown;
    };
    try {
      input = await c.req.json();
    } catch {
      audit('error', 'invalid_request');
      return c.json({ error: 'Request body must be valid JSON.' }, 400);
    }

    try {
      if (input.provider !== 'gmail' && input.provider !== 'outlook') {
        throw new EmailError('invalid_request', 'provider must be "gmail" or "outlook".');
      }
      if (input.sharedWithAll !== undefined && typeof input.sharedWithAll !== 'boolean') {
        throw new EmailError('invalid_request', 'sharedWithAll must be a boolean.');
      }
      const reauthorizeAccountId =
        typeof input.reauthorizeAccountId === 'string' ? input.reauthorizeAccountId.trim() : undefined;
      const ownerRef = typeof input.ownerMemberId === 'string' ? input.ownerMemberId.trim() : undefined;
      if ((reauthorizeAccountId?.length ?? 0) > 200 || (ownerRef?.length ?? 0) > 200) {
        throw new EmailError('invalid_request', 'Account and member references are limited to 200 characters.');
      }
      if (input.grantedMemberIds !== undefined && !Array.isArray(input.grantedMemberIds)) {
        throw new EmailError('invalid_request', 'grantedMemberIds must be an array of member ids or email addresses.');
      }
      if ((input.grantedMemberIds?.length ?? 0) > 100) {
        throw new EmailError('invalid_request', 'grantedMemberIds is limited to 100 members.');
      }
      const grantedMemberIds = (input.grantedMemberIds ?? []).map((value) => {
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
          throw new EmailError('invalid_request', 'grantedMemberIds must contain member ids or email addresses.');
        }
        return value.trim();
      });

      if (reauthorizeAccountId && (ownerRef || input.sharedWithAll !== undefined || grantedMemberIds.length)) {
        throw new EmailError(
          'invalid_request',
          'ownerMemberId and access settings cannot be combined with reauthorizeAccountId.',
        );
      }

      let intent: GmailConnectionIntent;
      if (reauthorizeAccountId) {
        const existing = registry.getAccount(reauthorizeAccountId);
        if (!canSeeAccountMetadata(auth, existing)) throw new EmailError('not_found', 'Mailbox not found.');
        if (existing.provider !== input.provider) {
          throw new EmailError(
            'invalid_request',
            `Account ${existing.id} uses ${existing.provider}, not ${input.provider}.`,
          );
        }
        intent = { reauthorizeAccountId: existing.id };
      } else {
        if (auth.accountIds !== null) {
          throw new EmailError('permission_denied', 'This API key is limited to existing mailboxes.');
        }
        if (!ownerRef) throw new EmailError('invalid_request', 'ownerMemberId is required for a new mailbox.');
        registry.assertCanAddAccount();
        const owner = findMember(db, ownerRef);
        intent = {
          ownerMemberId: owner.id,
          sharedWithAll: input.sharedWithAll === true,
          grantedMemberIds: grantedMemberIds.map((ref) => findMember(db, ref).id),
        };
      }

      const prepared =
        input.provider === 'gmail'
          ? prepareHostedGmailConnection(db, config, intent)
          : prepareHostedOutlookConnection(db, config, intent);
      audit('success');
      return c.json(
        {
          provider: input.provider,
          connectionUrl: prepared.connectionUrl,
          expiresAt: new Date(prepared.expiresAt).toISOString(),
        },
        201,
      );
    } catch (err) {
      logFailure(logger, 'rest.operation_failed', err, {
        productSurface: 'rest',
        operation: 'createLegacyConnection',
      });
      if (isEmailError(err)) {
        audit('error', err.code);
        return c.json({ error: err.message }, 400);
      }
      audit('error', 'internal');
      return c.json({ error: 'Could not create the connection link.' }, 500);
    }
  });

  app.get('/healthz', (c) => c.json({ ok: true, name: 'fluxmail', version: VERSION }));

  // Stateless Streamable HTTP: a fresh server+transport pair per request.
  app.post('/mcp', async (c) => {
    const auth = authForRequest(c);
    if (!auth) {
      logCodedFailure(logger, 'mcp.request_rejected', 'unauthorized', 'MCP request was not authorized', {
        productSurface: 'mcp',
        operation: 'request',
      });
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: pass an API key as a Bearer token' },
          id: null,
        },
        401,
      );
    }
    const bodyLimit = Math.ceil((config.maxAttachmentBytes * 4) / 3) + 2 * 1024 * 1024;
    if (await requestBodyExceedsLimit(c.req.raw, bodyLimit)) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32600, message: 'Request body exceeds the size limit.' }, id: null },
        413,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      logCodedFailure(logger, 'mcp.request_rejected', 'invalid_request', 'MCP request body was not valid JSON', {
        productSurface: 'mcp',
        operation: 'request',
      });
      return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400);
    }
    const server = buildMcpServer(service.withPrincipal(auth), {
      permissions: auth.permissions,
      ...(auth.kind === 'api_key' ? { permissionSource: { kind: 'api_key' as const, keyId: auth.keyId } } : {}),
      maxAttachmentBytes: config.maxAttachmentBytes,
      telemetry,
      transport: 'http',
      logger,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      // Keep the JSON response promise alive until the operation finishes, even
      // if the client disconnects. Closing the transport early abandons that
      // promise and prevents the runtime from draining this request.
      await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
    } finally {
      await server.close();
    }
    return RESPONSE_ALREADY_SENT;
  });

  const methodNotAllowed = (c: { json: (o: unknown, s: 405) => Response }) =>
    c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this server runs in stateless mode' },
        id: null,
      },
      405,
    );
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // Server-hosted OAuth flow (for remote deployments; the CLI uses a loopback flow instead).
  app.get('/auth/google', (c) => {
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    if (!administrationUsesHttps(c)) return c.text('Administrative routes require HTTPS outside loopback.', 400);
    const auth = adminAuth(c);
    if (!auth) {
      return c.text('Unauthorized: pass an administrator session or API key as a Bearer token.', 401);
    }
    if (!canAdministerAccounts(auth)) return c.text('Forbidden.', 403);
    if (auth.accountIds !== null) return c.text('This API key is limited to existing mailboxes.', 403);
    const ownerRef = c.req.query('owner');
    if (!ownerRef) {
      return c.text('Missing owner. Start the hosted connection with "fluxmail accounts add gmail".', 400);
    }
    try {
      const owner = findMember(db, ownerRef);
      return c.redirect(beginGoogleOAuth({ ownerMemberId: owner.id, sharedWithAll: false }));
    } catch (err) {
      logFailure(logger, 'oauth.google_start_failed', err);
      return c.text(err instanceof Error ? err.message : String(err), 400);
    }
  });

  // Hono falls back to GET handlers for HEAD requests. Handle HEAD explicitly
  // so link previews and security scanners cannot consume a one-time grant.
  app.use('/auth/google/connect', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.req.method === 'HEAD' ? c.body(null, 204) : next();
  });

  app.get('/auth/google/connect', (c) => {
    const token = c.req.query('token');
    if (!token) {
      const error = connectionLinkError('invalid', 'Gmail', 'gmail');
      return c.html(error.html, error.status);
    }
    const status = inspectGmailConnectionGrant(db, token);
    if (status !== 'available') {
      const error = connectionLinkError(status, 'Gmail', 'gmail');
      return c.html(error.html, error.status);
    }
    return c.html(connectionConfirmationPage('Gmail', 'Google'));
  });

  app.post('/auth/google/connect', (c) => {
    const token = c.req.query('token');
    if (!token) {
      const error = connectionLinkError('invalid', 'Gmail', 'gmail');
      return c.html(error.html, error.status);
    }
    const claim = claimGmailConnectionGrant(db, token);
    if (claim.status !== 'claimed') {
      const error = connectionLinkError(claim.status, 'Gmail', 'gmail');
      return c.html(error.html, error.status);
    }
    return c.redirect(beginGoogleOAuth(claim.grant));
  });

  app.get('/auth/google/callback', async (c) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    const startedAt = performance.now();
    const finishActivity = telemetry?.beginActivity?.();
    const state = c.req.query('state');
    const pending = state ? googleOauthStates.get(state) : undefined;
    const failConnection = (errorCode: string, message: string, status: 400 | 500) => {
      captureHostedConnection('gmail', startedAt, 'error', {
        errorCode,
        reauthorize: pending?.intent?.reauthorizeAccountId !== undefined,
        clientId: pending?.oauthClient.clientId,
      });
      finishActivity?.();
      return c.text(message, status);
    };
    if (!state || !pending || pending.expiresAt < Date.now()) {
      return failConnection(
        'invalid_state',
        'Invalid or expired OAuth state. Start the Gmail connection flow again.',
        400,
      );
    }
    googleOauthStates.delete(state);
    const error = c.req.query('error');
    if (error) return failConnection('provider_error', `Google returned an error: ${error}`, 400);
    const code = c.req.query('code');
    if (!code) return failConnection('missing_code', 'Missing code parameter.', 400);

    const client = createOAuthClient(config, `${config.publicUrl}/auth/google/callback`, pending.oauthClient);
    try {
      const { email, displayName, tokens } = await exchangeCode(client, code);
      const reauthorizeAccount = pending.intent?.reauthorizeAccountId
        ? registry.getAccount(pending.intent.reauthorizeAccountId)
        : undefined;
      if (reauthorizeAccount?.provider !== undefined && reauthorizeAccount.provider !== 'gmail') {
        throw new EmailError('invalid_request', `Account ${reauthorizeAccount.id} does not use Gmail.`);
      }
      if (reauthorizeAccount && reauthorizeAccount.email !== email) {
        throw new EmailError(
          'invalid_request',
          `Google authorized ${email}, but account ${reauthorizeAccount.id} belongs to ${reauthorizeAccount.email}. ` +
            'Try again and choose the matching Google account.',
        );
      }
      const duplicate = registry
        .listAccounts()
        .find((candidate) => candidate.email.toLowerCase() === email.toLowerCase());
      if (duplicate && !reauthorizeAccount && pending.intent?.ownerMemberId !== duplicate.ownerMemberId) {
        throw new EmailError('permission_denied', 'This mailbox is already owned by another member.');
      }
      const account = registry.addGmailAccount(
        email,
        tokens,
        displayName,
        pending.intent?.ownerMemberId,
        {
          sharedWithAll: pending.intent?.sharedWithAll ?? false,
          grantedMemberIds: pending.intent?.grantedMemberIds ?? [],
        },
        pending.oauthClient,
      );
      recordAdminAuditEvent(db, {
        operation: 'account.connection.complete',
        outcome: 'success',
        actorMemberId: pending.intent?.ownerMemberId ?? account.ownerMemberId,
        resourceType: 'account',
        resourceId: account.id,
      });
      captureHostedConnection('gmail', startedAt, 'success', {
        reauthorize: reauthorizeAccount !== undefined || duplicate !== undefined,
        clientId: pending.oauthClient.clientId,
        linked: true,
      });
      return c.html(
        `<html><body style="font-family: sans-serif"><h2>${escapeHtml(email)} is connected to Fluxmail</h2>` +
          `<p>Account id: <code>${escapeHtml(account.id)}</code>. You can close this tab.</p></body></html>`,
      );
    } catch (err) {
      logFailure(logger, 'oauth.google_callback_failed', err);
      // Surface why connecting failed (expired code, missing refresh token,
      // account limit) instead of a blank 500 the user cannot act on.
      if (isEmailError(err)) {
        return failConnection(err.code, `Could not connect the account: ${err.message}`, 400);
      }
      return failConnection('internal', 'Could not connect the account; check the server logs.', 500);
    } finally {
      finishActivity?.();
    }
  });

  app.get('/auth/microsoft', (c) => {
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    if (!administrationUsesHttps(c)) return c.text('Administrative routes require HTTPS outside loopback.', 400);
    const auth = adminAuth(c);
    if (!auth) {
      return c.text('Unauthorized: pass an administrator session or API key as a Bearer token.', 401);
    }
    if (!canAdministerAccounts(auth)) return c.text('Forbidden.', 403);
    if (auth.accountIds !== null) return c.text('This API key is limited to existing mailboxes.', 403);
    const ownerRef = c.req.query('owner');
    if (!ownerRef) {
      return c.text('Missing owner. Start the hosted connection with "fluxmail accounts add outlook".', 400);
    }
    try {
      const owner = findMember(db, ownerRef);
      return c.redirect(beginMicrosoftOAuth({ ownerMemberId: owner.id, sharedWithAll: false }));
    } catch (err) {
      logFailure(logger, 'oauth.microsoft_start_failed', err);
      return c.text(err instanceof Error ? err.message : String(err), 400);
    }
  });

  app.use('/auth/microsoft/connect', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.req.method === 'HEAD' ? c.body(null, 204) : next();
  });

  app.get('/auth/microsoft/connect', (c) => {
    const token = c.req.query('token');
    if (!token) {
      const error = connectionLinkError('invalid', 'Outlook', 'outlook');
      return c.html(error.html, error.status);
    }
    const status = inspectOutlookConnectionGrant(db, token);
    if (status !== 'available') {
      const error = connectionLinkError(status, 'Outlook', 'outlook');
      return c.html(error.html, error.status);
    }
    return c.html(connectionConfirmationPage('Outlook', 'Microsoft'));
  });

  app.post('/auth/microsoft/connect', (c) => {
    const token = c.req.query('token');
    if (!token) {
      const error = connectionLinkError('invalid', 'Outlook', 'outlook');
      return c.html(error.html, error.status);
    }
    const claim = claimOutlookConnectionGrant(db, token);
    if (claim.status !== 'claimed') {
      const error = connectionLinkError(claim.status, 'Outlook', 'outlook');
      return c.html(error.html, error.status);
    }
    return c.redirect(beginMicrosoftOAuth(claim.grant));
  });

  app.get('/auth/microsoft/callback', async (c) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    const startedAt = performance.now();
    const finishActivity = telemetry?.beginActivity?.();
    const state = c.req.query('state');
    const pending = state ? microsoftOauthStates.get(state) : undefined;
    const failConnection = (errorCode: string, message: string, status: 400 | 500) => {
      captureHostedConnection('outlook', startedAt, 'error', {
        errorCode,
        reauthorize: pending?.intent?.reauthorizeAccountId !== undefined,
        clientId: pending?.oauthClient.clientId,
      });
      finishActivity?.();
      return c.text(message, status);
    };
    if (!state || !pending || pending.expiresAt < Date.now()) {
      return failConnection(
        'invalid_state',
        'Invalid or expired OAuth state. Start the Outlook connection flow again.',
        400,
      );
    }
    microsoftOauthStates.delete(state);
    const error = c.req.query('error');
    if (error) {
      return failConnection(
        'provider_error',
        `Microsoft returned an error: ${c.req.query('error_description') ?? error}`,
        400,
      );
    }
    const code = c.req.query('code');
    if (!code) return failConnection('missing_code', 'Missing code parameter.', 400);

    try {
      const { email, displayName, credentials } = await exchangeMicrosoftCode(
        config,
        code,
        `${config.publicUrl}/auth/microsoft/callback`,
        pending.verifier,
        'confidential',
        pending.oauthClient,
      );
      const reauthorizeAccount = pending.intent?.reauthorizeAccountId
        ? registry.getAccount(pending.intent.reauthorizeAccountId)
        : undefined;
      if (reauthorizeAccount?.provider !== undefined && reauthorizeAccount.provider !== 'outlook') {
        throw new EmailError('invalid_request', `Account ${reauthorizeAccount.id} does not use Outlook.`);
      }
      if (reauthorizeAccount && reauthorizeAccount.email.toLowerCase() !== email.toLowerCase()) {
        throw new EmailError(
          'invalid_request',
          `Microsoft authorized ${email}, but account ${reauthorizeAccount.id} belongs to ${reauthorizeAccount.email}. ` +
            'Try again and choose the matching Microsoft account.',
        );
      }
      const duplicate = registry
        .listAccounts()
        .find((candidate) => candidate.email.toLowerCase() === email.toLowerCase());
      if (duplicate && !reauthorizeAccount && pending.intent?.ownerMemberId !== duplicate.ownerMemberId) {
        throw new EmailError('permission_denied', 'This mailbox is already owned by another member.');
      }
      const account = registry.addOutlookAccount(
        email,
        credentials,
        displayName,
        pending.intent?.ownerMemberId,
        pending.intent?.reauthorizeAccountId,
        {
          sharedWithAll: pending.intent?.sharedWithAll ?? false,
          grantedMemberIds: pending.intent?.grantedMemberIds ?? [],
        },
      );
      recordAdminAuditEvent(db, {
        operation: 'account.connection.complete',
        outcome: 'success',
        actorMemberId: pending.intent?.ownerMemberId ?? account.ownerMemberId,
        resourceType: 'account',
        resourceId: account.id,
      });
      captureHostedConnection('outlook', startedAt, 'success', {
        reauthorize: reauthorizeAccount !== undefined || duplicate !== undefined,
        clientId: pending.oauthClient.clientId,
        linked: true,
      });
      return c.html(
        `<html><body style="font-family: sans-serif"><h2>${escapeHtml(email)} is connected to Fluxmail</h2>` +
          `<p>Account id: <code>${escapeHtml(account.id)}</code>. You can close this tab.</p></body></html>`,
      );
    } catch (err) {
      logFailure(logger, 'oauth.microsoft_callback_failed', err);
      if (isEmailError(err)) {
        return failConnection(err.code, `Could not connect the account: ${err.message}`, 400);
      }
      return failConnection('internal', 'Could not connect the account; check the server logs.', 500);
    } finally {
      finishActivity?.();
    }
  });

  app.route(
    '/',
    createRestApi({
      config,
      configuration,
      db,
      service,
      telemetry,
      logger,
      registry,
      licenseController,
    }),
  );

  return app;
}
