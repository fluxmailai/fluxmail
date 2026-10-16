import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../src/config.js';
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_GOOGLE_CLIENT_SECRET } from '../src/accounts/defaultGoogleOAuth.js';
import {
  CUSTOM_GMAIL_SCOPES,
  GMAIL_SCOPES,
  exchangeCode,
  gmailScopes,
  identityFromIdToken,
  runLoopbackFlow,
} from '../src/accounts/googleAuth.js';

function oauthClient(claims: Record<string, unknown>): OAuth2Client {
  return {
    _clientId: 'client-id',
    verifyIdToken: vi.fn().mockResolvedValue({ getPayload: () => claims }),
  } as unknown as OAuth2Client;
}

describe('Google OAuth identity', () => {
  it('requests gmail.modify for built-in message and send-as access', () => {
    const config = {
      google: { clientId: DEFAULT_GOOGLE_CLIENT_ID, clientSecret: DEFAULT_GOOGLE_CLIENT_SECRET },
    } as FluxmailConfig;

    expect(gmailScopes(config)).toBe(GMAIL_SCOPES);
    expect(gmailScopes(config)).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(gmailScopes(config)).not.toContain('https://mail.google.com/');
  });

  it('requests full Gmail access for a custom app', () => {
    const config = { google: { clientId: 'custom-client-id', clientSecret: 'custom-client-secret' } } as FluxmailConfig;

    expect(gmailScopes(config)).toBe(CUSTOM_GMAIL_SCOPES);
    expect(gmailScopes(config)).toContain('https://mail.google.com/');
  });

  it('verifies the id token against the configured client id', async () => {
    const client = oauthClient({
      email: 'me@example.com',
      email_verified: true,
      name: 'Example User',
    });

    await expect(identityFromIdToken(client, { id_token: 'signed-token' })).resolves.toEqual({
      email: 'me@example.com',
      displayName: 'Example User',
    });
    expect(client.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'signed-token',
      audience: 'client-id',
    });
  });

  it('rejects an unverified email claim', async () => {
    const client = oauthClient({ email: 'me@example.com', email_verified: false });

    await expect(identityFromIdToken(client, { id_token: 'signed-token' })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('rejects a verified token with no claims payload', async () => {
    const client = oauthClient({});
    vi.mocked(client.verifyIdToken).mockResolvedValue({ getPayload: () => undefined } as never);

    await expect(identityFromIdToken(client, { id_token: 'signed-token' })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });
});

describe('Google OAuth token exchange', () => {
  it('surfaces the provider description without including other response fields', async () => {
    const client = {
      getToken: vi.fn().mockRejectedValue({
        response: {
          data: {
            error: 'invalid_request',
            error_description: 'client_secret is missing.',
            private_context: 'do-not-log-this',
          },
        },
      }),
    } as unknown as OAuth2Client;

    const result = exchangeCode(client, 'authorization-code', 'code-verifier');

    await expect(result).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'Google OAuth token exchange failed: client_secret is missing.',
    });
    await expect(result).rejects.not.toThrow(/do-not-log-this/);
  });
});

describe('Google OAuth granted scopes', () => {
  function tokenClient(scope: string): OAuth2Client {
    const client = oauthClient({ email: 'me@example.com', email_verified: true });
    return Object.assign(client, {
      getToken: vi.fn().mockResolvedValue({
        tokens: { id_token: 'signed-token', refresh_token: 'refresh-token', scope },
      }),
    });
  }

  it.each([
    { app: 'built-in', scopes: GMAIL_SCOPES },
    { app: 'custom', scopes: CUSTOM_GMAIL_SCOPES },
  ])('accepts a $app app grant that includes Gmail access', async ({ scopes }) => {
    await expect(exchangeCode(tokenClient(scopes.join(' ')), 'authorization-code')).resolves.toMatchObject({
      email: 'me@example.com',
    });
  });

  it('rejects a grant where the Gmail permission was not selected', async () => {
    const client = tokenClient('openid https://www.googleapis.com/auth/userinfo.email');

    await expect(exchangeCode(client, 'authorization-code')).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('Google did not grant access to Gmail'),
    });
    expect(client.verifyIdToken).not.toHaveBeenCalled();
  });
});

