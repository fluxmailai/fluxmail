import type { Provider } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';
import type { OAuthCallbackSource } from './oauthCallback.js';
import type { TelemetryProperties } from '../telemetry.js';
import { checkLicenseState } from '../licensing/entitlements.js';
import type { FluxmailDb } from '../storage/db.js';
import { DEFAULT_GOOGLE_CLIENT_ID } from './defaultGoogleOAuth.js';
import type { AccountRegistry } from './registry.js';

/** Where the provider sends the browser after consent. */
export type ConnectionFlow = 'hosted' | 'loopback' | 'imap_credentials';
export type ConnectionStage =
  | 'cli_validation'
  | 'connection_request'
  | 'server_validation'
  | 'provider_check'
  | 'account_persist'
  | 'oauth_prepare'
  | 'complete';
export type ConnectionFailureKind =
  | 'client_timeout'
  | 'provider_error'
  | 'validation_error'
  | 'transport_error'
  | 'server_error'
  | 'http_error'
  | 'unknown';

/** Convert an error's safe code and HTTP status to a bounded diagnostic category. */
export function connectionFailureKind(code: string, status?: number, transportError = false): ConnectionFailureKind {
  if (code === 'request_timeout' && (status === undefined || status === 0)) return 'client_timeout';
  if (code === 'provider_unavailable') return 'provider_error';
  if (code === 'invalid_request' || status === 400) return 'validation_error';
  if (transportError) return 'transport_error';
  if (status !== undefined && status >= 500) return 'server_error';
  if (status !== undefined && status >= 400) return 'http_error';
  return 'unknown';
}

/** Fluxmail's built-in OAuth application, or one the operator registered. */
export type OAuthAppKind = 'built-in' | 'custom';

/**
 * Outlook has no built-in application, so any Entra app the instance uses is
 * the operator's own.
 */
export function oauthAppKind(provider: Provider, clientId: string | undefined): OAuthAppKind | undefined {
  if (provider === 'imap' || !clientId) return undefined;
  return provider === 'gmail' && clientId === DEFAULT_GOOGLE_CLIENT_ID ? 'built-in' : 'custom';
}

/** The OAuth application this instance is configured to use for a provider. */
export function configuredOAuthAppKind(config: FluxmailConfig, provider: Provider): OAuthAppKind | undefined {
  return oauthAppKind(provider, provider === 'gmail' ? config.google?.clientId : config.microsoft?.clientId);
}

export interface ConnectionTelemetry {
  provider: Provider;
  /** Omit when the surface cannot tell a reconnection from a new mailbox. */
  reauthorize?: boolean;
  flow?: ConnectionFlow;
  oauthApp?: OAuthAppKind;
  /** How a loopback callback reached the CLI, or that it timed out waiting. */
  callback?: OAuthCallbackSource;
  stage?: ConnectionStage;
}

/** Describe a connection attempt without naming the mailbox it connects. */
export function connectionProperties(connection: ConnectionTelemetry): TelemetryProperties {
  return {
    provider: connection.provider,
    ...(connection.reauthorize === undefined ? {} : { reauthorize: connection.reauthorize }),
    ...(connection.flow ? { connection_flow: connection.flow } : {}),
    ...(connection.oauthApp ? { oauth_app: connection.oauthApp } : {}),
    ...(connection.callback ? { oauth_callback: connection.callback } : {}),
    ...(connection.stage ? { connection_stage: connection.stage } : {}),
  };
}

/** Mailbox totals by provider. Counts only: no address, id, or credential. */
export function accountInventoryProperties(
  registry: Pick<AccountRegistry, 'accountProviderCounts'> | undefined,
): TelemetryProperties {
  try {
    const counts = registry?.accountProviderCounts();
    if (!counts) return {};
    return {
      account_count: counts.total,
      gmail_account_count: counts.gmail,
      outlook_account_count: counts.outlook,
      imap_account_count: counts.imap,
    };
  } catch {
    // Telemetry must never affect a connection result.
    return {};
  }
}

const TELEMETRY_PLANS = new Set(['personal', 'pro', 'team', 'business', 'enterprise']);

/** Plan and installation totals for server start. Counts only: no address, id, or license key. */
export function instanceUsageProperties(db: Pick<FluxmailDb, 'select'>): TelemetryProperties {
  try {
    const state = checkLicenseState(db);
    return {
      // Lease plan names are free text; send only known plans.
      plan: TELEMETRY_PLANS.has(state.entitlements.plan) ? state.entitlements.plan : 'other',
      account_count: state.accountCount,
      member_count: state.memberCount,
    };
  } catch {
    // Telemetry must never affect server startup.
    return {};
  }
}
