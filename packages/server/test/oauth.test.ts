import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { FluxmailConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService } from '../src/service/emailService.js';
import { accounts, openDb, type FluxmailDb } from '../src/storage/db.js';
import { authenticateBearer, setupInitialAdmin } from '../src/auth.js';
import { canAdminister } from '../src/authorization.js';
import { addMember, updateMember } from '../src/storage/members.js';
import { saveLeaseToken } from '../src/licensing/entitlements.js';
import {
  approveOAuthAuthorizationRequest,
  createOAuthAuthorizationRequest,
  exchangeOAuthAuthorizationCode,
  listOAuthGrants,
  OAUTH_ACCESS_TOKEN_TTL_MS,
  OAUTH_GRANT_TTL_MS,
  refreshOAuthTokens,
  OAUTH_MAX_CLIENTS_PER_HOST,
  registerOAuthClient,
  revokeOAuthGrant,
  signInOAuthAuthorizationRequest,
  storeMetadataOAuthClient,
} from '../src/storage/oauth.js';
import {
  canonicalClientMetadataUrl,
  isPublicAddress,
  resolveMetadataClient,
  type MetadataFetcher,
} from '../src/oauth/clientMetadata.js';
import { redirectUriMatches, validateRedirectUri } from '../src/oauth/redirectUris.js';
import { mcpAuthenticateChallenge, oauthIssuer } from '../src/http/oauth.js';

const PASSWORD = 'violet-harbor-lantern-42';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const ORIGIN = 'http://localhost:8977';

const leaseKeys = generateKeyPairSync('ed25519');

/** Allow a second member through a signed test lease. */
function licenseTeam(db: FluxmailDb): void {
  vi.stubEnv(
    'FLUXMAIL_LICENSE_PUBLIC_KEYS',
    leaseKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  );
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      licenseId: 'd2f7c1e0-0000-4000-8000-000000000000',
      plan: 'team',
      maxMembers: 3,
      maxAccounts: 5,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  );
  const signature = sign(null, payload, leaseKeys.privateKey);
  saveLeaseToken(db, `${payload.toString('base64url')}.${signature.toString('base64url')}`);
}

function config(publicUrl = ORIGIN): FluxmailConfig {
  return {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 8977,
    publicUrl,
    publicUrlConfigured: publicUrl !== ORIGIN,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
  };
}

function addAccount(db: FluxmailDb, id: string, email: string, ownerMemberId: string): void {
  db.insert(accounts)
    .values({ id, provider: 'gmail', email, ownerMemberId, status: 'active', createdAt: Date.now() })
    .run();
}

async function fixture(options: { publicUrl?: string; metadataFetcher?: MetadataFetcher } = {}) {
  const cfg = config(options.publicUrl);
  const db = openDb(':memory:');
  const registry = new AccountRegistry(db, cfg);
  const service = new EmailService(registry, db);
  const { member, session } = await setupInitialAdmin(db, {
    name: 'Ada Admin',
    email: 'ada@example.com',
    password: PASSWORD,
  });
  addAccount(db, 'acct_work', 'work@example.com', member.id);
  addAccount(db, 'acct_home', 'home@example.com', member.id);
  const capture = vi.fn();
  const app = createApp({
    config: cfg,
    configuration: undefined as never,
    db,
    registry,
    service,
    telemetry: { capture, shutdown: async () => undefined },
    ...(options.metadataFetcher ? { oauthMetadataFetcher: options.metadataFetcher } : {}),
  });
  return { app, db, member, capture, registry, sessionToken: session.token };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function form(fields: Record<string, string | string[]>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  return body;
}

function hiddenFields(html: string): { requestId: string; csrf: string } {
  const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!requestId || !csrf) throw new Error(`Expected a consent form, got: ${html}`);
  return { requestId, csrf };
}

async function register(app: Fixture['app'], body: Record<string, unknown> = {}) {
  return app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [REDIRECT], ...body }),
  });
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    resource: `${ORIGIN}/mcp`,
    ...extra,
  });
  return `/oauth/authorize?${params}`;
}

async function postConsent(app: Fixture['app'], fields: Record<string, string | string[]>, origin = ORIGIN) {
  return app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: form(fields),
  });
}

