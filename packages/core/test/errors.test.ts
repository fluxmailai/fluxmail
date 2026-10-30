import { describe, expect, it } from 'vitest';
import { EmailError, isDefiniteDeliveryFailure, networkFailure } from '../src/errors.js';

describe('networkFailure', () => {
  it.each([
    ['ECONNREFUSED', 'connection_refused'],
    ['ENOTFOUND', 'host_not_found'],
    ['ETIMEDOUT', 'connection_timeout'],
    ['EPIPE', 'connection_reset'],
    ['ENETUNREACH', 'network_unreachable'],
    ['CERT_HAS_EXPIRED', 'tls_error'],
  ])('classifies %s', (code, reason) => {
    expect(networkFailure(Object.assign(new Error('private host'), { code }))).toEqual({ reason, ioCode: code });
  });

  it('finds a code on a wrapped cause', () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });
    expect(networkFailure(error)).toEqual({ reason: 'connection_reset', ioCode: 'ECONNRESET' });
  });

  it('ignores codes that are not on the allowlist', () => {
    expect(networkFailure(Object.assign(new Error('x'), { code: 'EPRIVATE' }))).toBeUndefined();
    expect(networkFailure('ECONNREFUSED')).toBeUndefined();
  });

  it('classifies a fetch timeout', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(networkFailure(timeout)).toEqual({ reason: 'request_timeout' });
    expect(networkFailure(new Error('request failed', { cause: timeout }))).toEqual({ reason: 'request_timeout' });
  });

  it('prefers a network code over a timeout on the same chain', () => {
    const error = new DOMException('timed out', 'TimeoutError') as DOMException & { cause?: unknown };
    error.cause = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    expect(networkFailure(error)).toEqual({ reason: 'connection_reset', ioCode: 'ECONNRESET' });
  });

  it('does not treat a cancelled request as a timeout', () => {
    expect(networkFailure(new DOMException('This operation was aborted', 'AbortError'))).toBeUndefined();
  });
});

describe('isDefiniteDeliveryFailure', () => {
  it('treats rejected requests as definite and provider failures as uncertain', () => {
    expect(isDefiniteDeliveryFailure(new EmailError('rate_limited', 'x'))).toBe(true);
    expect(isDefiniteDeliveryFailure(new EmailError('provider_unavailable', 'x'))).toBe(false);
    expect(isDefiniteDeliveryFailure(new Error('socket closed'))).toBe(false);
  });
});
