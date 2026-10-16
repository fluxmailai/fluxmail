import { EmailError } from '@fluxmail/core';

interface GoogleApiErrorLike {
  code?: number | string;
  message?: string;
  response?: {
    status?: number;
    data?: {
      error?: {
        errors?: Array<{ reason?: string }>;
        details?: Array<{ reason?: string }>;
        message?: string;
      };
    };
  };
  errors?: Array<{ reason?: string }>;
}

function statusOf(err: GoogleApiErrorLike): number | undefined {
  if (typeof err.code === 'number') return err.code;
  if (typeof err.code === 'string' && /^\d+$/.test(err.code)) return Number(err.code);
  return err.response?.status;
}

function reasonsOf(err: GoogleApiErrorLike): string[] {
  return [
    ...(err.errors ?? []),
    ...(err.response?.data?.error?.errors ?? []),
    ...(err.response?.data?.error?.details ?? []),
  ]
    .map((item) => item.reason)
    .filter((reason): reason is string => !!reason);
}

export function isInsufficientScope(err: unknown): boolean {
  if (err instanceof EmailError) return err.data?.insufficientScope === true;
  const e = err as GoogleApiErrorLike & Error;
  const message = e.message ?? e.response?.data?.error?.message ?? '';
  return (
    reasonsOf(e).some((reason) => /^(?:insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT)$/i.test(reason)) ||
    /insufficient (?:authentication )?scopes?|insufficient permissions?/i.test(message)
  );
}

function isRateLimitReason(reason: string): boolean {
  return /^(?:user)?rateLimitExceeded$/i.test(reason);
}

export function isRetryable(err: unknown): boolean {
  const e = err as GoogleApiErrorLike;
  const status = statusOf(e);
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status === 403 && reasonsOf(e).some(isRateLimitReason))
  );
}

/**
 * A non-idempotent request can be committed before a 5xx reaches the client,
 * so retrying can duplicate its effect. Retry only responses that reject the
 * request before processing it.
 */
export function isRetryableForNonIdempotentRequest(err: unknown): boolean {
  const e = err as GoogleApiErrorLike;
  const status = statusOf(e);
  return status === 429 || (status === 403 && reasonsOf(e).some(isRateLimitReason));
}

/** Map googleapis errors onto the normalized EmailError codes. */
export function toEmailError(err: unknown): EmailError {
  if (err instanceof EmailError) return err;
  const e = err as GoogleApiErrorLike & Error;
  const status = statusOf(e);
  const message = e.message ?? e.response?.data?.error?.message ?? 'Gmail API error';
  const reasons = reasonsOf(e);

  // invalid_grant = revoked/expired refresh token; comes back as a 400.
  if (status === 401 || /invalid_grant/i.test(message)) {
    return new EmailError('auth_expired', `Gmail authorization expired or revoked: ${message}`);
  }
  if (
    status === 429 ||
    reasons.some((reason) => isRateLimitReason(reason) || /^(?:dailyLimit|quota)Exceeded$/i.test(reason))
  ) {
    return new EmailError('rate_limited', `Gmail rate limit hit: ${message}`);
  }
  // The grant lacks the Gmail scope, usually because the consent screen checkbox
  // was cleared. Only reconnecting the account can fix it.
  if (status === 403 && isInsufficientScope(e)) {
    return new EmailError('auth_expired', `Gmail access was not granted for this account: ${message}`, {
      insufficientScope: true,
    });
  }
  if (status === 403) {
    return new EmailError('provider_unavailable', `Gmail permission denied: ${message}`);
  }
  if (status === 404) {
    return new EmailError('not_found', `Not found in Gmail: ${message}`);
  }
  if (status === 400) {
    return new EmailError('invalid_request', message);
  }
  return new EmailError('provider_unavailable', `Gmail API failure: ${message}`);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  retryable: (err: unknown) => boolean = isRetryable,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      signal?.throwIfAborted();
      if (attempt >= maxRetries || !retryable(err)) throw toEmailError(err);
      const delayMs = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      attempt++;
    }
  }
}
