import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type {
  OAuthClientProvider,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/client';
import type { FluxmailConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService } from '../src/service/emailService.js';
import { accounts, openDb } from '../src/storage/db.js';
import { setupInitialAdmin } from '../src/auth.js';
import { listOAuthGrants, revokeOAuthGrant } from '../src/storage/oauth.js';

const PASSWORD = 'violet-harbor-lantern-42';
const REDIRECT = 'http://127.0.0.1:33419/callback';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function startServer() {
  let handler: ((request: Request, env: unknown) => Response | Promise<Response>) | undefined;
  const server = serve({ fetch: (request, env) => handler!(request, env), port: 0, hostname: '127.0.0.1' });
  closers.push(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 8977,
    publicUrl: origin,
    publicUrlConfigured: true,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
  };
  const db = openDb(':memory:');
  const registry = new AccountRegistry(db, config);
  const { member } = await setupInitialAdmin(db, { name: 'Ada Admin', email: 'ada@example.com', password: PASSWORD });
  db.insert(accounts)
    .values({
      id: 'acct_work',
      provider: 'gmail',
      email: 'work@example.com',
      ownerMemberId: member.id,
      status: 'active',
      createdAt: Date.now(),
    })
    .run();
  const app = createApp({
    config,
    configuration: undefined as never,
    db,
    registry,
    service: new EmailService(registry, db),
  });
  handler = (request, env) => app.fetch(request, env as never);
  return { origin, db };
}

function hiddenFields(html: string): { requestId: string; csrf: string } {
  return {
    requestId: html.match(/name="request_id" value="([^"]+)"/)![1]!,
    csrf: html.match(/name="csrf" value="([^"]+)"/)![1]!,
  };
}

/** Plays the member in the browser: sign in, approve, and capture the code. */
async function approveInBrowser(origin: string, authorizationUrl: URL): Promise<URLSearchParams> {
  const start = await fetch(authorizationUrl);
  expect(start.status).toBe(200);
  const post = (fields: Record<string, string>) =>
    fetch(`${origin}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: new URLSearchParams(fields),
    });
  const signIn = hiddenFields(await start.text());
  const signedIn = await post({
    request_id: signIn.requestId,
    csrf: signIn.csrf,
    step: 'sign_in',
    email: 'ada@example.com',
    password: PASSWORD,
    action: 'continue',
  });
  const approve = hiddenFields(await signedIn.text());
  const approved = await post({
    request_id: approve.requestId,
    csrf: approve.csrf,
    step: 'approve',
    scope: 'mail.read',
    account: 'acct_work',
    action: 'approve',
  });
  expect(approved.status).toBe(302);
  return new URL(approved.headers.get('location')!).searchParams;
}

class TestProvider implements OAuthClientProvider {
  client?: OAuthClientInformationFull;
  saved?: OAuthTokens;
  verifier = '';
  discovery?: OAuthDiscoveryState;
  discoveryState() {
    return this.discovery;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  pendingCode?: Promise<URLSearchParams>;
  /** Set to false to record a sign-in request without completing it. */
  approve = true;
  signInRequests = 0;

  constructor(private readonly origin: string) {}

  get redirectUrl(): string {
    return REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'SDK test client',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this.client;
  }

  saveClientInformation(info: OAuthClientInformationFull) {
    this.client = info;
  }

  tokens() {
    return this.saved;
  }

  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL) {
    this.signInRequests += 1;
    if (this.approve) this.pendingCode = approveInBrowser(this.origin, url);
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    return this.verifier;
  }
}

describe('MCP SDK client compatibility', () => {
  it.each(['legacy', 'modern'] as const)(
    '%s: discovers, authorizes, refreshes, and stops after revocation',
    async (era) => {
      const options = { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : ('legacy' as const) } };
      const { origin, db } = await startServer();
      const provider = new TestProvider(origin);
      const mcpUrl = new URL(`${origin}/mcp`);

      const first = new Client({ name: 'test', version: '1.0.0' }, options);
      await expect(
        first.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })),
      ).rejects.toThrow(UnauthorizedError);
      expect(provider.client?.client_id).toMatch(/^client_/);
      const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
      await transport.finishAuth(await provider.pendingCode!);
      expect(provider.saved?.access_token).toMatch(/^fmo_/);
      expect(provider.saved?.scope).toBe('mail.read offline_access');

      const client = new Client({ name: 'test', version: '1.0.0' }, options);
      closers.push(() => void client.close());
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('list_accounts');
      expect(tools.tools.map((tool) => tool.name)).not.toContain('send_email');
      const listed = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(JSON.stringify(listed)).toContain('work@example.com');

      // An expired access token is refreshed with the rotated refresh token.
      const previousRefresh = provider.saved!.refresh_token;
      provider.saved = { ...provider.saved!, access_token: 'fmo_expired' };
      const refreshedClient = new Client({ name: 'test', version: '1.0.0' }, options);
      closers.push(() => void refreshedClient.close());
      await refreshedClient.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
      expect(provider.saved.refresh_token).not.toBe(previousRefresh);
      expect(JSON.stringify(await refreshedClient.callTool({ name: 'list_accounts', arguments: {} }))).toContain(
        'work@example.com',
      );

      // After revocation the refresh fails and the client has to sign in again.
      revokeOAuthGrant(db, listOAuthGrants(db)[0]!.id);
      provider.saved = { ...provider.saved, access_token: 'fmo_expired' };
      provider.approve = false;
      const requestsBefore = provider.signInRequests;
      const revoked = new Client({ name: 'test', version: '1.0.0' }, options);
      await expect(
        revoked.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })),
      ).rejects.toThrow(UnauthorizedError);
      expect(provider.signInRequests).toBe(requestsBefore + 1);
    },
  );
});
