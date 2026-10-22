import { Hono, type Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { isEmailError, type Account } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import type { AccountRegistry } from '../accounts/registry.js';
import { isBootstrapComplete, verifyMemberPassword } from '../auth.js';
import { memberCanAccessAccount } from '../authorization.js';
import { getMember } from '../storage/members.js';
import { FULL_PERMISSION_POLICY, type McpCapability } from '../permissions.js';
import {
  approveOAuthAuthorizationRequest,
  canonicalOAuthScopes,
  createOAuthAuthorizationRequest,
  deleteOAuthAuthorizationRequest,
  exchangeOAuthAuthorizationCode,
  getOAuthAuthorizationRequest,
  getOAuthClient,
  isOAuthScope,
  mailScopesOf,
  OAUTH_SCOPES,
  OFFLINE_ACCESS_SCOPE,
  refreshOAuthTokens,
  registerOAuthClient,
  reserveOAuthRateLimit,
  revokeOAuthToken,
  signInOAuthAuthorizationRequest,
  type OAuthAuthorizationRequest,
  type OAuthClient,
  type OAuthTokenSet,
} from '../storage/oauth.js';
import {
  fetchClientMetadata,
  isClientMetadataUrl,
  resolveMetadataClient,
  type MetadataFetcher,
} from '../oauth/clientMetadata.js';
import { redirectUriMatches, validateRedirectUri } from '../oauth/redirectUris.js';
import { captureOperation, type OperationOutcome, type Telemetry, type TelemetryProperties } from '../telemetry.js';
import { administrationUsesHttps, requestBodyExceedsLimit, requestClientAddress } from './admin.js';
import { OAUTH_PAGE_HEADERS, oauthApprovePage, oauthErrorPage, oauthSignInPage } from './oauthPages.js';

const REGISTRATIONS_PER_MINUTE = 5;
const TOKEN_REQUESTS_PER_MINUTE = 120;
const BODY_LIMIT = 64 * 1024;

/** Scopes a client receives when it asks for none: every mail scope except permanent deletion. */
export const DEFAULT_OAUTH_MAIL_SCOPES: McpCapability[] = mailScopesOf(FULL_PERMISSION_POLICY.capabilities);

export interface OAuthRouteDeps {
  config: FluxmailConfig;
  db: FluxmailDb;
  registry: AccountRegistry;
  telemetry?: Telemetry;
  metadataFetcher?: MetadataFetcher;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * The issuer is the public URL. OAuth is only offered over HTTPS, or over
 * plain HTTP when the public URL is a loopback address.
 */
export function oauthIssuer(config: Pick<FluxmailConfig, 'publicUrl'>): string | null {
  let url: URL;
  try {
    url = new URL(config.publicUrl);
  } catch {
    return null;
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return config.publicUrl.replace(/\/+$/, '');
  }
  return null;
}

/** The WWW-Authenticate challenge for an unauthenticated MCP request. */
export function mcpAuthenticateChallenge(config: Pick<FluxmailConfig, 'publicUrl'>): string {
  const issuer = oauthIssuer(config);
  if (!issuer) return 'Bearer';
  const scope = [...DEFAULT_OAUTH_MAIL_SCOPES, OFFLINE_ACCESS_SCOPE].join(' ');
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`;
}

type OAuthContext = Context<{ Bindings: HttpBindings }>;

type ProtocolError =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'invalid_target'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'access_denied'
  | 'login_required'
  | 'temporarily_unavailable'
  | 'slow_down';

export function createOAuthRoutes(deps: OAuthRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const { config, db, registry, telemetry } = deps;
  const fetcher = deps.metadataFetcher ?? fetchClientMetadata;
  const app = new Hono<{ Bindings: HttpBindings }>();
  const issuer = oauthIssuer(config);
  const resource = issuer ? `${issuer}/mcp` : null;
  const authorizeEndpoint = issuer ? `${issuer}/oauth/authorize` : '/oauth/authorize';
  const issuerPath = issuer ? new URL(issuer).pathname.replace(/\/+$/, '') : '';

  const capture = (
    operation: string,
    startedAt: number,
    outcome: OperationOutcome,
    errorCode?: string,
    properties?: TelemetryProperties,
  ): void => {
    captureOperation(telemetry, {
      productSurface: 'rest',
      operation,
      outcome,
      durationMs: performance.now() - startedAt,
      ...(errorCode ? { errorCode } : {}),
      ...(properties ? { properties } : {}),
    });
  };

  const connection = (c: OAuthContext) => ({
    remoteAddress: c.env?.incoming?.socket.remoteAddress,
    encrypted: Boolean((c.env?.incoming?.socket as { encrypted?: boolean } | undefined)?.encrypted),
  });
  const usesHttps = (c: OAuthContext): boolean => administrationUsesHttps(c.req.raw, connection(c), config.trustProxy);
  const clientAddress = (c: OAuthContext): string => requestClientAddress(c.req.raw, connection(c), config.trustProxy);

  const protocolError = (c: OAuthContext, error: ProtocolError, description: string, status = 400): Response =>
    c.json({ error, error_description: description }, status as 400, {
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });

  const page = (c: OAuthContext, html: string, status = 200): Response =>
    c.html(html, status as 200, OAUTH_PAGE_HEADERS);

  const errorPage = (c: OAuthContext, title: string, message: string, status = 400): Response =>
    page(c, oauthErrorPage(title, message), status);

  const redirectWith = (redirectUri: string, params: Record<string, string | null | undefined>): Response => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, value);
    }
    if (issuer) url.searchParams.set('iss', issuer);
    return new Response(null, { status: 302, headers: { location: url.href, ...OAUTH_PAGE_HEADERS } });
  };

  const resolveClient = async (
    id: string,
  ): Promise<{ ok: true; client: OAuthClient } | { ok: false; error: ProtocolError; description: string }> => {
    if (!id || id.length > 2_000) return { ok: false, error: 'invalid_client', description: 'Unknown client_id.' };
    if (!isClientMetadataUrl(id)) {
      const client = getOAuthClient(db, id);
      return client?.kind === 'registered'
        ? { ok: true, client }
        : { ok: false, error: 'invalid_client', description: 'Unknown client_id.' };
    }
    const startedAt = performance.now();
    const resolution = await resolveMetadataClient(db, id, fetcher);
    if (resolution.status === 'ok') {
      // Cached documents need no fetch, so only fetches are recorded.
      if (resolution.source !== 'cached') {
        capture('oauthClientMetadata', startedAt, 'success', undefined, { metadata_source: resolution.source });
      }
      return { ok: true, client: resolution.client };
    }
    if (resolution.status === 'invalid') {
      capture('oauthClientMetadata', startedAt, 'error', 'invalid_client_metadata');
      return { ok: false, error: 'invalid_client', description: resolution.reason };
    }
    capture('oauthClientMetadata', startedAt, 'error', 'temporarily_unavailable');
    return { ok: false, error: 'temporarily_unavailable', description: resolution.reason };
  };

  const cors = (c: OAuthContext): void => {
    c.header('access-control-allow-origin', '*');
    c.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    c.header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version');
    c.header('access-control-max-age', '600');
  };

  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/*',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/*',
    '/oauth/register',
    '/oauth/token',
    '/oauth/revoke',
  ]) {
    app.use(path, async (c, next) => {
      if (!issuer) return c.notFound();
      cors(c);
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
      return next();
    });
  }

  app.use('/oauth/*', async (c, next) => {
    if (!issuer) return c.notFound();
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    if (!usesHttps(c)) {
      return c.req.path === '/oauth/authorize'
        ? errorPage(
            c,
            'HTTPS is required',
            'Fluxmail only accepts OAuth sign-ins over HTTPS. If a reverse proxy handles HTTPS, ' +
              'the administrator needs to set FLUXMAIL_TRUST_PROXY=1.',
          )
        : protocolError(c, 'invalid_request', 'OAuth requests require HTTPS outside loopback.');
    }
    if (c.req.method === 'POST' && (await requestBodyExceedsLimit(c.req.raw, BODY_LIMIT))) {
      return protocolError(c, 'invalid_request', 'Request body is limited to 64 KiB.', 413);
    }
    return next();
  });

  const protectedResourceMetadata = (c: OAuthContext) =>
    c.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Fluxmail',
    });
  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

  const authorizationServerMetadata = (c: OAuthContext) =>
    c.json({
      issuer,
      authorization_endpoint: authorizeEndpoint,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: OAUTH_SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  app.get('/.well-known/oauth-authorization-server', authorizationServerMetadata);
  // RFC 8414 and RFC 9728 put metadata for an issuer with a path, such as https://mail.example/fluxmail,
  // at the origin root with the path appended. A proxy that serves Fluxmail under that path must route these too.
  if (issuerPath) {
    app.get(`/.well-known/oauth-authorization-server${issuerPath}`, authorizationServerMetadata);
    app.get(`/.well-known/oauth-protected-resource${issuerPath}/mcp`, protectedResourceMetadata);
  }

  app.post('/oauth/register', async (c) => {
    const startedAt = performance.now();
    const fail = (error: ProtocolError, description: string, status = 400): Response => {
      capture('oauthRegister', startedAt, 'error', error);
      return protocolError(c, error, description, status);
    };
    if (!reserveOAuthRateLimit(db, `register:${clientAddress(c)}`, REGISTRATIONS_PER_MINUTE, 60_000)) {
      return fail('slow_down', 'Too many client registrations. Try again in a minute.', 429);
    }
    let body: Record<string, unknown>;
    try {
      const parsed = (await c.req.json()) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return fail('invalid_client_metadata', 'The registration request must be a JSON object.');
    }
    const redirectUris = body.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      !redirectUris.length ||
      redirectUris.length > 20 ||
      !redirectUris.every((uri) => typeof uri === 'string')
    ) {
      return fail('invalid_redirect_uri', 'redirect_uris must list between 1 and 20 URIs.');
    }
    for (const uri of redirectUris as string[]) {
      const problem = validateRedirectUri(uri);
      if (problem) return fail('invalid_redirect_uri', problem);
    }
    const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (
      !Array.isArray(grantTypes) ||
      !grantTypes.every((type) => type === 'authorization_code' || type === 'refresh_token')
    ) {
      return fail('invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported.');
    }
    const responseTypes = body.response_types ?? ['code'];
    if (!Array.isArray(responseTypes) || !responseTypes.every((type) => type === 'code')) {
      return fail('invalid_client_metadata', 'Only the code response type is supported.');
    }
    const name =
      typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim().slice(0, 200)
        : 'Unnamed MCP client';
    let scopes = DEFAULT_OAUTH_MAIL_SCOPES;
    if (body.scope !== undefined) {
      if (typeof body.scope !== 'string') return fail('invalid_client_metadata', 'scope must be a string.');
      const requested = body.scope.split(' ').filter(Boolean);
      const unknown = requested.filter((scope) => !isOAuthScope(scope));
      if (unknown.length) return fail('invalid_client_metadata', `Unknown scope: ${unknown.join(', ')}.`);
      if (mailScopesOf(requested).length) scopes = mailScopesOf(requested);
    }
    // Every client is public. Client keys, logos, and other URLs are dropped
    // so Fluxmail never fetches anything a registration names.
    const client = registerOAuthClient(db, { name, redirectUris: redirectUris as string[], scopes });
    if (!client) {
      c.header('retry-after', '3600');
      return fail('temporarily_unavailable', 'Fluxmail has reached its OAuth client limit.', 503);
    }
    capture('oauthRegister', startedAt, 'success');
    return c.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: [...client.scopes, OFFLINE_ACCESS_SCOPE].join(' '),
      },
      201,
      { 'cache-control': 'no-store' },
    );
  });

  const accessibleAccounts = (memberId: string): Account[] =>
    registry.listAccounts().filter((account) => memberCanAccessAccount(memberId, account));

  const renderApprove = (
    c: OAuthContext,
    client: OAuthClient,
    request: OAuthAuthorizationRequest,
    csrf: string,
    memberId: string,
    extra: {
      error?: string;
      checkedScopes?: McpCapability[];
      checkedAccountIds?: string[];
      allMailboxes?: boolean;
    } = {},
  ): Response => {
    const member = getMember(db, memberId);
    return page(
      c,
      oauthApprovePage({
        action: authorizeEndpoint,
        client,
        redirectUri: request.redirectUri,
        requestId: request.id,
        csrf,
        memberName: member.email ? `${member.name} (${member.email})` : member.name,
        scopes: mailScopesOf(request.scopes),
        accounts: accessibleAccounts(memberId),
        ...extra,
      }),
      extra.error ? 400 : 200,
    );
  };

  app.get('/oauth/authorize', async (c) => {
    const startedAt = performance.now();
    const query = c.req.query();
    const failPage = (code: string, title: string, message: string): Response => {
      capture('oauthAuthorize', startedAt, 'error', code);
      return errorPage(c, title, message);
    };
    if (!isBootstrapComplete(db)) {
      return failPage(
        'setup_required',
        'Fluxmail is not set up yet',
        'An administrator needs to run "fluxmail setup" before apps can connect.',
      );
    }
    const resolved = await resolveClient(query.client_id ?? '');
    if (!resolved.ok) {
      return failPage(
        resolved.error,
        resolved.error === 'temporarily_unavailable' ? 'Try again shortly' : 'This app is not recognized',
        resolved.description,
      );
    }
    const client = resolved.client;
    const redirectUri = query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
      return failPage(
        'invalid_redirect_uri',
        'This sign-in link is not valid',
        'The app asked Fluxmail to return you to an address it did not register.',
      );
    }
    const state = query.state;
    const redirectError = (error: ProtocolError, description: string): Response => {
      capture('oauthAuthorize', startedAt, 'error', error);
      return redirectWith(redirectUri, { error, error_description: description, state });
    };
    if (query.response_type !== 'code')
      return redirectError('unsupported_response_type', 'response_type must be code.');
    if (query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? '')) {
      return redirectError('invalid_request', 'An S256 PKCE code_challenge is required.');
    }
    if (query.resource !== undefined && query.resource.replace(/\/+$/, '') !== resource) {
      return redirectError('invalid_target', `resource must be ${resource}.`);
    }
    if (state !== undefined && state.length > 2_000) {
      return redirectError('invalid_request', 'state is limited to 2,000 characters.');
    }
    if (query.prompt === 'none') return redirectError('login_required', 'Fluxmail needs you to sign in.');
    const requested = (query.scope ?? '').split(' ').filter(Boolean);
    const unknown = requested.filter((scope) => !isOAuthScope(scope));
    if (unknown.length) return redirectError('invalid_scope', `Unknown scope: ${unknown.join(', ')}.`);
    let mailScopes = mailScopesOf(requested);
    if (mailScopes.some((scope) => !client.scopes.includes(scope))) {
      return redirectError('invalid_scope', 'The app requested a scope it did not register for.');
    }
    if (!mailScopes.length) mailScopes = DEFAULT_OAUTH_MAIL_SCOPES.filter((scope) => client.scopes.includes(scope));
    if (!mailScopes.length) return redirectError('invalid_scope', 'Request at least one mail scope.');
    const { request, csrf } = createOAuthAuthorizationRequest(db, {
      clientId: client.id,
      redirectUri,
      ...(state !== undefined ? { state } : {}),
      codeChallenge: query.code_challenge!,
      scopes: canonicalOAuthScopes([...mailScopes, OFFLINE_ACCESS_SCOPE]),
    });
    capture('oauthAuthorize', startedAt, 'success', undefined, { client_kind: client.kind });
    return page(c, oauthSignInPage({ action: authorizeEndpoint, client, redirectUri, requestId: request.id, csrf }));
  });

  app.post('/oauth/authorize', async (c) => {
    const startedAt = performance.now();
    const fetchSite = c.req.header('sec-fetch-site');
    const origin = c.req.header('origin');
    const sameOrigin = (value: string) => value === new URL(issuer!).origin || value === new URL(c.req.url).origin;
    if ((fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') || (origin && !sameOrigin(origin))) {
      capture('oauthConsent', startedAt, 'error', 'cross_origin');
      return errorPage(c, 'This request was blocked', 'Approve the connection from the Fluxmail page.', 403);
    }
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return errorPage(c, 'This request is not valid', 'Start connecting again from your app.');
    }
    const field = (name: string): string => {
      const value = form[name];
      const first = Array.isArray(value) ? value[0] : value;
      return typeof first === 'string' ? first : '';
    };
    const fields = (name: string): string[] => {
      const value = form[name];
      return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(
        (item): item is string => typeof item === 'string',
      );
    };
    const step = field('step') === 'approve' ? 'approve' : 'sign_in';
    const request = getOAuthAuthorizationRequest(db, field('request_id'), field('csrf'));
    const client = request ? getOAuthClient(db, request.clientId) : null;
    if (!request || !client) {
      capture('oauthConsent', startedAt, 'error', 'expired_request', { step });
      return errorPage(
        c,
        'This request has expired',
        'Fluxmail sign-in requests last 10 minutes. Start connecting again from your app.',
        410,
      );
    }
    if (field('action') === 'deny') {
      deleteOAuthAuthorizationRequest(db, request.id);
      capture('oauthConsent', startedAt, 'success', undefined, { step, consent: 'denied' });
      return redirectWith(request.redirectUri, {
        error: 'access_denied',
        error_description: 'The member denied the request.',
        state: request.state,
      });
    }

    if (step === 'sign_in') {
      const email = field('email');
      try {
        const member = await verifyMemberPassword(db, {
          email,
          password: field('password'),
          ipAddress: clientAddress(c),
        });
        const csrf = signInOAuthAuthorizationRequest(db, request.id, member.id);
        if (!csrf) throw new Error('request expired');
        capture('oauthConsent', startedAt, 'success', undefined, { step });
        return renderApprove(c, client, { ...request, memberId: member.id }, csrf, member.id);
      } catch (error) {
        const code = isEmailError(error) ? error.code : 'internal';
        capture('oauthConsent', startedAt, 'error', code, { step });
        const message =
          code === 'rate_limited'
            ? 'Too many sign-in attempts. Try again later.'
            : code === 'invalid_request'
              ? 'Enter a valid email address.'
              : code === 'permission_denied'
                ? 'Email or password is incorrect.'
                : 'Fluxmail could not sign you in. Try again.';
        return page(
          c,
          oauthSignInPage({
            action: authorizeEndpoint,
            client,
            redirectUri: request.redirectUri,
            requestId: request.id,
            csrf: field('csrf'),
            email,
            error: message,
          }),
          400,
        );
      }
    }

    const memberId = request.memberId;
    if (!memberId) {
      capture('oauthConsent', startedAt, 'error', 'invalid_request', { step });
      return errorPage(c, 'Sign in first', 'Start connecting again from your app.');
    }
    if (getMember(db, memberId).status !== 'active') {
      capture('oauthConsent', startedAt, 'error', 'permission_denied', { step });
      return errorPage(c, 'This member is not active', 'Ask a Fluxmail administrator for help.', 403);
    }
    const requestedMail = mailScopesOf(request.scopes);
    const checkedScopes = mailScopesOf(fields('scope')).filter((scope) => requestedMail.includes(scope));
    const allMailboxes = field('all_mailboxes') === '1';
    const accessible = new Set(accessibleAccounts(memberId).map((account) => account.id));
    const checkedAccountIds = [...new Set(fields('account'))];
    const retry = (error: string): Response => {
      capture('oauthConsent', startedAt, 'error', 'invalid_request', { step });
      return renderApprove(c, client, request, field('csrf'), memberId, {
        error,
        checkedScopes,
        checkedAccountIds,
        allMailboxes,
      });
    };
    if (!checkedScopes.length) return retry('Choose at least one permission.');
    if (!allMailboxes && !checkedAccountIds.length) return retry('Choose at least one mailbox, or all mailboxes.');
    if (!allMailboxes && checkedAccountIds.some((id) => !accessible.has(id))) {
      return retry('One of the selected mailboxes is no longer available.');
    }
    const approved = approveOAuthAuthorizationRequest(db, {
      requestId: request.id,
      memberId,
      scopes: checkedScopes,
      accountIds: allMailboxes ? null : checkedAccountIds,
    });
    if (!approved) {
      capture('oauthConsent', startedAt, 'error', 'expired_request', { step });
      return errorPage(c, 'This request has expired', 'Start connecting again from your app.', 410);
    }
    capture('oauthConsent', startedAt, 'success', undefined, { step, consent: 'approved' });
    return redirectWith(approved.redirectUri, { code: approved.code, state: approved.state });
  });

  const formFields = async (c: OAuthContext): Promise<Record<string, string> | null> => {
    const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/x-www-form-urlencoded') return null;
    try {
      const body = await c.req.parseBody();
      return Object.fromEntries(
        Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    } catch {
      return null;
    }
  };

  const basicClientId = (c: OAuthContext): string | undefined => {
    const header = c.req.header('authorization');
    const encoded = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i)?.[1];
    if (!encoded) return undefined;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const id = separator === -1 ? decoded : decoded.slice(0, separator);
    try {
      return decodeURIComponent(id);
    } catch {
      return id;
    }
  };

  const tokenResponse = (c: OAuthContext, tokens: OAuthTokenSet): Response =>
    c.json(
      {
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
        scope: tokens.scopes.join(' '),
      },
      200,
      { 'cache-control': 'no-store', pragma: 'no-cache' },
    );

  app.post('/oauth/token', async (c) => {
    const startedAt = performance.now();
    const form = await formFields(c);
    const grantType = form?.grant_type;
    const grantProperty =
      grantType === 'authorization_code' || grantType === 'refresh_token' ? { grant_type: grantType } : undefined;
    const fail = (error: ProtocolError, description: string, status = 400): Response => {
      capture('oauthToken', startedAt, 'error', error, grantProperty);
      return protocolError(c, error, description, status);
    };
    if (!form) return fail('invalid_request', 'Send the token request as application/x-www-form-urlencoded.');
    if (!reserveOAuthRateLimit(db, `token:${clientAddress(c)}`, TOKEN_REQUESTS_PER_MINUTE, 60_000)) {
      return fail('slow_down', 'Too many token requests. Try again in a minute.', 429);
    }
    const clientId = form.client_id ?? basicClientId(c) ?? '';
    const client = clientId ? getOAuthClient(db, clientId) : null;
    if (!client) return fail('invalid_client', 'Unknown client_id.', 401);
    if (form.resource !== undefined && form.resource.replace(/\/+$/, '') !== resource) {
      return fail('invalid_target', `resource must be ${resource}.`);
    }
    let result;
    if (grantType === 'authorization_code') {
      if (!form.code || !form.redirect_uri || !form.code_verifier) {
        return fail('invalid_request', 'code, redirect_uri, and code_verifier are required.');
      }
      result = exchangeOAuthAuthorizationCode(db, {
        code: form.code,
        clientId: client.id,
        redirectUri: form.redirect_uri,
        codeVerifier: form.code_verifier,
      });
    } else if (grantType === 'refresh_token') {
      if (!form.refresh_token) return fail('invalid_request', 'refresh_token is required.');
      const scopes = form.scope?.split(' ').filter(Boolean);
      if (scopes?.some((scope) => !isOAuthScope(scope))) return fail('invalid_scope', 'Unknown scope.');
      result = refreshOAuthTokens(db, {
        refreshToken: form.refresh_token,
        clientId: client.id,
        ...(scopes?.length ? { scopes } : {}),
      });
    } else {
      return fail('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
    }
    if (!result.ok) return fail(result.error, result.description);
    capture('oauthToken', startedAt, 'success', undefined, grantProperty);
    return tokenResponse(c, result.tokens);
  });

  app.post('/oauth/revoke', async (c) => {
    const startedAt = performance.now();
    const form = await formFields(c);
    if (!form?.token) {
      capture('oauthRevoke', startedAt, 'error', 'invalid_request');
      return protocolError(c, 'invalid_request', 'token is required.');
    }
    const clientId = form.client_id ?? basicClientId(c) ?? '';
    if (clientId) revokeOAuthToken(db, { token: form.token, clientId });
    capture('oauthRevoke', startedAt, 'success');
    return c.body(null, 200, { 'cache-control': 'no-store' });
  });

  return app;
}