/** Run registration, sign-in, and approval; return the redirect and the PKCE verifier. */
async function authorize(
  f: Fixture,
  approval: { scope?: string[]; account?: string[]; allMailboxes?: boolean } = {},
  clientId?: string,
) {
  const id = clientId ?? ((await (await register(f.app)).json()) as { client_id: string }).client_id;
  const { verifier, challenge } = pkce();
  const start = await f.app.request(authorizeUrl(id, challenge));
  expect(start.status).toBe(200);
  const signIn = hiddenFields(await start.text());
  const signedIn = await postConsent(f.app, {
    request_id: signIn.requestId,
    csrf: signIn.csrf,
    step: 'sign_in',
    email: 'ada@example.com',
    password: PASSWORD,
    action: 'continue',
  });
  expect(signedIn.status).toBe(200);
  const approve = hiddenFields(await signedIn.text());
  const approved = await postConsent(f.app, {
    request_id: approve.requestId,
    csrf: approve.csrf,
    step: 'approve',
    scope: approval.scope ?? ['mail.read'],
    ...(approval.allMailboxes ? { all_mailboxes: '1' } : { account: approval.account ?? ['acct_work'] }),
    action: 'approve',
  });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('location')!);
  return { clientId: id, verifier, location, code: location.searchParams.get('code')! };
}

async function token(app: Fixture['app'], fields: Record<string, string>) {
  return app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(fields),
  });
}

async function exchange(f: Fixture, grant: Awaited<ReturnType<typeof authorize>>) {
  const response = await token(f.app, {
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: REDIRECT,
    code_verifier: grant.verifier,
    client_id: grant.clientId,
    resource: `${ORIGIN}/mcp`,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
}

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
});

async function callMcp(app: Fixture['app'], accessToken: string, tool: string) {
  const server = serve({ fetch: app.fetch, port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } }),
  });
}

describe('MCP OAuth discovery', () => {
  it('publishes resource and authorization server metadata', async () => {
    const { app } = await fixture();
    const resource = await app.request('/.well-known/oauth-protected-resource/mcp');
    expect(resource.status).toBe(200);
    expect(resource.headers.get('access-control-allow-origin')).toBe('*');
    await expect(resource.json()).resolves.toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: expect.arrayContaining(['mail.read', 'mail.delete', 'offline_access']),
    });
    const server = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as Record<
      string,
      unknown
    >;
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    });
  });

  it('keeps the public URL path in discovery and sign-in forms', async () => {
    // A reverse proxy serves Fluxmail under /fluxmail and strips the prefix before forwarding.
    const issuer = `${ORIGIN}/fluxmail`;
    const { app } = await fixture({ publicUrl: issuer });
    const server = await app.request('/.well-known/oauth-authorization-server/fluxmail');
    await expect(server.json()).resolves.toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
    });
    const resource = await app.request('/.well-known/oauth-protected-resource/fluxmail/mcp');
    await expect(resource.json()).resolves.toMatchObject({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
    });

    const { client_id: clientId } = (await (await register(app)).json()) as { client_id: string };
    const start = await app.request(authorizeUrl(clientId, pkce().challenge, { resource: `${issuer}/mcp` }));
    const html = await start.text();
    expect(html).toContain(`<form method="post" action="${issuer}/oauth/authorize">`);
    const signIn = hiddenFields(html);
    const signedIn = await postConsent(app, {
      request_id: signIn.requestId,
      csrf: signIn.csrf,
      step: 'sign_in',
      email: 'ada@example.com',
      password: PASSWORD,
      action: 'continue',
    });
    await expect(signedIn.text()).resolves.toContain(`<form method="post" action="${issuer}/oauth/authorize">`);
  });

  it('challenges unauthenticated MCP requests with the discovery URL', async () => {
    const { app } = await fixture();
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", ` +
        'scope="mail.read mail.drafts mail.organize mail.trash mail.send offline_access"',
    );
  });

  it('turns OAuth off when the public URL is plain HTTP on a remote host', async () => {
    expect(oauthIssuer({ publicUrl: 'http://mail.example.com' })).toBeNull();
    expect(oauthIssuer({ publicUrl: 'https://mail.example.com/' })).toBe('https://mail.example.com');
    expect(oauthIssuer({ publicUrl: 'http://127.0.0.1:8977' })).toBe('http://127.0.0.1:8977');
    expect(mcpAuthenticateChallenge({ publicUrl: 'http://mail.example.com' })).toBe('Bearer');
    const { app } = await fixture({ publicUrl: 'http://mail.example.com' });
    expect((await app.request('/.well-known/oauth-authorization-server')).status).toBe(404);
    expect((await register(app)).status).toBe(404);
  });
});

