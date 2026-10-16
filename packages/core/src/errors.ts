import type { Provider } from './types.js';

export type EmailErrorCode =
  | 'auth_expired'
  | 'rate_limited'
  | 'not_found'
  | 'invalid_request'
  | 'idempotency_conflict'
  | 'provider_unavailable'
  | 'entitlement_exceeded'
  | 'permission_denied'
  | 'unsupported_capability';

export const MAIL_PROVIDERS: readonly Provider[] = ['gmail', 'imap', 'outlook'];

/** Fixed causes for a provider failure. These are safe to report in telemetry. */
export const FAILURE_REASONS = [
  'search_timeout',
  'insufficient_scope',
  'connection_refused',
  'host_not_found',
  'network_unreachable',
  'connection_timeout',
  'connection_reset',
  'tls_mismatch',
  'tls_error',
  'server_no',
  'server_bad',
  'http_error',
  'invalid_response',
  'other',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** The step of a provider call that failed. */
export const FAILURE_PHASES = [
  'connect',
  'folders',
  'select',
  'search',
  'fetch',
  'smtp',
  'token_refresh',
  'request',
] as const;
export type FailurePhase = (typeof FAILURE_PHASES)[number];

/** Node and TLS error codes that describe a network failure without revealing its target. */
export const FAILURE_IO_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
] as const;

/**
 * Structured detail about a provider failure. Every field is an allowlisted
 * value, so it can be reported without the error message.
 */
export interface ProviderFailure {
  provider?: Provider;
  reason?: FailureReason;
  phase?: FailurePhase;
  httpStatus?: number;
  ioCode?: string;
}

export class EmailError extends Error {
  readonly code: EmailErrorCode;
  /** Machine-readable extras, e.g. { reauthUrl } for auth_expired. */
  readonly data?: Record<string, unknown>;
  /** Diagnostic detail filled in by the provider and the service as the error propagates. */
  failure?: ProviderFailure;

  constructor(code: EmailErrorCode, message: string, data?: Record<string, unknown>, failure?: ProviderFailure) {
    super(message);
    this.name = 'EmailError';
    this.code = code;
    this.data = data;
    if (failure) this.failure = failure;
  }
}

const IO_REASONS: Record<string, FailureReason> = {
  ECONNREFUSED: 'connection_refused',
  ECONNRESET: 'connection_reset',
  ECONNABORTED: 'connection_reset',
  EPIPE: 'connection_reset',
  ETIMEDOUT: 'connection_timeout',
  ENOTFOUND: 'host_not_found',
  EAI_AGAIN: 'host_not_found',
  EHOSTUNREACH: 'network_unreachable',
  EHOSTDOWN: 'network_unreachable',
  ENETUNREACH: 'network_unreachable',
  ENETDOWN: 'network_unreachable',
};

/**
 * Classify a network or TLS failure from the error codes on an error and its
 * causes. Returns undefined when the error carries no recognized code.
 */
export function networkFailure(error: unknown): Pick<ProviderFailure, 'reason' | 'ioCode'> | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && (FAILURE_IO_CODES as readonly string[]).includes(code)) {
      return { reason: IO_REASONS[code] ?? 'tls_error', ioCode: code };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A provider response is missing data Fluxmail needs. */
export function invalidResponseError(message: string): EmailError {
  return new EmailError('provider_unavailable', message, undefined, { reason: 'invalid_response' });
}

export function isEmailError(err: unknown): err is EmailError {
  return err instanceof EmailError;
}
