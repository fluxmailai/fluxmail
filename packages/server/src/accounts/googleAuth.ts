import { randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { EmailError } from '@fluxmail/core';
import { googleTransporterOptions } from '@fluxmail/provider-gmail';
import type { FluxmailConfig } from '../config.js';
import type { StoredGoogleOAuthApp } from '../instanceConfig.js';
import { DEFAULT_GOOGLE_CLIENT_ID } from './defaultGoogleOAuth.js';
import { runOAuthCallbackFlow, type LoopbackFlowOptions, type OAuthAuthUrlContext } from './oauthCallback.js';

const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'];

/**
 * The built-in app uses Fluxmail's approved Gmail permission. Google lists
 * gmail.modify as an allowed scope for users.settings.sendAs.list:
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', ...GOOGLE_IDENTITY_SCOPES];

/** Custom OAuth apps retain full Gmail support, including permanent deletion. */
export const CUSTOM_GMAIL_SCOPES = ['https://mail.google.com/', ...GOOGLE_IDENTITY_SCOPES];

const GMAIL_ACCESS_SCOPES = [GMAIL_SCOPES[0]!, CUSTOM_GMAIL_SCOPES[0]!];

export function requireGoogleConfig(config: FluxmailConfig): { clientId: string; clientSecret: string } {
  if (!config.google) {
    throw new EmailError(
      'invalid_request',
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID to use a custom OAuth app.',
    );
  }
  return config.google;
}

export function requireHostedGoogleConfig(config: FluxmailConfig): { clientId: string; clientSecret: string } {
  const google = requireGoogleConfig(config);
  if (google.clientId === DEFAULT_GOOGLE_CLIENT_ID || !google.clientSecret) {
    // Only claim FLUXMAIL_PUBLIC_URL is set when it is: the REST connection routes
    // reach this check on servers running without a configured public URL.
    throw new EmailError(
      'invalid_request',
      (config.publicUrlConfigured
        ? 'FLUXMAIL_PUBLIC_URL is set, so Gmail uses the hosted connection flow, which needs your own Google Web application.'
        : 'Hosted Gmail connections need your own Google Web application.') +
        ' Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    );
  }
  return { clientId: google.clientId, clientSecret: google.clientSecret };
}

export function createOAuthClient(
  config: FluxmailConfig,
  redirectUri: string,
  oauthClient: StoredGoogleOAuthApp = requireGoogleConfig(config),
): OAuth2Client {
  const { clientId, clientSecret } = oauthClient;
  return new OAuth2Client({ clientId, clientSecret, redirectUri, transporterOptions: googleTransporterOptions() });
}

export function gmailScopes(
  config: FluxmailConfig,
  oauthClient: StoredGoogleOAuthApp = requireGoogleConfig(config),
): string[] {
  return oauthClient.clientId === DEFAULT_GOOGLE_CLIENT_ID ? GMAIL_SCOPES : CUSTOM_GMAIL_SCOPES;
}

export function buildAuthUrl(client: OAuth2Client, state: string, scopes: string[], codeChallenge?: string): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
    ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 } : {}),
  });
}

/** Verify the OAuth id_token and extract the authenticated Google identity. */
export async function identityFromIdToken(
  client: OAuth2Client,
  tokens: Credentials,
): Promise<{ email: string; displayName?: string }> {
  const idToken = tokens.id_token;
  if (!idToken) throw new EmailError('provider_unavailable', 'Google did not return an id_token');
  if (!client._clientId) throw new EmailError('provider_unavailable', 'Google OAuth client has no client id');
  const ticket = await client.verifyIdToken({ idToken, audience: client._clientId });
  const claims = ticket.getPayload();
  if (!claims) throw new EmailError('provider_unavailable', 'Google id_token has no claims');
  if (!claims.email) throw new EmailError('provider_unavailable', 'Google id_token has no email claim');
  if (!claims.email_verified) {
    throw new EmailError('provider_unavailable', 'Google did not verify the account email address');
  }
  return { email: claims.email, ...(claims.name ? { displayName: claims.name } : {}) };
}

export interface OAuthResult {
  email: string;
  displayName?: string;
  tokens: Credentials;
}

export interface AuthorizedOAuthResult extends OAuthResult {
  oauthClient: StoredGoogleOAuthApp;
}

function oauthErrorText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 300) : undefined;
}

function googleTokenError(err: unknown): EmailError {
  const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
  const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
  const code = oauthErrorText(payload?.error);
  const description = oauthErrorText(payload?.error_description);
  const detail =
    description ?? code ?? oauthErrorText(err instanceof Error ? err.message : undefined) ?? 'unknown error';
  return new EmailError('provider_unavailable', `Google OAuth token exchange failed: ${detail}`);
}

export async function exchangeCode(client: OAuth2Client, code: string, codeVerifier?: string): Promise<OAuthResult> {
  let tokens: Credentials;
  try {
    ({ tokens } = await client.getToken({ code, ...(codeVerifier ? { codeVerifier } : {}) }));
  } catch (err) {
    throw googleTokenError(err);
  }
  if (!tokens.refresh_token) {
    throw new EmailError(
      'invalid_request',
      "Google did not return a refresh token. Remove Fluxmail from the account's third-party access " +
        '(myaccount.google.com/permissions) and try again.',
    );
  }
  // Google's consent screen lets people clear the Gmail checkbox. The grant then
  // succeeds, but every Gmail API call fails with an insufficient scope error.
  const granted = tokens.scope?.split(/\s+/);
  if (granted && !GMAIL_ACCESS_SCOPES.some((scope) => granted.includes(scope))) {
    throw new EmailError(
      'invalid_request',
      "Google did not grant access to Gmail. Connect the account again and select the Gmail permission on Google's consent screen.",
    );
  }
  return { ...(await identityFromIdToken(client, tokens)), tokens };
}

/**
 * Loopback OAuth flow for the CLI: listens once on config.oauthPort, prints the
 * consent URL, and resolves when Google redirects back with a code or when the
 * user pastes the callback URL into the terminal.
 */
export async function runLoopbackFlow<T = AuthorizedOAuthResult>(
  config: FluxmailConfig,
  onAuthUrl: (url: string, context: OAuthAuthUrlContext) => void,
  onAuthorized?: (result: AuthorizedOAuthResult) => T | Promise<T>,
  options?: LoopbackFlowOptions,
): Promise<T> {
  const oauthClient = { ...requireGoogleConfig(config) };
  const redirectUri = `http://127.0.0.1:${config.oauthPort}/oauth/callback`;
  const client = createOAuthClient(config, redirectUri, oauthClient);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString('hex');

  return runOAuthCallbackFlow({
    provider: 'gmail',
    redirectUri,
    host: config.oauthHost,
    port: config.oauthPort,
    state,
    authUrl: buildAuthUrl(client, state, gmailScopes(config, oauthClient), codeChallenge),
    onAuthUrl,
    complete: async (code) => {
      const result = { ...(await exchangeCode(client, code, codeVerifier)), oauthClient };
      const value = onAuthorized ? await onAuthorized(result) : (result as T);
      return { email: result.email, value };
    },
    options,
  });
}
