import { describe, expect, it } from 'vitest';
import { toGraphQuery } from '../src/query.js';

describe('Microsoft Graph query translation', () => {
  it('builds KQL search terms and OData flags', () => {
    expect(
      toGraphQuery({
        text: 'quarterly "report"',
        from: 'alex@example.com',
        to: 'me@example.com',
        subject: 'quarterly forecast',
        after: '2026-01-02',
        before: '2026-02-03',
        read: false,
        starred: true,
        hasAttachment: true,
      }),
    ).toEqual({
      search:
        '"\\"quarterly\\" AND \\"\\"\\"report\\"\\"\\" AND from:\\"alex@example.com\\" AND to:\\"me@example.com\\" AND subject:\\"quarterly forecast\\" AND received>=2026-01-02 AND received<2026-02-03"',
      filter: "isRead eq false and flag/flagStatus eq 'flagged' and hasAttachments eq true",
    });
  });

  it('combines literal full-text terms with implicit AND', () => {
    expect(toGraphQuery({ text: 'quarterly report' })).toEqual({
      search: '"\\"quarterly\\" AND \\"report\\""',
    });
  });

  it('keeps KQL operators inside structured field values', () => {
    expect(toGraphQuery({ subject: 'quarterly OR from:other@example.com' })).toEqual({
      search: '"subject:\\"quarterly OR from:other@example.com\\""',
    });
  });

  it('maps both values of tri-state flags without treating omission as false', () => {
    expect(toGraphQuery({ read: true, starred: false, hasAttachment: false })).toEqual({
      filter: "isRead eq true and flag/flagStatus ne 'flagged'",
    });
    expect(toGraphQuery({})).toEqual({});
  });

  it('passes raw Graph KQL through and rejects an ambiguous text query', () => {
    expect(toGraphQuery({ rawProviderQuery: 'from:alex AND subject:status' })).toEqual({
      search: '"from:alex AND subject:status"',
    });
    expect(() => toGraphQuery({ text: 'status', rawProviderQuery: 'from:alex' })).toThrow(
      /can't be combined with rawProviderQuery/,
    );
  });

  it('rejects invalid dates', () => {
    expect(() => toGraphQuery({ after: 'not-a-date' })).toThrow(/after must use YYYY-MM-DD/);
  });
});
