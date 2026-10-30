import { describe, expect, it } from 'vitest';
import {
  assertSearchCapabilities,
  formatEmailSearch,
  intersectSearchCapabilities,
  isPortableFolderRole,
  mergeEmailQueries,
  normalizeEmailQuery,
  normalizePortableEmailQuery,
  parseEmailSearch,
  requiredSearchFilters,
  supportsPortableEmailQuery,
  type Capabilities,
  type NormalizedPortableEmailQuery,
  type SearchCapabilities,
} from '../src/index.js';

describe('email search normalization', () => {
  it('normalizes strings and validates UTC date ranges', () => {
    expect(
      normalizeEmailQuery({
        folder: ' Projects ',
        text: '  quarterly   report ',
        read: false,
        hasAttachment: false,
        after: '2026-01-01',
        before: '2026-02-01',
      }),
    ).toEqual({
      success: true,
      query: {
        folder: 'Projects',
        text: 'quarterly report',
        read: false,
        hasAttachment: false,
        after: '2026-01-01',
        before: '2026-02-01',
      },
    });
  });

  it('returns diagnostics instead of throwing', () => {
    expect(
      normalizeEmailQuery({
        text: ' ',
        rawProviderQuery: 'in:anywhere',
        after: '2026-02-30',
        before: '2026-01-01',
      }),
    ).toMatchObject({
      success: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'empty_value' }),
        expect.objectContaining({ code: 'invalid_date' }),
      ]),
    });
    expect(normalizePortableEmailQuery({ folder: 'Projects' as 'inbox' })).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'unsupported_folder' })],
    });
    expect(
      normalizePortableEmailQuery({ rawProviderQuery: 'in:anywhere' } as unknown as Parameters<
        typeof normalizePortableEmailQuery
      >[0]),
    ).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'unsupported_native_query' })],
    });
  });

  it('merges typed and structured filters but rejects duplicate assignments', () => {
    expect(mergeEmailQueries({ text: 'quarterly' }, { from: 'ann@example.com', read: false })).toEqual({
      success: true,
      query: { text: 'quarterly', from: 'ann@example.com', read: false },
    });
    expect(mergeEmailQueries({ from: 'ann@example.com' }, { from: 'bob@example.com' })).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: 'duplicate_filter' })],
    });
  });
});

