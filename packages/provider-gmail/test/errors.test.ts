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
  });
});
