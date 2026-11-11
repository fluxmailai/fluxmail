import { EmailError, networkFailure, type FailurePhase, type ProviderFailure } from '@fluxmail/core';

interface GoogleApiErrorLike {
  code?: number | string;
  message?: string;
  config?: { url?: unknown };
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

const GOOGLE_TOKEN_URL = /^https:\/\/(?:oauth2\.googleapis\.com\/token|www\.googleapis\.com\/oauth2\/v4\/token)/;

function failureOf(err: GoogleApiErrorLike, status: number | undefined): ProviderFailure {
  const phase: FailurePhase = GOOGLE_TOKEN_URL.test(String(err.config?.url ?? '')) ? 'token_refresh' : 'request';
  const network = networkFailure(err);
  return {
    provider: 'gmail',
    phase,
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(network ?? { reason: status !== undefined ? 'http_error' : 'other' }),
  };
}

/** Map googleapis errors onto the normalized EmailError codes. */
export function toEmailError(err: unknown): EmailError {
  if (err instanceof EmailError) {
    err.failure = { provider: 'gmail', ...err.failure };
    return err;
  }
  const e = err as GoogleApiErrorLike & Error;
  const status = statusOf(e);
  const message = e.message ?? e.response?.data?.error?.message ?? 'Gmail API error';
  const reasons = reasonsOf(e);
  const failure = failureOf(e, status);

  // invalid_grant = revoked/expired refresh token; comes back as a 400.
  if (status === 401 || /invalid_grant/i.test(message)) {
    return new EmailError('auth_expired', `Gmail authorization expired or revoked: ${message}`, undefined, failure);
  }
  if (
    status === 429 ||
    reasons.some((reason) => isRateLimitReason(reason) || /^(?:dailyLimit|quota)Exceeded$/i.test(reason))
  ) {
    return new EmailError('rate_limited', `Gmail rate limit hit: ${message}`, undefined, failure);
  }
  // The grant lacks the Gmail scope, usually because the consent screen checkbox
  // was cleared. Only reconnecting the account can fix it.
  if (status === 403 && isInsufficientScope(e)) {
    return new EmailError(
      'auth_expired',
      `Gmail access was not granted for this account: ${message}`,
      { insufficientScope: true },
      { ...failure, reason: 'insufficient_scope' },
    );
  }
  if (status === 403) {
    return new EmailError('provider_unavailable', `Gmail permission denied: ${message}`, undefined, failure);
  }
  if (status === 404) {
    return new EmailError('not_found', `Not found in Gmail: ${message}`, undefined, failure);
  }
  if (status === 400) {
    return new EmailError('invalid_request', message, undefined, failure);
  }
  return new EmailError('provider_unavailable', `Gmail API failure: ${message}`, undefined, failure);
}

/** How long one attempt of a Gmail read may wait for a response before it is sent again. */
export const READ_ATTEMPT_TIMEOUT_MS = 4_000;

/** Searches run on Gmail's side and full messages can be large, so these reads get longer attempts. */
export const SLOW_READ_ATTEMPT_TIMEOUT_MS = 8_000;

const RETRYABLE_READ_REASONS = new Set(['connection_reset', 'connection_timeout', 'request_timeout']);

/** A read changes nothing, so it can also be sent again after a dropped or stalled connection. */
export function isRetryableRead(err: unknown): boolean {
  if (isRetryable(err)) return true;
  const reason = networkFailure(err)?.reason;
  return reason !== undefined && RETRYABLE_READ_REASONS.has(reason);
}

/** Settles with `promise`, or rejects with the signal's reason when it aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retries an idempotent Gmail read. Each attempt gets a signal that aborts after `attemptTimeoutMs`,
 * so a request stuck on a dead connection is sent again instead of holding the caller until its own
 * deadline. The wait covers the whole attempt, including an access token refresh.
 */
export function withReadRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  attemptTimeoutMs = READ_ATTEMPT_TIMEOUT_MS,
): Promise<T> {
  // With an attempt timeout, withRetry always passes the attempt's signal.
  return withRetry((attemptSignal) => fn(attemptSignal!), 3, isRetryableRead, signal, attemptTimeoutMs);
}

export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  maxRetries = 3,
  retryable: (err: unknown) => boolean = isRetryable,
  signal?: AbortSignal,
  attemptTimeoutMs?: number,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    const attemptController = attemptTimeoutMs === undefined ? undefined : new AbortController();
    const timer = attemptController
      ? setTimeout(
          () => attemptController.abort(new DOMException('Gmail did not respond in time.', 'TimeoutError')),
          attemptTimeoutMs,
        )
      : undefined;
    try {
      if (!attemptController) return await fn(signal);
      const attemptSignal = signal ? AbortSignal.any([signal, attemptController.signal]) : attemptController.signal;
      return await untilAborted(fn(attemptSignal), attemptSignal);
    } catch (caught) {
      clearTimeout(timer);
      signal?.throwIfAborted();
      // The request library may report its own abort error; the timeout is what happened.
      const err: unknown = attemptController?.signal.aborted ? attemptController.signal.reason : caught;
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
    } finally {
      clearTimeout(timer);
    }
  }
}
