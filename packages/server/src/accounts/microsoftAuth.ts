import { createHash, randomBytes } from 'node:crypto';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';
import type { StoredMicrosoftOAuthApp } from '../instanceConfig.js';
import { runOAuthCallbackFlow, type LoopbackFlowOptions, type OAuthAuthUrlContext } from './oauthCallback.js';

export const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxSettings.Read',
];

export interface MicrosoftCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  /** Hosted callbacks use a confidential client; loopback callbacks use PKCE only. */
  clientAuth?: 'public' | 'confidential';
  /** OAuth application that issued the refresh token. */
  fluxmailOAuthClient?: StoredMicrosoftOAuthApp;
}

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface MicrosoftOAuthResult {
  email: string;
  displayName?: string;
  credentials: MicrosoftCredentials;
}

export function requireMicrosoftConfig(config: FluxmailConfig): NonNullable<FluxmailConfig['microsoft']> {
  if (!config.microsoft) {
    throw new EmailError(
      'invalid_request',
      'MICROSOFT_CLIENT_ID is not set. Register an app in Microsoft Entra, then set its application client ID. See https://fluxmail.ai/docs/connect-outlook-to-mcp.',
    );
  }
  return config.microsoft;
}

export function requireHostedMicrosoftConfig(config: FluxmailConfig): NonNullable<FluxmailConfig['microsoft']> {
  const microsoft = requireMicrosoftConfig(config);
  if (!microsoft.clientSecret) {
    // Only claim FLUXMAIL_PUBLIC_URL is set when it is: the REST connection routes
    // reach this check on servers running without a configured public URL.
    throw new EmailError(
      'invalid_request',
      (config.publicUrlConfigured
        ? 'FLUXMAIL_PUBLIC_URL is set, so Outlook uses the hosted connection flow, which needs a client secret.'
        : 'Hosted Outlook connections need a client secret.') +
        ' Add a Web redirect URI and MICROSOFT_CLIENT_SECRET to the Entra app.',
    );
  }
  return microsoft;
}

function tenantEndpoint(microsoft: StoredMicrosoftOAuthApp, path: 'authorize' | 'token'): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(microsoft.tenantId)}/oauth2/v2.0/${path}`;
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildMicrosoftAuthUrl(
  config: FluxmailConfig,
  redirectUri: string,
  state: string,
  verifier: string,
  oauthClient: StoredMicrosoftOAuthApp = requireMicrosoftConfig(config),
): string {
  const microsoft = oauthClient;
  const url = new URL(tenantEndpoint(microsoft, 'authorize'));
  url.search = new URLSearchParams({
    client_id: microsoft.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

async function tokenRequest(
  microsoft: StoredMicrosoftOAuthApp,
  params: Record<string, string>,
  clientAuth: 'public' | 'confidential',
): Promise<MicrosoftTokenResponse> {
  if (clientAuth === 'confidential' && !microsoft.clientSecret) {
    throw new EmailError('invalid_request', 'MICROSOFT_CLIENT_SECRET is required for hosted Outlook connections.');
  }
  const body = new URLSearchParams({
    client_id: microsoft.clientId,
    ...params,
    ...(clientAuth === 'confidential' ? { client_secret: microsoft.clientSecret! } : {}),
  });
  const response = await fetch(tenantEndpoint(microsoft, 'token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = (await response.json()) as MicrosoftTokenResponse;
  if (!response.ok || payload.error) {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    const code = /invalid_grant/i.test(payload.error ?? '') ? 'auth_expired' : 'provider_unavailable';
    throw new EmailError(code, `Microsoft OAuth failed: ${detail}`, undefined, {
      httpStatus: response.status,
      reason: 'http_error',
    });
  }
  return payload;
}

function credentialsFromToken(
  payload: MicrosoftTokenResponse,
  clientAuth: 'public' | 'confidential',
  microsoft: StoredMicrosoftOAuthApp,
  previousRefreshToken?: string,
): MicrosoftCredentials {
  if (!payload.access_token) throw new EmailError('provider_unavailable', 'Microsoft did not return an access token');
  const refreshToken = payload.refresh_token ?? previousRefreshToken;
  if (!refreshToken) {
    throw new EmailError(
      'invalid_request',
      'Microsoft did not return a refresh token. Confirm offline_access consent and try again.',
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: Date.now() + Math.max(payload.expires_in ?? 3_600, 60) * 1_000,
    clientAuth,
    fluxmailOAuthClient: { ...microsoft },
    ...(payload.scope ? { scope: payload.scope } : {}),
  };
}

export async function refreshMicrosoftCredentials(
  config: FluxmailConfig,
  credentials: MicrosoftCredentials,
): Promise<MicrosoftCredentials> {
  const microsoft = credentials.fluxmailOAuthClient ?? requireMicrosoftConfig(config);
  const clientAuth = credentials.clientAuth ?? (microsoft.clientSecret ? 'confidential' : 'public');
  const refreshScope = credentials.scope?.trim();
  const payload = await tokenRequest(
    microsoft,
    {
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      ...(refreshScope ? { scope: refreshScope } : {}),
    },
    clientAuth,
  );
  return credentialsFromToken(payload, clientAuth, microsoft, credentials.refreshToken);
}

async function microsoftIdentity(accessToken: string): Promise<{ email: string; displayName?: string }> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const payload = (await response.json()) as {
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new EmailError(
      response.status === 401 ? 'auth_expired' : 'provider_unavailable',
      `Microsoft Graph could not read the signed-in account: ${payload.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  const email = payload.mail?.trim() || payload.userPrincipalName?.trim();
  if (!email) throw new EmailError('provider_unavailable', 'Microsoft Graph returned no mailbox address');
  const displayName = payload.displayName?.trim();
  return { email, ...(displayName ? { displayName } : {}) };
}

