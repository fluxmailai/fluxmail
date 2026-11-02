import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { EmailError } from '@fluxmail/core';
import { MAIL_SCOPES, PERMISSION_PRESETS, type PermissionPreset } from '@fluxmail/core/mcp';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client';
import { runOAuthCallbackFlow, type LoopbackFlowOptions, type OAuthAuthUrlContext } from './accounts/oauthCallback.js';
import {
  clearCloudSession,
  cloudCredentialPath,
  currentRequestDeadlineMs,
  InstanceApiError,
  loadCloudSession,
  requestTimeoutError,
  saveCloudSession,
  type CloudSession,
} from './cliInstances.js';
import { DEFAULT_FEEDBACK_CLOUD_ORIGIN } from './feedback.js';
import { withAsyncFileLock } from './storage/fileLock.js';

export const DEFAULT_CLOUD_ORIGIN = DEFAULT_FEEDBACK_CLOUD_ORIGIN;

/** Refresh a little early so a token can't expire while a request is in flight. */
const ACCESS_TOKEN_MARGIN_MS = 30_000;
const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REFRESH_LOCK = { timeoutMs: 45_000, staleMs: 30_000, description: 'another Fluxmail Cloud token refresh' };

export function cloudMcpUrl(serverUrl: string): string {
  return `${serverUrl}/mcp`;
}

/**
 * Every Cloud request goes through here. Credentials stay on the profile's
 * origin and never follow a redirect, including OAuth endpoints a server names
 * in its metadata.
 */
export function cloudFetch(serverUrl: string): typeof fetch {
  const { origin } = new URL(serverUrl);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin) {
      throw new EmailError('permission_denied', 'Fluxmail Cloud named another server. Refusing to contact it.');
    }
    const deadline = AbortSignal.timeout(currentRequestDeadlineMs());
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal, redirect: 'manual' });
    } catch (error) {
      if (deadline.aborted) throw requestTimeoutError();
      if (init?.signal?.aborted) throw error;
      throw new InstanceApiError('request_failed', `Could not reach Fluxmail Cloud at ${origin}.`, 0);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new EmailError(
        'permission_denied',
        'Fluxmail Cloud redirected an authenticated request. Refusing to forward credentials.',
      );
    }
    return response;
  };
}

function sessionEndedError(instance: string): EmailError {
  return new EmailError(
    'permission_denied',
    `The Fluxmail Cloud session for "${instance}" has ended. Run "fluxmail --instance ${instance} login".`,
  );
}

function missingSessionError(instance: string): EmailError {
  return new EmailError('permission_denied', `Log in to instance "${instance}" first.`);
}

async function discover(serverUrl: string) {
  const sdk = await import('@modelcontextprotocol/client');
  const fetchFn = cloudFetch(serverUrl);
  const { authorizationServerUrl, authorizationServerMetadata: metadata } = await sdk.discoverOAuthServerInfo(
    cloudMcpUrl(serverUrl),
    { fetchFn },
  );
  return { sdk, fetchFn, authorizationServerUrl, metadata };
}

function oauthSession(clientId: string, tokens: OAuthTokens, previous?: { refreshToken: string }): CloudSession {
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) {
    throw new EmailError('invalid_request', 'Fluxmail Cloud did not issue a refresh token. Try logging in again.');
  }
  return {
    kind: 'oauth',
    clientId,
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_ACCESS_TOKEN_LIFETIME_MS),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
}

function refreshLockPath(): string {
  return path.join(path.dirname(cloudCredentialPath()), 'cloud-refresh.lock');
}

function usable(session: Extract<CloudSession, { kind: 'oauth' }>, rejected?: string): boolean {
  return session.accessToken !== rejected && session.expiresAt - Date.now() > ACCESS_TOKEN_MARGIN_MS;
}

/**
 * The bearer token for this instance. `rejected` names a token Cloud just
 * refused. Parallel CLI processes share one refresh token, and Cloud treats a
 * second use as replay and revokes the connection, so the refresh happens under
 * a lock with the session read again inside it.
 */