describe('MCP OAuth registration', () => {
  it('registers public clients and drops client-supplied URLs', async () => {
    const { app } = await fixture();
    const response = await register(app, {
      token_endpoint_auth_method: 'client_secret_basic',
      logo_uri: 'https://evil.example/logo.png',
      jwks_uri: 'https://evil.example/jwks',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_name: 'Test Client',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      scope: 'mail.read mail.drafts mail.organize mail.trash mail.send offline_access',
    });
    expect(body).not.toHaveProperty('logo_uri');
    expect(body).not.toHaveProperty('jwks_uri');
    expect(body).not.toHaveProperty('client_secret');
  });

  it.each([
    ['http://example.com/callback', 'loopback'],
    ['javascript:alert(1)', 'javascript'],
    ['https://example.com/cb#fragment', 'fragment'],
    ['/relative', 'absolute'],
  ])('rejects the redirect URI %s', async (uri, message) => {
    const { app } = await fixture();
    const response = await register(app, { redirect_uris: [uri] });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toContain(message);
  });

  it('rate limits registrations per address', async () => {
    const { app } = await fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await register(app)).status).toBe(201);
    expect((await register(app)).status).toBe(429);
  });

  it('matches loopback redirects on any port and everything else exactly', () => {
    expect(redirectUriMatches([REDIRECT], 'http://127.0.0.1:5555/callback')).toBe(true);
    expect(redirectUriMatches([REDIRECT], 'http://127.0.0.1:5555/other')).toBe(false);
    expect(redirectUriMatches(['https://app.example/cb'], 'https://app.example/cb?x=1')).toBe(false);
    expect(validateRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toBeNull();
  });

  it.each([
    [REDIRECT, 'an app on this computer', false],
    ['cursor://anysphere.cursor-retrieval/oauth/callback', 'an app on this computer', false],
    ['https://remote.example/callback', 'sends you to <strong>remote.example</strong>', true],
  ])('warns about an unverified app only when %s leaves this computer', async (uri, text, warns) => {
    const { app } = await fixture();
    const { client_id } = (await (await register(app, { redirect_uris: [uri] })).json()) as { client_id: string };
    const html = await (await app.request(authorizeUrl(client_id, pkce().challenge, { redirect_uri: uri }))).text();
    expect(html).toContain(text);
    expect(html.includes('cannot verify who made this app')).toBe(warns);
  });
});