async function verifyMicrosoftMailbox(accessToken: string): Promise<void> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  let payload: { id?: string | null; error?: { message?: string } } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // Microsoft Graph can return an empty or non-JSON gateway response.
  }
  if (!response.ok) {
    const code =
      response.status === 401 ? 'auth_expired' : response.status === 403 ? 'permission_denied' : 'provider_unavailable';
    throw new EmailError(
      code,
      `Microsoft Graph could not access this account's mailbox: ${payload.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  if (!payload.id) {
    throw new EmailError('provider_unavailable', "Microsoft Graph could not access this account's mailbox");
  }
}

export async function exchangeMicrosoftCode(
  config: FluxmailConfig,
  code: string,
  redirectUri: string,
  verifier: string,
  clientAuth: 'public' | 'confidential' = 'public',
  oauthClient: StoredMicrosoftOAuthApp = requireMicrosoftConfig(config),
): Promise<MicrosoftOAuthResult> {
  const microsoft = { ...oauthClient };
  const payload = await tokenRequest(
    microsoft,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: MICROSOFT_SCOPES.join(' '),
    },
    clientAuth,
  );
  const credentials = credentialsFromToken(payload, clientAuth, microsoft);
  const identity = await microsoftIdentity(credentials.accessToken);
  await verifyMicrosoftMailbox(credentials.accessToken);
  return { ...identity, credentials };
}

export async function runMicrosoftLoopbackFlow<T = MicrosoftOAuthResult>(
  config: FluxmailConfig,
  onAuthUrl: (url: string, context: OAuthAuthUrlContext) => void,
  onAuthorized?: (result: MicrosoftOAuthResult) => T | Promise<T>,
  options?: LoopbackFlowOptions,
): Promise<T> {
  const oauthClient = { ...requireMicrosoftConfig(config) };
  const redirectUri = `http://localhost:${config.oauthPort}/oauth/microsoft/callback`;
  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(48).toString('base64url');

  return runOAuthCallbackFlow({
    provider: 'outlook',
    redirectUri,
    host: config.oauthHost,
    port: config.oauthPort,
    state,
    authUrl: buildMicrosoftAuthUrl(config, redirectUri, state, verifier, oauthClient),
    onAuthUrl,
    complete: async (code) => {
      const result = await exchangeMicrosoftCode(config, code, redirectUri, verifier, 'public', oauthClient);
      const value = onAuthorized ? await onAuthorized(result) : (result as T);
      return { email: result.email, value };
    },
    options,
  });
}
