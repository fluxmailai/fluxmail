import { describe, expect, it } from 'vitest';
import { SearchCursorCodec, emailQueryHash } from '../src/searchCursor.js';

const binding = {
  accountId: 'acct_1',
  provider: 'gmail' as const,
  query: { folder: 'inbox', read: false, text: 'quarterly report' },
  pageSize: 25,
  includeSnippet: true,
  includeSearchContext: true,
};

describe('SearchCursorCodec', () => {
  it('round trips a provider token and signs the envelope', () => {
    const codec = new SearchCursorCodec(Buffer.alloc(32, 1));
    const token = codec.encode({ ...binding, providerToken: 'provider-secret-token' }, 1_000);
    expect(token.split('.')).toHaveLength(2);
    expect(codec.decode(token, binding, 2_000)).toBe('provider-secret-token');
  });

  it('binds cursors to canonical query, account, provider, and page size', () => {
    const codec = new SearchCursorCodec(Buffer.alloc(32, 1));
    const token = codec.encode({ ...binding, providerToken: 'next' }, 1_000);
    expect(emailQueryHash({ text: 'quarterly report', read: false, folder: 'inbox' })).toBe(
      emailQueryHash(binding.query),
    );
    for (const changed of [
      { ...binding, accountId: 'acct_2' },
      { ...binding, provider: 'outlook' as const },
      { ...binding, query: { ...binding.query, read: true } },
      { ...binding, pageSize: 50 },
      { ...binding, includeSnippet: false },
      { ...binding, includeSearchContext: false },
    ]) {
      expect(() => codec.decode(token, changed, 2_000)).toThrow(/Invalid or expired/);
    }
  });

  it('accepts tokens without a search-context binding when the option stays omitted', () => {
    const codec = new SearchCursorCodec(Buffer.alloc(32, 1));
    const { includeSearchContext: _includeSearchContext, ...legacyBinding } = binding;
    const token = codec.encode({ ...legacyBinding, providerToken: 'next' }, 1_000);

    expect(codec.decode(token, legacyBinding, 2_000)).toBe('next');
    expect(codec.decode(token, { ...legacyBinding, includeSearchContext: false }, 2_000)).toBe('next');
  });

  it('rejects tampering, legacy tokens, malformed payloads, and rotated keys', () => {
    const codec = new SearchCursorCodec(Buffer.alloc(32, 1));
    const token = codec.encode({ ...binding, providerToken: 'next' }, 1_000);
    const [payload, signature] = token.split('.') as [string, string];
    expect(() => codec.decode(`${payload.slice(0, -1)}A.${signature}`, binding, 2_000)).toThrow(/Invalid or expired/);
    expect(() => codec.decode(Buffer.from('legacy-provider-token').toString('base64url'), binding, 2_000)).toThrow(
      /Invalid or expired/,
    );
    expect(() => codec.decode(`e30.${signature}`, binding, 2_000)).toThrow(/Invalid or expired/);
    expect(() => new SearchCursorCodec(Buffer.alloc(32, 2)).decode(token, binding, 2_000)).toThrow(
      /Invalid or expired/,
    );
  });

  it('rejects expired and future-issued cursors', () => {
    const codec = new SearchCursorCodec(Buffer.alloc(32, 1));
    const token = codec.encode({ ...binding, providerToken: 'next' }, 1_000);
    expect(() => codec.decode(token, binding, 1_000 + 60 * 60 * 1_000)).toThrow(/Invalid or expired/);
    expect(() => codec.decode(token, binding, 999)).toThrow(/Invalid or expired/);
  });

  it('throws the configured error for an invalid token', () => {
    class InvalidCursor extends Error {}
    const codec = new SearchCursorCodec(Buffer.alloc(32, 1), { invalidCursor: () => new InvalidCursor('bad') });
    expect(() => codec.decode('not-a-token', binding, 2_000)).toThrow(InvalidCursor);
    expect(() => new SearchCursorCodec(Buffer.alloc(32, 1)).decode('not-a-token', binding, 2_000)).toThrow(
      expect.objectContaining({ code: 'invalid_request', message: 'Invalid or expired search page token.' }),
    );
  });

  it('enforces the 16 KiB encoded limit', () => {
    const codec = new SearchCursorCodec(Buffer.alloc(32, 1));
    expect(() => codec.encode({ ...binding, providerToken: 'x'.repeat(16 * 1_024) }, 1_000)).toThrow(/too large/);
    expect(() => codec.decode('x'.repeat(16 * 1_024 + 1), binding, 2_000)).toThrow(/Invalid or expired/);
  });
});
