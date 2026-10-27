import { describe, expect, it } from 'vitest';
import { GraphHttpError, isRetryableGraphError, toEmailError } from '../src/errors.js';

describe('Microsoft Graph errors', () => {
  it.each([
    [401, 'InvalidAuthenticationToken', 'auth_expired'],
    [429, 'TooManyRequests', 'rate_limited'],
    [403, 'ErrorAccessDenied', 'permission_denied'],
    [404, 'ErrorItemNotFound', 'not_found'],
    [400, 'ErrorInvalidRequest', 'invalid_request'],
    [503, 'ServiceUnavailable', 'provider_unavailable'],
  ] as const)('maps HTTP %s to %s', (status, code, expected) => {
    expect(toEmailError(new GraphHttpError(status, code, 'details')).code).toBe(expected);
  });

  it('retries throttling and temporary service errors', () => {
    expect(isRetryableGraphError(new GraphHttpError(429, undefined, 'slow down'))).toBe(true);
    expect(isRetryableGraphError(new GraphHttpError(503, undefined, 'offline'))).toBe(true);
    expect(isRetryableGraphError(new GraphHttpError(400, undefined, 'bad request'))).toBe(false);
  });

  it('preserves a retry delay without exposing Graph error text', () => {
    const error = toEmailError(new GraphHttpError(429, 'TooManyRequests', 'private provider response', 12_000));
    expect(error).toMatchObject({ code: 'rate_limited', data: { retryAfterMs: 12_000 } });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('drops invalid retry delays (%s)', (retryAfterMs) => {
    const error = toEmailError(new GraphHttpError(429, 'TooManyRequests', 'private provider response', retryAfterMs));
    expect(error).toMatchObject({ code: 'rate_limited' });
    expect(error.data).toBeUndefined();
  });

  it('records a fetch timeout as a request timeout', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(isRetryableGraphError(timeout)).toBe(false);
    expect(toEmailError(timeout)).toMatchObject({
      code: 'provider_unavailable',
      failure: { provider: 'outlook', phase: 'request', reason: 'request_timeout' },
    });
  });
});