describe('portable email search parser', () => {
  it('parses portable filters, escaped quoted values, and literal text', () => {
    const result = parseEmailSearch(
      String.raw`in:archive from:"Ann \"Q\" <ann@example.com>" is:unread -has:attachment after:2026-01-01 quarterly report`,
    );
    expect(result).toMatchObject({
      valid: true,
      query: {
        folder: 'archive',
        from: 'Ann "Q" <ann@example.com>',
        read: false,
        hasAttachment: false,
        after: '2026-01-01',
        text: 'quarterly report',
      },
    });
  });

  it('keeps invalid tokens out of the safely parsed query', () => {
    const result = parseEmailSearch('from:ann@example.com from:bob@example.com in:starred before:yesterday');
    expect(result.valid).toBe(false);
    expect(result.query).toEqual({ from: 'ann@example.com' });
    expect(result.tokens.filter((token) => token.kind === 'invalid')).toHaveLength(3);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'duplicate_filter',
      'unsupported_folder',
      'invalid_date',
    ]);
  });

  it('parses an empty search and rejects empty quoted text without throwing', () => {
    expect(parseEmailSearch('   ')).toMatchObject({
      valid: true,
      query: {},
      diagnostics: [],
    });
    expect(parseEmailSearch('""')).toMatchObject({
      valid: false,
      query: {},
      tokens: [expect.objectContaining({ kind: 'invalid' })],
    });
  });

  it('reports malformed quotes and contradictory state', () => {
    const result = parseEmailSearch('is:read is:unread subject:"unfinished');
    expect(result.valid).toBe(false);
    expect(result.query).toEqual({ read: true });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_filter', start: 8, end: 17 }),
        expect.objectContaining({ code: 'malformed_quote', start: 18 }),
      ]),
    );
  });

  it('keeps the later side of an invalid date range out of the partial query', () => {
    const result = parseEmailSearch('after:2026-02-01 before:2026-01-01 from:ann@example.com');
    expect(result.valid).toBe(false);
    expect(result.query).toEqual({ after: '2026-02-01', from: 'ann@example.com' });
    expect(result.tokens.find((token) => token.raw.startsWith('before:'))?.kind).toBe('invalid');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid_date_range', start: 17, end: 34 }),
    );
  });

  it('warns about transposed operators without changing the literal query', () => {
    const result = parseEmailSearch(
      'form:ann@example.com is:raed has:attachement afterr:2026-01-01 "form:bob@example.com"',
    );
    expect(result.valid).toBe(true);
    expect(result.query.text).toBe(
      'form:ann@example.com is:raed has:attachement afterr:2026-01-01 form:bob@example.com',
    );
    expect(result.diagnostics).toEqual(
      ['from', 'is:read', 'has:attachment', 'after'].map((suggestion) =>
        expect.objectContaining({
          code: 'possible_operator_typo',
          severity: 'warning',
          suggestion,
        }),
      ),
    );
  });

  it('treats boolean words, parentheses, URLs, times, and unrelated colons as text', () => {
    const result = parseEmailSearch('AND OR (report) https://example.com/a 10:30 tag:value');
    expect(result).toMatchObject({
      valid: true,
      query: { text: 'AND OR (report) https://example.com/a 10:30 tag:value' },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('round trips normalized queries with structural equality', () => {
    const normalized = normalizePortableEmailQuery({
      folder: 'archive',
      text: 'from:literal quarterly "report"',
      from: 'Ann Example <ann@example.com>',
      to: 'me@example.com',
      subject: String.raw`Path \ "status"`,
      read: false,
      starred: true,
      hasAttachment: false,
      after: '2026-01-01',
      before: '2026-02-01',
    });
    expect(normalized.success).toBe(true);
    const query = (normalized as { success: true; query: NormalizedPortableEmailQuery }).query;
    const parsed = parseEmailSearch(formatEmailSearch(query));
    expect(parsed.valid).toBe(true);
    expect(parsed.query).toEqual(query);
  });

  it('round trips an empty normalized query with structural equality', () => {
    const normalized = normalizePortableEmailQuery({});
    expect(normalized.success).toBe(true);
    const query = (normalized as { success: true; query: NormalizedPortableEmailQuery }).query;
    expect(parseEmailSearch(formatEmailSearch(query)).query).toEqual(query);
  });

  it('rejects non-portable values passed around the type system', () => {
    expect(() => formatEmailSearch({ folder: 'Projects' } as unknown as NormalizedPortableEmailQuery)).toThrow(
      /normalized portable/,
    );
    expect(() =>
      formatEmailSearch({ rawProviderQuery: 'in:anywhere' } as unknown as NormalizedPortableEmailQuery),
    ).toThrow(/normalized portable/);
  });
});

describe('portable search capabilities', () => {
  const capabilities: SearchCapabilities = {
    filters: ['folder', 'text', 'read', 'hasAttachment'],
    folderRoles: {
      inbox: 'available',
      sent: 'available',
      drafts: 'available',
      archive: 'unknown',
      spam: 'unavailable',
      trash: 'available',
      all: 'available',
    },
    nativeQuery: null,
  };

  it('distinguishes portable roles from provider-specific folders', () => {
    expect(isPortableFolderRole('archive')).toBe(true);
    expect(isPortableFolderRole('starred')).toBe(false);
    expect(isPortableFolderRole('Projects/2026')).toBe(false);
  });

  it('returns concrete folder requirements', () => {
    expect(requiredSearchFilters({ folder: 'archive', read: false, hasAttachment: false })).toEqual([
      { filter: 'folder', role: 'archive' },
      { filter: 'read' },
      { filter: 'hasAttachment' },
    ]);
    expect(supportsPortableEmailQuery(capabilities, { folder: 'archive', from: 'ann@example.com' })).toEqual({
      supported: false,
      unsupported: [{ filter: 'from' }],
      unknown: [{ filter: 'folder', role: 'archive' }],
    });
  });

  it('intersects account capabilities for Desktop', () => {
    expect(
      intersectSearchCapabilities([
        capabilities,
        {
          ...capabilities,
          filters: ['folder', 'text', 'read'],
          folderRoles: { ...capabilities.folderRoles, archive: 'available', spam: 'available' },
        },
      ]),
    ).toMatchObject({
      filters: ['folder', 'text', 'read'],
      folderRoles: { archive: 'unknown', spam: 'unavailable' },
      nativeQuery: null,
    });
  });
});

describe('assertSearchCapabilities', () => {
  const capabilities: Capabilities = {
    labels: false,
    serverThreads: false,
    serverSearch: 'basic',
    search: {
      filters: ['text', 'read'],
      folderRoles: {
        inbox: 'available',
        sent: 'available',
        drafts: 'available',
        archive: 'available',
        spam: 'unavailable',
        trash: 'available',
        all: 'available',
      },
      nativeQuery: null,
    },
    snippets: false,
  };

  it('accepts a query the provider supports', () => {
    expect(() => assertSearchCapabilities(capabilities, { text: 'report', read: false })).not.toThrow();
  });

  it('names every unsupported option', () => {
    expect(() =>
      assertSearchCapabilities(capabilities, { from: 'ann@example.com', folder: 'Projects', rawProviderQuery: 'x' }),
    ).toThrow(
      expect.objectContaining({
        code: 'unsupported_capability',
        message: 'Unsupported search options for this provider: from, folder, rawProviderQuery.',
        data: { unsupportedSearchOptions: ['from', 'folder', 'rawProviderQuery'] },
      }),
    );
  });

  it('requires search context support when requested', () => {
    expect(() => assertSearchCapabilities(capabilities, { text: 'x' }, { includeSearchContext: true })).toThrow(
      'This provider does not support search context.',
    );
    expect(() =>
      assertSearchCapabilities({ ...capabilities, searchContext: true }, { text: 'x' }, { includeSearchContext: true }),
    ).not.toThrow();
  });
});
