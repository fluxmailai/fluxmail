import { EmailError, isEmailError } from '@fluxmail/core';

/** Validation produced by Fluxmail from caller input, safe to return to that caller. */
export class ClientInputError extends EmailError {
  constructor(code: 'invalid_request', message: string, data?: Record<string, unknown>) {
    super(code, message, data);
  }
}

/** Fixed support-service failures, with no remote response text or transport causes. */
export class FeedbackError extends EmailError {
  constructor(
    code: 'invalid_request' | 'rate_limited' | 'provider_unavailable' | 'permission_denied',
    message: string,
  ) {
    super(code, message);
  }
}

/** A send from a confirmation card that no longer matches what the user approved. The message is fixed text. */
export class SendConfirmationError extends EmailError {
  constructor(message: string) {
    super('idempotency_conflict', message);
  }
}

/**
 * Why a send from a confirmation card was refused: the same email was already sent or is scheduled, the
 * message changed after the preview, the card's key expired, or the message could no longer be resolved.
 */
export type CardRefusal = 'sent' | 'scheduled' | 'changed' | 'expired' | 'unresolved';

const cardRefusals = new WeakMap<object, CardRefusal>();

/** Tags the error a refused card send throws with its reason, for telemetry. */
export function asCardRefusal<E>(error: E, reason: CardRefusal): E {
  if (error && typeof error === 'object' && !cardRefusals.has(error)) cardRefusals.set(error, reason);
  return error;
}

/** The reason a card send was refused, when the error came from that check. */
export function cardRefusal(error: unknown): CardRefusal | undefined {
  return error && typeof error === 'object' ? cardRefusals.get(error) : undefined;
}

/** A capability check failure whose message names the missing capabilities and how to enable them. */
export class MissingCapabilityError extends EmailError {
  constructor(message: string, missingCapabilities: readonly string[]) {
    super('permission_denied', message, { missingCapabilities: [...missingCapabilities] });
  }
}

/** The local data directory has never been set up. The message gives the setup steps. */
export class SetupRequiredError extends EmailError {
  constructor(message: string) {
    super('invalid_request', message);
  }
}

const BYTES_PER_MEGABYTE = 1024 * 1024;

function sizeLabel(bytes: number): string {
  return bytes % BYTES_PER_MEGABYTE === 0 ? `${bytes / BYTES_PER_MEGABYTE} MB` : `${bytes} bytes`;
}

/** An attachment over the configured limit, with the limit in the message so the caller knows why. */
export function attachmentTooLarge(surface: 'MCP' | 'the REST API', maxBytes: number, sizeBytes?: number) {
  return new ClientInputError(
    'invalid_request',
    `Attachment is too large to return through ${surface}, which returns attachments up to ${sizeLabel(maxBytes)}.`,
    { ...(sizeBytes !== undefined ? { sizeBytes } : {}), maxBytes },
  );
}

/** Providers report an oversized attachment as a plain EmailError, which publicError would hide. */
export function isAttachmentSizeError(error: unknown): error is EmailError {
  return (
    isEmailError(error) &&
    !(error instanceof ClientInputError) &&
    error.code === 'invalid_request' &&
    typeof error.data?.maxBytes === 'number'
  );
}

const MESSAGES: Record<string, string> = {
  auth_expired: 'The account needs to be connected again.',
  rate_limited: 'The mail provider is rate limiting requests. Try again later.',
  not_found: 'The requested mail item was not found.',
  invalid_request: 'The mail provider rejected these arguments. Check them and any pageToken.',
  idempotency_conflict: 'This idempotency key belongs to a different delivery request.',
  provider_unavailable: 'The mail provider could not complete the request.',
  entitlement_exceeded: 'The current subscription does not allow this operation.',
  permission_denied: 'This credential cannot perform the operation.',
  unsupported_capability: 'The provider does not support this operation.',
  internal: 'The request could not be completed.',
};

const DELIVERY_MESSAGES: Record<string, string> = {
  canceled: 'The scheduled send was canceled.',
  invalid_request: 'The mail provider rejected this message. Check its recipients and attachments.',
  not_found: 'The draft or original message was not found.',
};

/** Explains a failed or uncertain delivery operation from its stored status and error code. */
export function deliveryErrorMessage(status: string, code: string): string {
  if (status === 'uncertain')
    return "Fluxmail can't confirm whether the message was sent. Check Sent before sending again.";
  return DELIVERY_MESSAGES[code] ?? MESSAGES[code] ?? MESSAGES.internal!;
}

const REQUEST_TIMEOUT_MESSAGE = 'The mail provider took too long to respond.';
const UNTRUSTED_CERTIFICATE_MESSAGE =
  "The mail server's certificate isn't trusted. See https://fluxmail.ai/docs/troubleshooting#the-mail-servers-certificate-isnt-trusted.";

function isSearchTimeout(error: unknown): error is EmailError {
  return isEmailError(error) && error.failure?.reason === 'search_timeout';
}

function safeMessage(error: unknown, code: string): string {
  if (
    error instanceof ClientInputError ||
    error instanceof MissingCapabilityError ||
    error instanceof FeedbackError ||
    error instanceof SetupRequiredError ||
    error instanceof SendConfirmationError
  )
    return error.message;
  if (code === 'provider_unavailable' && isEmailError(error) && error.failure?.reason === 'request_timeout') {
    return REQUEST_TIMEOUT_MESSAGE;
  }
  if (code === 'provider_unavailable' && isEmailError(error) && error.failure?.reason === 'tls_untrusted') {
    return UNTRUSTED_CERTIFICATE_MESSAGE;
  }
  if (isSearchTimeout(error)) return error.message;
  return MESSAGES[code] ?? MESSAGES.internal!;
}

export function publicError(
  error: unknown,
  requestId: string,
): {
  code: string;
  message: string;
  requestId: string;
  data?: Record<string, unknown>;
} {
  const code = isEmailError(error) ? error.code : 'internal';
  const retryAfterMs = isEmailError(error) ? error.data?.retryAfterMs : undefined;
  const unsupportedSearchOptions = isEmailError(error) ? error.data?.unsupportedSearchOptions : undefined;
  const diagnostics = error instanceof ClientInputError ? error.data?.diagnostics : undefined;
  const missingCapabilities = error instanceof MissingCapabilityError ? error.data?.missingCapabilities : undefined;
  const data = {
    ...(missingCapabilities !== undefined ? { missingCapabilities } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
    ...(Array.isArray(unsupportedSearchOptions) ? { unsupportedSearchOptions } : {}),
    ...(isSearchTimeout(error) ? { reason: 'search_timeout', exhausted: false } : {}),
  };
  return {
    code,
    message: safeMessage(error, code),
    requestId,
    ...(Object.keys(data).length ? { data } : {}),
  };
}