export async function cloudAccessToken(instance: string, serverUrl: string, rejected?: string): Promise<string> {
  const session = loadCloudSession(instance);
  if (!session) throw missingSessionError(instance);
  if (session.kind === 'key') {
    if (session.key === rejected) {
      throw new EmailError(
        'permission_denied',
        `Fluxmail Cloud rejected the API key for "${instance}". Run "fluxmail --instance ${instance} login --api-key" with an active key.`,
      );
    }
    return session.key;
  }
  if (usable(session, rejected)) return session.accessToken;
  return withAsyncFileLock(refreshLockPath(), REFRESH_LOCK, async () => {
    const current = loadCloudSession(instance);
    if (current?.kind !== 'oauth') throw missingSessionError(instance);
    if (usable(current, rejected)) return current.accessToken;
    const { sdk, fetchFn, authorizationServerUrl, metadata } = await discover(serverUrl);
    let tokens: OAuthTokens;
    try {
      tokens = await sdk.refreshAuthorization(authorizationServerUrl, {
        metadata,
        clientInformation: { client_id: current.clientId },
        refreshToken: current.refreshToken,
        resource: new URL(cloudMcpUrl(serverUrl)),
        fetchFn,
      });
    } catch (error) {
      if (error instanceof sdk.OAuthError && ['invalid_grant', 'invalid_client'].includes(error.code)) {
        throw sessionEndedError(instance);
      }
      throw error;
    }
    const next = oauthSession(current.clientId, tokens, current);
    saveCloudSession(instance, next);
    return tokens.access_token;
  });
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not choose an OAuth callback port.'));
      });
    });
  });
}

export interface CloudLoginOptions {
  instance: string;
  serverUrl: string;
  preset: PermissionPreset;
  onAuthUrl: (url: string, context: OAuthAuthUrlContext) => void;
  flow?: LoopbackFlowOptions;
}

/**
 * Browser sign-in. Each login registers its own public client: Cloud deletes
 * registered clients that have no tokens, so an ID kept across logins can go
 * stale, and the failure would only show in the browser.
 */
export async function loginToCloud(options: CloudLoginOptions): Promise<void> {
  const { instance, serverUrl, preset, onAuthUrl, flow } = options;
  const { sdk, fetchFn, authorizationServerUrl, metadata } = await discover(serverUrl);
  const resource = new URL(cloudMcpUrl(serverUrl));
  const port = await freeLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const clientInformation: OAuthClientInformationMixed = await sdk.registerClient(authorizationServerUrl, {
    metadata,
    fetchFn,
    clientMetadata: {
      client_name: 'Fluxmail CLI',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // Registration caps what any login can later ask for; the authorization request narrows it.
      scope: [...MAIL_SCOPES, 'offline_access'].join(' '),
    },
  });
  const state = randomBytes(32).toString('base64url');
  const { authorizationUrl, codeVerifier } = await sdk.startAuthorization(authorizationServerUrl, {
    metadata,
    clientInformation,
    redirectUrl: redirectUri,
    scope: [...PERMISSION_PRESETS[preset], 'offline_access'].join(' '),
    state,
    resource,
  });
  const tokens = await runOAuthCallbackFlow<OAuthTokens>({
    provider: 'cloud',
    redirectUri,
    host: '127.0.0.1',
    port,
    state,
    authUrl: authorizationUrl.href,
    onAuthUrl,
    successTitle: () => 'Signed in to Fluxmail Cloud',
    options: flow,
    complete: async (code, callback) => ({
      email: '',
      value: await sdk.exchangeAuthorization(authorizationServerUrl, {
        metadata,
        clientInformation,
        authorizationCode: code,
        iss: callback.searchParams.get('iss') ?? undefined,
        codeVerifier,
        redirectUri,
        resource,
        fetchFn,
      }),
    }),
  });
  const previous = loadCloudSession(instance);
  saveCloudSession(instance, oauthSession(clientInformation.client_id, tokens));
  // Each approval is a separate connection, so a repeat login must not leave the old one active.
  if (previous?.kind === 'oauth') await revokeCloudSession(serverUrl, previous).catch(() => false);
}

export async function revokeCloudSession(
  serverUrl: string,
  session: Extract<CloudSession, { kind: 'oauth' }>,
): Promise<boolean> {
  const { fetchFn, metadata } = await discover(serverUrl);
  const revocationEndpoint = (metadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  if (!revocationEndpoint) return false;
  const response = await fetchFn(revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: session.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: session.clientId,
    }),
  });
  return response.ok;
}

/** Forgets the local credentials even when Cloud can't be reached; reports whether the connection was revoked. */
export async function logoutOfCloud(instance: string, serverUrl: string): Promise<{ revoked: boolean }> {
  return withAsyncFileLock(refreshLockPath(), REFRESH_LOCK, async () => {
    const session = loadCloudSession(instance);
    if (!session) throw missingSessionError(instance);
    const revoked = session.kind === 'oauth' && (await revokeCloudSession(serverUrl, session).catch(() => false));
    clearCloudSession(instance);
    return { revoked };
  });
}

/** Best effort: the sign-in URL is always printed too. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  execFile(command, args, { timeout: 5_000 }, () => {}).unref();
}
