import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FluxmailConfig } from '../src/config.js';
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  refreshMicrosoftCredentials,
  runMicrosoftLoopbackFlow,
} from '../src/accounts/microsoftAuth.js';

function config(oauthPort = 8976, clientSecret?: string): FluxmailConfig {
  return {
    dataDir: '/tmp/fluxmail-test',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
    microsoft: {
      clientId: 'microsoft-client-id',
      tenantId: 'common',
      ...(clientSecret ? { clientSecret } : {}),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Microsoft OAuth', () => {
  it('builds a PKCE authorization URL for mail scopes', () => {
    const url = new URL(
      buildMicrosoftAuthUrl(
        config(),
        'http://localhost:8976/oauth/microsoft/callback',
        'state-value',
        'verifier-value',
      ),
    );

    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe('microsoft-client-id');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('Mail.ReadWrite');
    expect(url.searchParams.get('scope')).toContain('Mail.Send');
    expect(url.searchParams.get('scope')?.split(' ')).toContain('MailboxSettings.ReadWrite');
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('exchanges a code and reads the mailbox identity from Graph', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 3600,
            scope: 'Mail.ReadWrite Mail.Send',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            mail: 'me@example.com',
            userPrincipalName: 'me@tenant.example',
            displayName: 'Example User',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'inbox-id' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await exchangeMicrosoftCode(
      config(),
      'authorization-code',
      'http://localhost:8976/oauth/microsoft/callback',
      'verifier-value',
    );

    expect(result).toMatchObject({
      email: 'me@example.com',
      displayName: 'Example User',
      credentials: { accessToken: 'access-token', refreshToken: 'refresh-token', clientAuth: 'public' },
    });
    const tokenRequest = fetchMock.mock.calls[0]!;
    expect(String(tokenRequest[0])).toContain('/common/oauth2/v2.0/token');
    expect(String(tokenRequest[1]?.body)).toContain('code_verifier=verifier-value');
    expect(String(tokenRequest[1]?.body)).not.toContain('client_secret');
    expect(String(fetchMock.mock.calls[2]![0])).toContain('/me/mailFolders/inbox');
  });

  it('authenticates hosted token exchanges with the configured client secret', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mail: 'hosted@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'inbox-id' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await exchangeMicrosoftCode(
      config(8976, 'hosted-secret'),
      'authorization-code',
      'https://mail.example.com/auth/microsoft/callback',
      'verifier-value',
      'confidential',
    );

    expect(result.credentials.clientAuth).toBe('confidential');
    expect(String(fetchMock.mock.calls[0]![1]?.body)).toContain('client_secret=hosted-secret');
  });

  it('requires a refresh token for offline mailbox access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      exchangeMicrosoftCode(
        config(8976, 'hosted-secret'),
        'authorization-code',
        'https://mail.example.com/auth/microsoft/callback',
        'verifier-value',
        'confidential',
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('refresh token'),
    });
  });

  it('rejects an identity that has no accessible mailbox', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ userPrincipalName: 'me@tenant.example' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Mailbox not enabled for REST API' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      exchangeMicrosoftCode(
        config(),
        'authorization-code',
        'http://localhost:8976/oauth/microsoft/callback',
        'verifier-value',
      ),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: "Microsoft Graph could not access this account's mailbox: Mailbox not enabled for REST API",
    });
  });

  it('keeps the old refresh token when Microsoft rotates only the access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 1200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await refreshMicrosoftCredentials(config(), {
      accessToken: 'expired-access',
      refreshToken: 'existing-refresh',
      expiresAt: 0,
    });

    expect(refreshed.accessToken).toBe('fresh-access');
    expect(refreshed.refreshToken).toBe('existing-refresh');
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    expect(String(fetchMock.mock.calls[0]![1]?.body)).not.toContain('client_secret');
    expect(String(fetchMock.mock.calls[0]![1]?.body)).not.toContain('scope=');
  });

  it('refreshes existing Outlook accounts with their previously granted scopes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 1200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftCredentials(config(), {
      accessToken: 'expired-access',
      refreshToken: 'existing-refresh',
      expiresAt: 0,
      scope: 'User.Read Mail.ReadWrite Mail.Send offline_access',
    });

    const body = String(fetchMock.mock.calls[0]![1]?.body);
    expect(body).toContain('scope=User.Read+Mail.ReadWrite+Mail.Send+offline_access');
    expect(body).not.toContain('MailboxSettings.Read');
  });

  it('uses the client secret when refreshing hosted credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'hosted-access', expires_in: 1200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await refreshMicrosoftCredentials(config(8976, 'hosted-secret'), {
      accessToken: 'expired-access',
      refreshToken: 'hosted-refresh',
      expiresAt: 0,
      clientAuth: 'confidential',
    });

    expect(refreshed).toMatchObject({
      accessToken: 'hosted-access',
      refreshToken: 'hosted-refresh',
      clientAuth: 'confidential',
    });
    const body = String(fetchMock.mock.calls[0]![1]?.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_secret=hosted-secret');
  });

  it('refreshes with the OAuth application that issued the token after instance configuration changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 1200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const replacement = config(8976, 'replacement-secret');
    replacement.microsoft = {
      clientId: 'replacement-client',
      clientSecret: 'replacement-secret',
      tenantId: 'replacement-tenant',
    };
    const original = {
      clientId: 'original-client',
      clientSecret: 'original-secret',
      tenantId: 'original-tenant',
    };

    const refreshed = await refreshMicrosoftCredentials(replacement, {
      accessToken: 'expired-access',
      refreshToken: 'original-refresh',
      expiresAt: 0,
      clientAuth: 'confidential',
      fluxmailOAuthClient: original,
    });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/original-tenant/oauth2/v2.0/token');
    const body = String(fetchMock.mock.calls[0]![1]?.body);
    expect(body).toContain('client_id=original-client');
    expect(body).toContain('client_secret=original-secret');
    expect(body).not.toContain('replacement');
    expect(refreshed.fluxmailOAuthClient).toEqual(original);
  });

  it('maps a rejected refresh token to an expired authorization', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: 'invalid_grant', error_description: 'The refresh token has expired.' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
    );

    await expect(
      refreshMicrosoftCredentials(config(8976, 'hosted-secret'), {
        accessToken: 'expired-access',
        refreshToken: 'expired-refresh',
        expiresAt: 0,
        clientAuth: 'confidential',
      }),
    ).rejects.toMatchObject({
      code: 'auth_expired',
      message: 'Microsoft OAuth failed: The refresh token has expired.',
    });
  });

  it('explains how to connect an account when Docker is using the callback port', async () => {
    const existingServer = createServer();
    await new Promise<void>((resolve) => existingServer.listen(0, '127.0.0.1', resolve));
    const address = existingServer.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');

    try {
      const flow = expect(runMicrosoftLoopbackFlow(config(address.port), vi.fn())).rejects;
      await flow.toThrow(/docker compose exec fluxmail fluxmail accounts add outlook/);
      await flow.not.toThrow(/--owner/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        existingServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('uses one Microsoft OAuth app throughout a loopback flow', async () => {
    const localFetch = globalThis.fetch.bind(globalThis);
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    await new Promise<void>((resolve, reject) => portProbe.close((error) => (error ? reject(error) : resolve())));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mail: 'me@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'inbox-id' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const liveConfig = config(address.port);
    const oauthClient = { ...liveConfig.microsoft! };
    let provideAuthUrl!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
      provideAuthUrl = resolve;
    });

    const flow = runMicrosoftLoopbackFlow(liveConfig, provideAuthUrl);
    const authorizationUrl = new URL(await authUrl);
    const state = authorizationUrl.searchParams.get('state');
    liveConfig.microsoft = { clientId: 'replacement-client-id', tenantId: 'replacement-tenant' };
    const response = await localFetch(
      `http://localhost:${address.port}/oauth/microsoft/callback?state=${state}&code=authorization-code`,
    );
    await response.text();

    await expect(flow).resolves.toMatchObject({
      email: 'me@example.com',
      credentials: { fluxmailOAuthClient: oauthClient },
    });
    expect(authorizationUrl.searchParams.get('client_id')).toBe(oauthClient.clientId);
    expect(authorizationUrl.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/common/oauth2/v2.0/token');
    expect(String(fetchMock.mock.calls[0]![1]?.body)).toContain(`client_id=${oauthClient.clientId}`);
    expect(String(fetchMock.mock.calls[0]![1]?.body)).not.toContain('replacement-client-id');
  });

  it('finishes with a callback URL pasted from a browser on another computer', async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    await new Promise<void>((resolve, reject) => portProbe.close((error) => (error ? reject(error) : resolve())));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mail: 'me@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'inbox-id' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    let provideAuthUrl!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
      provideAuthUrl = resolve;
    });
    const input = new PassThrough();

    const flow = runMicrosoftLoopbackFlow(config(address.port), provideAuthUrl, undefined, {
      paste: { input, write: vi.fn() },
    });
    const state = new URL(await authUrl).searchParams.get('state');
    input.write(`http://localhost:${address.port}/oauth/microsoft/callback?state=${state}&code=pasted-code\n`);

    await expect(flow).resolves.toMatchObject({ email: 'me@example.com' });
    expect(String(fetchMock.mock.calls[0]![1]?.body)).toContain('code=pasted-code');
  });
});
