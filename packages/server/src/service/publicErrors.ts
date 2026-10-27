import { EmailError, isEmailError } from '@fluxmail/core';

/** Validation produced by Fluxmail from caller input, safe to return to that caller. */
export class ClientInputError extends EmailError {
  constructor(code: 'invalid_request', message: string, data?: Record<string, unknown>) {
    super(code, message, data);
  }
}

/** A capability check failure whose message names the missing capabilities and how to enable them. */
export class MissingCapabilityError extends EmailError {
  constructor(message: string, missingCapabilities: readonly string[]) {
    super('permission_denied', message, { missingCapabilities: [...missingCapabilities] });
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

const REQUEST_TIMEOUT_MESSAGE = 'The mail provider took too long to respond.';

function safeMessage(error: unknown, code: string): string {
  if (error instanceof ClientInputError || error instanceof MissingCapabilityError) return error.message;
  if (code === 'provider_unavailable' && isEmailError(error) && error.failure?.reason === 'request_timeout') {
    return REQUEST_TIMEOUT_MESSAGE;
  }
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
  const diagnostics = error instanceof ClientInputError ? error.data?.diagnostics : undefined;
  const missingCapabilities = error instanceof MissingCapabilityError ? error.data?.missingCapabilities : undefined;
  return {
    code,
    message: safeMessage(error, code),
    requestId,
    ...(missingCapabilities !== undefined ? { data: { missingCapabilities } } : {}),
    ...(diagnostics !== undefined ||
    (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0)
      ? {
          data: {
            ...(diagnostics !== undefined ? { diagnostics } : {}),
            ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
              ? { retryAfterMs }
              : {}),
          },
        }
      : {}),
  };
}
