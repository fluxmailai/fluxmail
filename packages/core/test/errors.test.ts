import { describe, expect, it } from 'vitest';
import { networkFailure } from '../src/errors.js';

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
});