describe('Google OAuth callback listener', () => {
  it('explains how to connect an account when Docker is using the callback port', async () => {
    const existingServer = createServer();
    await new Promise<void>((resolve) => existingServer.listen(0, '127.0.0.1', resolve));
    const address = existingServer.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');

    const config: FluxmailConfig = {
      dataDir: '/tmp/fluxmail-test',
      dbPath: '/tmp/fluxmail-test/fluxmail.db',
      encryptionKey: Buffer.alloc(32),
      port: 8977,
      publicUrl: 'http://127.0.0.1:8977',
      publicUrlConfigured: false,
      oauthPort: address.port,
      oauthHost: '127.0.0.1',
      maxAttachmentBytes: 10 * 1024 * 1024,
      google: { clientId: 'client-id', clientSecret: 'client-secret' },
    };

    try {
      const flow = expect(runLoopbackFlow(config, vi.fn())).rejects;
      await flow.toThrow(
        new RegExp(
          `OAuth callback port ${address.port} is already in use[\\s\\S]*` +
            'docker compose exec fluxmail fluxmail accounts add gmail',
        ),
      );
      await flow.not.toThrow(/--owner/);
    } finally {
      await new Promise<void>((resolve, reject) => existingServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('shows a browser error when the authorized account is rejected', async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    await new Promise<void>((resolve, reject) => portProbe.close((err) => (err ? reject(err) : resolve())));

    const getToken = vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'refresh-token', id_token: 'id-token' },
      res: null,
    });
    const verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({ email: 'other@example.com', email_verified: true }),
    } as never);
    const generateCodeVerifier = vi.spyOn(OAuth2Client.prototype, 'generateCodeVerifierAsync').mockResolvedValue({
      codeVerifier: 'local-code-verifier',
      codeChallenge: 'local-code-challenge',
    });
    let provideAuthUrl!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
      provideAuthUrl = resolve;
    });
    const config: FluxmailConfig = {
      dataDir: '/tmp/fluxmail-test',
      dbPath: '/tmp/fluxmail-test/fluxmail.db',
      encryptionKey: Buffer.alloc(32),
      port: 8977,
      publicUrl: 'http://127.0.0.1:8977',
      publicUrlConfigured: false,
      oauthPort: address.port,
      oauthHost: '127.0.0.1',
      maxAttachmentBytes: 10 * 1024 * 1024,
      google: { clientId: 'client-id', clientSecret: 'client-secret' },
    };

    try {
      const oauthClient = { ...config.google! };
      const flow = runLoopbackFlow(config, provideAuthUrl, (result) => {
        expect(result.oauthClient).toEqual(oauthClient);
        throw new EmailError(
          'invalid_request',
          'Google authorized other@example.com, but the stored account belongs to expected@example.com.',
        );
      });
      const flowError = expect(flow).rejects.toThrow(/Google authorized other@example.com/);
      const authorizationUrl = new URL(await authUrl);
      const state = authorizationUrl.searchParams.get('state');
      config.google = { clientId: 'replacement-client-id', clientSecret: 'replacement-secret' };
      expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${address.port}/oauth/callback`);
      expect(authorizationUrl.searchParams.get('client_id')).toBe(oauthClient.clientId);
      expect(authorizationUrl.searchParams.get('code_challenge')).toBe('local-code-challenge');
      expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/oauth/callback?state=${state}&code=authorization-code`,
      );
      const page = await response.text();

      expect(response.status).toBe(400);
      expect(page).toContain('Fluxmail could not connect this account');
      expect(page).toContain('Google authorized other@example.com');
      expect(page).not.toContain('is connected to Fluxmail');
      expect(getToken).toHaveBeenCalledWith({
        code: 'authorization-code',
        codeVerifier: 'local-code-verifier',
      });
      await flowError;
    } finally {
      getToken.mockRestore();
      verifyIdToken.mockRestore();
      generateCodeVerifier.mockRestore();
    }
  });

  it('finishes with a callback URL pasted from a browser on another computer', async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    await new Promise<void>((resolve, reject) => portProbe.close((err) => (err ? reject(err) : resolve())));

    const getToken = vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'refresh-token', id_token: 'id-token' },
      res: null,
    });
    const verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({ email: 'me@example.com', email_verified: true }),
    } as never);
    const generateCodeVerifier = vi.spyOn(OAuth2Client.prototype, 'generateCodeVerifierAsync').mockResolvedValue({
      codeVerifier: 'local-code-verifier',
      codeChallenge: 'local-code-challenge',
    });
    let provideAuthUrl!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
      provideAuthUrl = resolve;
    });
    const input = new PassThrough();
    const onCallback = vi.fn();
    const config: FluxmailConfig = {
      dataDir: '/tmp/fluxmail-test',
      dbPath: '/tmp/fluxmail-test/fluxmail.db',
      encryptionKey: Buffer.alloc(32),
      port: 8977,
      publicUrl: 'http://127.0.0.1:8977',
      publicUrlConfigured: false,
      oauthPort: address.port,
      oauthHost: '127.0.0.1',
      maxAttachmentBytes: 10 * 1024 * 1024,
      google: { clientId: 'client-id', clientSecret: 'client-secret' },
    };

    try {
      const flow = runLoopbackFlow(config, provideAuthUrl, undefined, {
        paste: { input, write: vi.fn() },
        onCallback,
      });
      const state = new URL(await authUrl).searchParams.get('state');
      input.write(`http://127.0.0.1:${address.port}/oauth/callback?state=${state}&code=pasted-code\n`);

      await expect(flow).resolves.toMatchObject({ email: 'me@example.com' });
      expect(getToken).toHaveBeenCalledWith({ code: 'pasted-code', codeVerifier: 'local-code-verifier' });
      expect(onCallback).toHaveBeenCalledWith('pasted');
    } finally {
      getToken.mockRestore();
      verifyIdToken.mockRestore();
      generateCodeVerifier.mockRestore();
    }
  });
});