describe('MCP OAuth authorization', () => {
  it('connects a client end to end and enforces the approved mailboxes and scopes', async () => {
    const f = await fixture();
    const grant = await authorize(f, { scope: ['mail.read'], account: ['acct_work'] });
    expect(grant.location.origin + grant.location.pathname).toBe(REDIRECT);
    expect(grant.location.searchParams.get('state')).toBe('state-123');
    expect(grant.location.searchParams.get('iss')).toBe(ORIGIN);

    const tokens = await exchange(f, grant);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'mail.read offline_access' });
    expect(tokens.access_token).toMatch(/^fmo_/);
    expect(tokens.refresh_token).toMatch(/^fmr_/);

    const principal = authenticateBearer(f.db, tokens.access_token);
    expect(principal).toMatchObject({ kind: 'oauth', memberId: f.member.id, accountIds: ['acct_work'] });
    expect(principal?.permissions.profile).toBe('read-only');
    expect(canAdminister(principal!, 'admin.members')).toBe(false);

    const response = await callMcp(f.app, tokens.access_token, 'list_accounts');
    expect(response.status).toBe(200);
    // The v2 stateless fallback uses SSE; the request advertises both response formats.
    const listed = response.headers.get('content-type')?.startsWith('text/event-stream')
      ? JSON.stringify(
          JSON.parse(
            (await response.text())
              .split('\n')
              .find((line) => line.startsWith('data: '))!
              .slice(6),
          ),
        )
      : JSON.stringify(await response.json());
    expect(listed).toContain('work@example.com');
    expect(listed).not.toContain('home@example.com');

    // OAuth tokens are for MCP only.
    const rest = await f.app.request('/api/v1/accounts', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(rest.status).toBe(401);
  });

  it('rotates refresh tokens and revokes the grant when a rotated token is reused', async () => {
    const f = await fixture();
    const first = await exchange(f, await authorize(f));
    const refreshed = await token(f.app, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: (await listOAuthGrants(f.db))[0]!.clientId,
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(authenticateBearer(f.db, second.access_token)?.kind).toBe('oauth');

    const replay = await token(f.app, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: (await listOAuthGrants(f.db))[0]!.clientId,
    });
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    expect(authenticateBearer(f.db, second.access_token)).toBeNull();
    expect(listOAuthGrants(f.db)).toEqual([]);
  });

  it('revokes the grant when an authorization code is replayed', async () => {
    const f = await fixture();
    const grant = await authorize(f);
    const tokens = await exchange(f, grant);
    const replay = await token(f.app, {
      grant_type: 'authorization_code',
      code: grant.code,
      redirect_uri: REDIRECT,
      code_verifier: grant.verifier,
      client_id: grant.clientId,
    });
    expect(replay.status).toBe(400);
    expect(authenticateBearer(f.db, tokens.access_token)).toBeNull();
  });

  it('rejects a wrong PKCE verifier, redirect URI, client, or resource', async () => {
    const f = await fixture();
    const grant = await authorize(f);
    const base = {
      grant_type: 'authorization_code',
      code: grant.code,
      redirect_uri: REDIRECT,
      code_verifier: grant.verifier,
      client_id: grant.clientId,
    };
    const cases: Array<[Record<string, string>, number, string]> = [
      [{ code_verifier: pkce().verifier }, 400, 'invalid_grant'],
      [{ redirect_uri: 'http://127.0.0.1:1/other' }, 400, 'invalid_grant'],
      [{ client_id: 'client_unknown' }, 401, 'invalid_client'],
      [{ resource: 'https://other.example/mcp' }, 400, 'invalid_target'],
    ];
    for (const [override, status, error] of cases) {
      const response = await token(f.app, { ...base, ...override });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error });
    }
    // None of the failures consumed the code.
    expect((await token(f.app, base)).status).toBe(200);
  });

  it('shows an error page for an unknown client or redirect, and redirects other errors', async () => {
    const f = await fixture();
    const { client_id: clientId } = (await (await register(f.app)).json()) as { client_id: string };
    const { challenge } = pkce();

    const unknown = await f.app.request(authorizeUrl('client_missing', challenge));
    expect(unknown.status).toBe(400);
    await expect(unknown.text()).resolves.toContain('not recognized');

    const badRedirect = await f.app.request(
      authorizeUrl(clientId, challenge, { redirect_uri: 'https://evil.example/' }),
    );
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.headers.get('location')).toBeNull();

    const cases: Array<[Record<string, string>, string]> = [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ scope: 'mail.read admin.members' }, 'invalid_scope'],
      [{ scope: 'mail.delete' }, 'invalid_scope'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ];
    for (const [override, error] of cases) {
      const response = await f.app.request(authorizeUrl(clientId, challenge, override));
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location')!);
      expect(location.searchParams.get('error')).toBe(error);
      expect(location.searchParams.get('state')).toBe('state-123');
    }
  });

  it('lets the member deny the request', async () => {
    const f = await fixture();
    const { client_id: clientId } = (await (await register(f.app)).json()) as { client_id: string };
    const start = await f.app.request(authorizeUrl(clientId, pkce().challenge));
    const fields = hiddenFields(await start.text());
    const denied = await postConsent(f.app, {
      request_id: fields.requestId,
      csrf: fields.csrf,
      step: 'sign_in',
      action: 'deny',
    });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('keeps the request open after a wrong password and blocks cross-origin posts', async () => {
    const f = await fixture();
    const { client_id: clientId } = (await (await register(f.app)).json()) as { client_id: string };
    const start = await f.app.request(authorizeUrl(clientId, pkce().challenge));
    const fields = hiddenFields(await start.text());
    const signIn = {
      request_id: fields.requestId,
      csrf: fields.csrf,
      step: 'sign_in',
      email: 'ada@example.com',
      password: 'wrong-password-here',
      action: 'continue',
    };
    const wrong = await postConsent(f.app, signIn);
    expect(wrong.status).toBe(400);
    await expect(wrong.text()).resolves.toContain('Email or password is incorrect.');

    const crossOrigin = await postConsent(f.app, { ...signIn, password: PASSWORD }, 'https://evil.example');
    expect(crossOrigin.status).toBe(403);

    const wrongCsrf = await postConsent(f.app, { ...signIn, password: PASSWORD, csrf: 'a'.repeat(64) });
    expect(wrongCsrf.status).toBe(410);

    expect((await postConsent(f.app, { ...signIn, password: PASSWORD })).status).toBe(200);
  });

  it('leaves permanent deletion unchecked even when the client asks for it', async () => {
    const f = await fixture();
    const registered = await register(f.app, { scope: 'mail.read mail.delete' });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const start = await f.app.request(authorizeUrl(clientId, pkce().challenge, { scope: 'mail.read mail.delete' }));
    const signIn = hiddenFields(await start.text());
    const page = await (
      await postConsent(f.app, {
        request_id: signIn.requestId,
        csrf: signIn.csrf,
        step: 'sign_in',
        email: 'ada@example.com',
        password: PASSWORD,
        action: 'continue',
      })
    ).text();
    expect(page).toContain('value="mail.read" checked');
    expect(page).toContain('value="mail.delete">');
  });

  it('requires at least one permission and one mailbox choice', async () => {
    const f = await fixture();
    const { client_id: clientId } = (await (await register(f.app)).json()) as { client_id: string };
    const start = await f.app.request(authorizeUrl(clientId, pkce().challenge));
    const signIn = hiddenFields(await start.text());
    const signedIn = await postConsent(f.app, {
      request_id: signIn.requestId,
      csrf: signIn.csrf,
      step: 'sign_in',
      email: 'ada@example.com',
      password: PASSWORD,
      action: 'continue',
    });
    const page = await signedIn.text();
    expect(page).toContain('work@example.com');
    expect(page).not.toContain('value="mail.delete"');
    const approve = hiddenFields(page);
    const base = { request_id: approve.requestId, csrf: approve.csrf, step: 'approve', action: 'approve' };
    const noScope = await postConsent(f.app, { ...base, account: 'acct_work' });
    await expect(noScope.text()).resolves.toContain('Choose at least one permission.');
    const noMailbox = await postConsent(f.app, { ...base, scope: 'mail.read' });
    await expect(noMailbox.text()).resolves.toContain('Choose at least one mailbox');
    const foreign = await postConsent(f.app, { ...base, scope: 'mail.read', account: 'acct_other' });
    await expect(foreign.text()).resolves.toContain('no longer available');
    // A scope the client did not request is ignored.
    const approved = await postConsent(f.app, { ...base, scope: ['mail.read', 'mail.delete'], all_mailboxes: '1' });
    expect(approved.status).toBe(302);
    expect(listOAuthGrants(f.db)[0]).toMatchObject({ scopes: ['mail.read'], accountIds: null });
  });

  it('revokes grants when the member is suspended or a token is revoked', async () => {
    const f = await fixture();
    licenseTeam(f.db);
    addMember(f.db, { name: 'Bob', email: 'bob@example.com', role: 'admin', status: 'active' });
    const grant = await authorize(f);
    const tokens = await exchange(f, grant);

    const revoked = await f.app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token: tokens.refresh_token, client_id: grant.clientId }),
    });
    expect(revoked.status).toBe(200);
    expect(authenticateBearer(f.db, tokens.access_token)).toBeNull();

    const again = await exchange(f, await authorize(f, {}, grant.clientId));
    expect(authenticateBearer(f.db, again.access_token)?.kind).toBe('oauth');
    updateMember(f.db, f.member.id, { status: 'suspended' });
    expect(authenticateBearer(f.db, again.access_token)).toBeNull();
    expect(listOAuthGrants(f.db)).toEqual([]);
  });

  it.each([false, true])('invalidates pending approvals on password change (existing grant: %s)', async (hasGrant) => {
    const f = await fixture();
    const tokens = hasGrant ? await exchange(f, await authorize(f)) : undefined;
    const { client_id: clientId } = (await (await register(f.app)).json()) as { client_id: string };
    const start = await f.app.request(authorizeUrl(clientId, pkce().challenge));
    const signIn = hiddenFields(await start.text());
    const signedIn = await postConsent(f.app, {
      request_id: signIn.requestId,
      csrf: signIn.csrf,
      step: 'sign_in',
      email: 'ada@example.com',
      password: PASSWORD,
      action: 'continue',
    });
    expect(signedIn.status).toBe(200);
    const approve = hiddenFields(await signedIn.text());
    const changed = await f.app.request('/api/v1/me/password', {
      method: 'PUT',
      headers: { authorization: `Bearer ${f.sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'orange-river-cascade-57' }),
    });
    expect(changed.status).toBe(200);

    const approved = await postConsent(f.app, {
      request_id: approve.requestId,
      csrf: approve.csrf,
      step: 'approve',
      scope: 'mail.read',
      account: 'acct_work',
      action: 'approve',
    });
    expect(approved.status).toBe(410);
    expect(approved.headers.get('location')).toBeNull();
    expect(listOAuthGrants(f.db)).toEqual([]);
    if (tokens) expect(authenticateBearer(f.db, tokens.access_token)).toBeNull();
  });

  it.each(['expired', 'revoked'] as const)('reauthorizes an older client after its last grant is %s', async (state) => {
    const f = await fixture();
    const first = await authorize(f);
    const oldTokens = await exchange(f, first);
    if (state === 'revoked') revokeOAuthGrant(f.db, listOAuthGrants(f.db)[0]!.id);
    const elapsed = state === 'expired' ? OAUTH_GRANT_TTL_MS + 1 : 2 * 24 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + elapsed);
    try {
      const renewed = await authorize(f, {}, first.clientId);
      const tokens = await exchange(f, renewed);
      expect(authenticateBearer(f.db, tokens.access_token)).toMatchObject({
        kind: 'oauth',
        clientId: first.clientId,
        memberId: f.member.id,
      });
      expect(authenticateBearer(f.db, oldTokens.access_token)).toBeNull();
      expect(listOAuthGrants(f.db)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('records telemetry without client identifiers, codes, or credentials', async () => {
    const f = await fixture();
    const grant = await authorize(f);
    const tokens = await exchange(f, grant);
    const events = f.capture.mock.calls.map(([, properties]) => properties as Record<string, unknown>);
    expect(events.map((event) => event.operation)).toEqual([
      'oauthRegister',
      'oauthAuthorize',
      'oauthConsent',
      'oauthConsent',
      'oauthToken',
    ]);
    expect(events.at(-2)).toMatchObject({ consent: 'approved', step: 'approve', outcome: 'success' });
    expect(events.at(-1)).toMatchObject({ grant_type: 'authorization_code', product_surface: 'rest' });
    const serialized = JSON.stringify(events);
    for (const secret of [
      grant.clientId,
      grant.code,
      grant.verifier,
      tokens.access_token,
      tokens.refresh_token,
      PASSWORD,
      'ada@example.com',
      'state-123',
      REDIRECT,
      'acct_work',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    f.capture.mockClear();
    await token(f.app, { grant_type: 'refresh_token', refresh_token: 'fmr_bogus', client_id: grant.clientId });
    expect(f.capture.mock.calls[0]![1]).toMatchObject({
      operation: 'oauthToken',
      outcome: 'error',
      error_code: 'invalid_grant',
      grant_type: 'refresh_token',
    });
    expect(JSON.stringify(f.capture.mock.calls)).not.toContain('fmr_bogus');
  });
});

describe('MCP OAuth connection management', () => {
  it('lists, narrows, and revokes connections through REST', async () => {
    const f = await fixture();
    const tokens = await exchange(f, await authorize(f, { allMailboxes: true }));
    const headers = { authorization: `Bearer ${f.sessionToken}`, 'content-type': 'application/json' };

    const listed = await f.app.request('/api/v1/me/oauth-connections', { headers });
    expect(listed.status).toBe(200);
    const [connection] = ((await listed.json()) as { data: Array<Record<string, unknown>> }).data;
    expect(connection).toMatchObject({ clientName: 'Test Client', scopes: ['mail.read'], accountIds: null });

    const narrowed = await f.app.request(`/api/v1/me/oauth-connections/${connection!.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ accountIds: ['acct_home'] }),
    });
    expect(narrowed.status).toBe(200);
    expect(authenticateBearer(f.db, tokens.access_token)?.accountIds).toEqual(['acct_home']);

    const admin = await f.app.request('/api/v1/admin/oauth-connections', { headers });
    expect(((await admin.json()) as { data: unknown[] }).data).toHaveLength(1);

    // An OAuth token cannot manage connections, even its own.
    const self = await f.app.request(`/api/v1/me/oauth-connections/${connection!.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(self.status).toBe(401);

    const revoked = await f.app.request(`/api/v1/me/oauth-connections/${connection!.id}`, {
      method: 'DELETE',
      headers,
    });
    expect(revoked.status).toBe(200);
    expect(authenticateBearer(f.db, tokens.access_token)).toBeNull();
    const missing = await f.app.request(`/api/v1/me/oauth-connections/${connection!.id}`, {
      method: 'DELETE',
      headers,
    });
    expect(missing.status).toBe(404);
  });
});

describe('MCP OAuth storage', () => {
  it('adds the OAuth tables when a format 6 store opens', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-oauth-migration-'));
    const dbPath = path.join(directory, 'fluxmail.db');
    const first = openDb(dbPath);
    const client = (first as unknown as { $client: Database.Database }).$client;
    for (const table of [
      'mcp_oauth_requests',
      'mcp_oauth_tokens',
      'mcp_oauth_codes',
      'mcp_oauth_grants',
      'mcp_oauth_clients',
    ]) {
      client.exec(`DROP TABLE ${table}`);
    }
    client.pragma('user_version = 6');
    client.close();
    const reopened = openDb(dbPath);
    const tables = (reopened as unknown as { $client: Database.Database }).$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mcp_oauth_%' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual([
      'mcp_oauth_clients',
      'mcp_oauth_codes',
      'mcp_oauth_grants',
      'mcp_oauth_requests',
      'mcp_oauth_tokens',
    ]);
    expect(
      registerOAuthClient(reopened, { name: 'Client', redirectUris: [REDIRECT], scopes: ['mail.read'] }),
    ).not.toBeNull();
    (reopened as unknown as { $client: Database.Database }).$client.close();
  });

  async function storedGrant(now: number) {
    const db = openDb(':memory:');
    const { member } = await setupInitialAdmin(db, { name: 'Ada Admin', email: 'ada@example.com', password: PASSWORD });
    const client = registerOAuthClient(db, { name: 'Client', redirectUris: [REDIRECT], scopes: ['mail.read'] }, now)!;
    const { verifier, challenge } = pkce();
    const { request } = createOAuthAuthorizationRequest(
      db,
      { clientId: client.id, redirectUri: REDIRECT, codeChallenge: challenge, scopes: ['mail.read'] },
      now,
    );
    signInOAuthAuthorizationRequest(db, request.id, member.id, now);
    const approved = approveOAuthAuthorizationRequest(
      db,
      { requestId: request.id, memberId: member.id, scopes: ['mail.read'], accountIds: null },
      now,
    )!;
    const result = exchangeOAuthAuthorizationCode(
      db,
      { code: approved.code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier },
      now,
    );
    if (!result.ok) throw new Error(result.description);
    return { db, client, member, tokens: result.tokens, grantId: approved.grantId };
  }

  it('expires access tokens, and bounds refreshes by the grant deadline', async () => {
    const now = Date.now();
    const { db, client, tokens } = await storedGrant(now);
    const later = now + OAUTH_ACCESS_TOKEN_TTL_MS + 1;
    vi.useFakeTimers({ now: later });
    try {
      expect(authenticateBearer(db, tokens.accessToken)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    const refreshed = refreshOAuthTokens(db, { refreshToken: tokens.refreshToken!, clientId: client.id }, later);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    const ended = refreshOAuthTokens(
      db,
      { refreshToken: refreshed.tokens.refreshToken!, clientId: client.id },
      now + OAUTH_GRANT_TTL_MS + 1,
    );
    expect(ended).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('never adds scopes on refresh', async () => {
    const { db, client, tokens } = await storedGrant(Date.now());
    expect(
      refreshOAuthTokens(db, { refreshToken: tokens.refreshToken!, clientId: client.id, scopes: ['mail.send'] }),
    ).toMatchObject({ ok: false, error: 'invalid_scope' });
  });

  it('only revokes a member grant for its owner', async () => {
    const { db, grantId } = await storedGrant(Date.now());
    licenseTeam(db);
    const other = addMember(db, { name: 'Bob', email: 'bob@example.com' });
    expect(revokeOAuthGrant(db, grantId, other.id)).toBe(false);
    expect(revokeOAuthGrant(db, grantId)).toBe(true);
  });
});

describe('client metadata documents', () => {
  const CLIENT_ID = 'https://client.example/oauth/metadata.json';
  const document = {
    client_id: CLIENT_ID,
    client_name: 'Example Agent',
    redirect_uris: ['https://client.example/callback'],
    token_endpoint_auth_method: 'none',
  };

  function metadataAuthorizeUrl(challenge: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://client.example/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `/oauth/authorize?${params}`;
  }

  it('creates a client from its document and names the document host', async () => {
    const fetcher = vi.fn<MetadataFetcher>(async () => ({
      status: 200,
      cacheControl: 'max-age=60',
      body: JSON.stringify(document),
    }));
    const f = await fixture({ metadataFetcher: fetcher });
    const response = await f.app.request(metadataAuthorizeUrl(pkce().challenge));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Connect Example Agent to Fluxmail');
    expect(html).toContain('returns you to <strong>client.example</strong>');
    expect(html).not.toContain('cannot verify');
    await f.app.request(metadataAuthorizeUrl(pkce().challenge));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.capture.mock.calls.map(([, p]) => (p as { operation: string }).operation)).toContain(
      'oauthClientMetadata',
    );
  });

  it.each([
    ['a mismatched client_id', { ...document, client_id: 'https://other.example/x' }],
    ['a client secret', { ...document, client_secret: 'secret' }],
    ['a confidential client', { ...document, token_endpoint_auth_method: 'private_key_jwt' }],
    ['no redirect URIs', { ...document, redirect_uris: [] }],
  ])('rejects a document with %s', async (_label, body) => {
    const f = await fixture({
      metadataFetcher: async () => ({ status: 200, cacheControl: null, body: JSON.stringify(body) }),
    });
    const response = await f.app.request(metadataAuthorizeUrl(pkce().challenge));
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('not recognized');
  });

  it('accepts a document that lists none among supported methods', async () => {
    const f = await fixture({
      metadataFetcher: async () => ({
        status: 200,
        cacheControl: null,
        body: JSON.stringify({
          ...document,
          token_endpoint_auth_method: 'private_key_jwt',
          token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'],
        }),
      }),
    });
    expect((await f.app.request(metadataAuthorizeUrl(pkce().challenge))).status).toBe(200);
  });

  it('keeps using a stored client when a refetch fails for a transient reason', async () => {
    let calls = 0;
    const { MetadataFetchUnavailable } = await import('../src/oauth/clientMetadata.js');
    const f = await fixture({
      metadataFetcher: async () => {
        calls += 1;
        if (calls > 1) throw new MetadataFetchUnavailable('down');
        return { status: 200, cacheControl: 'no-store', body: JSON.stringify(document) };
      },
    });
    expect((await f.app.request(metadataAuthorizeUrl(pkce().challenge))).status).toBe(200);
    expect((await f.app.request(metadataAuthorizeUrl(pkce().challenge))).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('frees the per-host limit held by abandoned clients', async () => {
    const db = openDb(':memory:');
    const now = Date.now();
    for (let index = 0; index < OAUTH_MAX_CLIENTS_PER_HOST; index += 1) {
      const id = `https://client.example/old/${index}`;
      const stored = storeMetadataOAuthClient(
        db,
        { id, host: 'client.example', name: 'Old', redirectUris: ['https://client.example/cb'], expiresAt: now },
        now - 25 * 60 * 60 * 1000,
      );
      expect(stored.status).toBe('stored');
    }
    const resolved = await resolveMetadataClient(
      db,
      CLIENT_ID,
      async () => ({ status: 200, cacheControl: null, body: JSON.stringify(document) }),
      now,
    );
    expect(resolved).toMatchObject({ status: 'ok', source: 'fetched' });
  });

  it('requires canonical HTTPS client ids and public addresses', () => {
    expect(canonicalClientMetadataUrl(CLIENT_ID)?.href).toBe(CLIENT_ID);
    for (const id of [
      'https://CLIENT.example/oauth',
      'https://client.example:443/oauth',
      'https://client.example/',
      'https://client.example/a?b=c',
      'http://client.example/oauth',
      'https://127.0.0.1/oauth',
      'https://client.example/a/../b',
    ]) {
      expect(canonicalClientMetadataUrl(id)).toBeNull();
    }
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.168.1.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });
});
