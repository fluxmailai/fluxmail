import { Gaxios } from 'googleapis-common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isInsufficientScope,
  isRetryable,
  isRetryableForNonIdempotentRequest,
  READ_ATTEMPT_TIMEOUT_MS,
  toEmailError,
  withDeleteRetry,
  withReadRetry,
} from '../src/errors.js';

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

/** A request that never answers until its signal aborts. */
function hangingRequest(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
  });
}

describe('Gmail read retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves a dropped connection to the request library, which resends it', async () => {
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await expect(withReadRetry(fn)).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { reason: 'connection_reset' },
    });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('sends a read again when an attempt stalls', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockImplementationOnce(hangingRequest)
      .mockResolvedValueOnce('ok');

    const result = withReadRetry(fn);
    await vi.advanceTimersByTimeAsync(READ_ATTEMPT_TIMEOUT_MS + 1_000);

    await expect(result).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0]![0].aborted).toBe(true);
  });

  it('times out an attempt even when the request ignores its signal', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>(() => undefined))
      .mockResolvedValueOnce('ok');

    const result = withReadRetry(fn);
    await vi.advanceTimersByTimeAsync(READ_ATTEMPT_TIMEOUT_MS + 1_000);

    await expect(result).resolves.toBe('ok');
  });

  it('sends a timed-out read only once more, then reports a request timeout', async () => {
    vi.useFakeTimers();
    const fn = vi.fn<(signal: AbortSignal) => Promise<string>>().mockImplementation(hangingRequest);

    const result = withReadRetry(fn).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4 * READ_ATTEMPT_TIMEOUT_MS + 10_000);

    expect(fn).toHaveBeenCalledTimes(2);
    const error = (await result) as { code: string; failure: unknown };
    expect(error.code).toBe('provider_unavailable');
    expect(error.failure).toEqual({ provider: 'gmail', phase: 'request', reason: 'request_timeout' });
  });

  it('still retries a Gmail backend error after a timed-out attempt', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockImplementationOnce(hangingRequest)
      .mockRejectedValueOnce(googleError(503, 'backendError'))
      .mockResolvedValueOnce('ok');

    const result = withReadRetry(fn);
    await vi.advanceTimersByTimeAsync(READ_ATTEMPT_TIMEOUT_MS + 5_000);

    await expect(result).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops at the caller's deadline instead of retrying", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const deadline = new Error('search deadline');
    const fn = vi.fn<(signal: AbortSignal) => Promise<string>>().mockImplementation(hangingRequest);

    const result = withReadRetry(fn, caller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(deadline);

    expect(await result).toBe(deadline);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('Gmail delete retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

  async function settle(fn: () => Promise<unknown>): Promise<unknown> {
    vi.useFakeTimers();
    const result = withDeleteRetry(fn).then(
      () => 'deleted',
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    return result;
  }

  it('counts a 404 on the resend after a server error as deleted, since Gmail may have applied the first', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(googleError(503, 'backendError'))
      .mockRejectedValueOnce(googleError(404, 'notFound'));

    expect(await settle(fn)).toBe('deleted');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('counts a 404 on the resend after a dropped connection as deleted', async () => {
    const fn = vi.fn().mockRejectedValueOnce(reset()).mockRejectedValueOnce(googleError(404, 'notFound'));

    expect(await settle(fn)).toBe('deleted');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('resends after a server error that Gmail did not apply', async () => {
    const fn = vi.fn().mockRejectedValueOnce(googleError(500, 'backendError')).mockResolvedValueOnce({ data: {} });

    expect(await settle(fn)).toBe('deleted');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reports a 404 on the first attempt as not found', async () => {
    const fn = vi.fn().mockRejectedValue(googleError(404, 'notFound'));

    expect(await settle(fn)).toMatchObject({ code: 'not_found' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('reports a 404 after a rate limit as not found, since Gmail turned the first attempt away', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(googleError(429, 'rateLimitExceeded'))
      .mockRejectedValueOnce(googleError(404, 'notFound'));

    expect(await settle(fn)).toMatchObject({ code: 'not_found' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after three resends and reports the server error', async () => {
    const fn = vi.fn().mockRejectedValue(googleError(503, 'backendError', 'private backend detail'));

    expect(await settle(fn)).toMatchObject({ code: 'provider_unavailable', failure: { httpStatus: 503 } });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['a failed DNS lookup', { code: 'ENOTFOUND', config: {} }],
    ['a refused connection', { code: 'ECONNREFUSED', config: {} }],
    ['a connect timeout', { code: 'UND_ERR_CONNECT_TIMEOUT', config: {} }],
    [
      'a token refresh server error',
      { response: { status: 503 }, config: { url: 'https://oauth2.googleapis.com/token' } },
    ],
    ['a token refresh with no answer', { code: 'ECONNRESET', config: { url: 'https://oauth2.googleapis.com/token' } }],
  ])('reports a 404 after %s as not found, since Gmail never saw the first attempt', async (_name, first) => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('private failure detail'), first))
      .mockRejectedValueOnce(googleError(404, 'notFound'));

    expect(await settle(fn)).toMatchObject({ code: 'not_found' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('counts a 404 as deleted after a connection that closed early with a code core does not list', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE', config: {} }),
      )
      .mockRejectedValueOnce(googleError(404, 'notFound'));

    expect(await settle(fn)).toBe('deleted');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('counts a 404 as deleted after a 408 or an unusual server error', async () => {
    for (const status of [408, 507]) {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(googleError(status, 'backendError'))
        .mockRejectedValueOnce(googleError(404, 'notFound'));

      expect(await settle(fn)).toBe('deleted');
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('does not resend after a certificate error core does not list', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('certificate is not yet valid'), { code: 'CERT_NOT_YET_VALID', config: {} }),
      );

    expect(await settle(fn)).toMatchObject({ code: 'provider_unavailable' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not resend after a certificate error, which a resend would only repeat', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }));

    expect(await settle(fn)).toMatchObject({ code: 'provider_unavailable' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not resend a refusal', async () => {
    const fn = vi.fn().mockRejectedValue(googleError(400, 'invalidArgument'));

    expect(await settle(fn)).toMatchObject({ code: 'invalid_request' });
    expect(fn).toHaveBeenCalledOnce();
  });
});
