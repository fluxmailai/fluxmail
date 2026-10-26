import { EmailError, isEmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../config.js';
import type { FluxmailDb } from '../storage/db.js';
import {
  createGmailConnectionGrant,
  createOutlookConnectionGrant,
  type GmailConnectionIntent,
} from '../storage/gmailConnectionGrants.js';
import { requireHostedGoogleConfig } from './googleAuth.js';
import { requireHostedMicrosoftConfig } from './microsoftAuth.js';

export type GmailConnectionMode = 'local' | 'hosted';

function isLoopbackPublicUrl(publicUrl: string): boolean {
  const hostname = new URL(publicUrl).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validateAccountConnectionFlags(
  provider: 'gmail' | 'outlook' | 'imap',
  options: { local?: boolean; hosted?: boolean },
): void {
  if (provider === 'imap' && (options.local || options.hosted)) {
    throw new EmailError('invalid_request', '--local and --hosted are only available for OAuth accounts.');
  }
}

export function selectGmailConnectionMode(
  config: FluxmailConfig,
  options: { local?: boolean; hosted?: boolean },
): GmailConnectionMode {
  if (options.local && options.hosted) {
    throw new EmailError('invalid_request', '--local and --hosted cannot be used together.');
  }
  if (options.hosted && !config.publicUrlConfigured) {
    throw new EmailError('invalid_request', '--hosted requires FLUXMAIL_PUBLIC_URL to be set.');
  }
  return options.hosted || (config.publicUrlConfigured && !options.local && !isLoopbackPublicUrl(config.publicUrl))
    ? 'hosted'
    : 'local';
}

/**
 * Confirm the hosted OAuth application exists before a connection grant is
 * minted. `remedy` lets a caller append the escape hatch its surface offers.
 */
export function assertHostedConnectionReady(
  config: FluxmailConfig,
  provider: 'gmail' | 'outlook',
  remedy?: string,
): void {
  try {
    if (provider === 'gmail') requireHostedGoogleConfig(config);
    else requireHostedMicrosoftConfig(config);
  } catch (error) {
    if (!remedy || !isEmailError(error)) throw error;
    throw new EmailError(error.code, `${error.message} ${remedy}`);
  }
}

export function prepareHostedGmailConnection(
  db: FluxmailDb,
  config: FluxmailConfig,
  intent: GmailConnectionIntent,
): { connectionUrl: string; expiresAt: number } {
  requireHostedGoogleConfig(config);
  const { token, expiresAt } = createGmailConnectionGrant(db, intent);
  return {
    connectionUrl: `${config.publicUrl}/auth/google/connect?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

export function prepareHostedOutlookConnection(
  db: FluxmailDb,
  config: FluxmailConfig,
  intent: GmailConnectionIntent,
): { connectionUrl: string; expiresAt: number } {
  requireHostedMicrosoftConfig(config);
  const { token, expiresAt } = createOutlookConnectionGrant(db, intent);
  return {
    connectionUrl: `${config.publicUrl}/auth/microsoft/connect?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}
