import { Gaxios } from 'googleapis-common';
import { describe, expect, it } from 'vitest';
import { isInsufficientScope, isRetryable, isRetryableForNonIdempotentRequest, toEmailError } from '../src/errors.js';

function googleError(status: number, reason: string, message = reason): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: { error: { errors: [{ reason }], message } },
    },
  });
}

describe('Gmail error handling', () => {
  it('retries 504 responses for idempotent operations', () => {
    expect(isRetryable(googleError(504, 'backendError'))).toBe(true);
    expect(isRetryableForNonIdempotentRequest(googleError(504, 'backendError'))).toBe(false);
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])('retries a 403 %s response', (reason) => {
    const error = googleError(403, reason);
    expect(isRetryable(error)).toBe(true);
    expect(isRetryableForNonIdempotentRequest(error)).toBe(true);
    expect(toEmailError(error).code).toBe('rate_limited');
  });

  it('does not classify a domain policy denial as rate limiting', () => {
    const error = googleError(403, 'domainPolicy', 'Gmail apps are disabled');
    expect(isRetryable(error)).toBe(false);
    expect(toEmailError(error)).toMatchObject({
      code: 'provider_unavailable',
      message: 'Gmail permission denied: Gmail apps are disabled',
    });
  });

  it('asks for reconnection when the grant lacks the Gmail scope', () => {
    const error = googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
    expect(isRetryable(error)).toBe(false);
    const mapped = toEmailError(error);
    expect(mapped).toMatchObject({
      code: 'auth_expired',
      message: 'Gmail access was not granted for this account: Request had insufficient authentication scopes.',
    });
    expect(isInsufficientScope(mapped)).toBe(true);
    expect(isInsufficientScope(toEmailError(googleError(403, 'domainPolicy')))).toBe(false);
    expect(mapped.failure).toEqual({
      provider: 'gmail',
      phase: 'request',
      httpStatus: 403,
      reason: 'insufficient_scope',
    });
  });

  it('records the HTTP status of an API failure', () => {
    expect(toEmailError(googleError(503, 'backendError')).failure).toEqual({
      provider: 'gmail',
      phase: 'request',
      httpStatus: 503,
      reason: 'http_error',
    });
  });

  it('records a failed token refresh', () => {
    const error = Object.assign(googleError(400, 'invalid_grant', 'invalid_grant'), {
      config: { url: 'https://oauth2.googleapis.com/token' },
    });
    expect(toEmailError(error)).toMatchObject({
      code: 'auth_expired',
      failure: { provider: 'gmail', phase: 'token_refresh', httpStatus: 400 },
    });
  });

  it('records a network failure without an HTTP status', () => {
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(toEmailError(error).failure).toEqual({
      provider: 'gmail',
      phase: 'request',
      reason: 'connection_reset',
      ioCode: 'ECONNRESET',
    });
  });

  it('records a request timeout that gaxios wraps', async () => {
    const hangingFetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    const error = await new Gaxios({ fetchImplementation: hangingFetch })
      .request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', timeout: 10 })
      .catch((err: unknown) => err);

    expect(isRetryable(error)).toBe(false);
    expect(isRetryableForNonIdempotentRequest(error)).toBe(false);
    expect(toEmailError(error)).toMatchObject({
      code: 'provider_unavailable',
      failure: { provider: 'gmail', phase: 'request', reason: 'request_timeout' },
    });
    expect(toEmailError(error).failure).not.toHaveProperty('ioCode');
  });
});
