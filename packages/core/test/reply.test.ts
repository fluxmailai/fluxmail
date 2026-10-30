import { describe, expect, it } from 'vitest';
import {
  buildForwardBody,
  computeReplyRecipients,
  forwardSubject,
  replySubject,
  selectReplySender,
  type Message,
  type SendAsIdentity,
} from '../src/index.js';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    threadId: 't1',
    accountId: 'acct_1',
    to: [],
    subject: 'Hello',
    date: '2026-07-09T00:00:00.000Z',
    attachments: [],
    flags: { read: true, starred: false, draft: false },
    ...overrides,
  };
}

describe('computeReplyRecipients', () => {
  const original = msg({
    from: { name: 'Ann', email: 'ann@example.com' },
    to: [{ email: 'me@example.com' }, { email: 'bob@example.com' }],
    cc: [{ email: 'carol@example.com' }, { email: 'me@example.com' }],
  });

  it('plain reply targets the sender only', () => {
    const r = computeReplyRecipients(original, 'me@example.com', false);
    expect(r.to).toEqual([{ name: 'Ann', email: 'ann@example.com' }]);
    expect(r.cc).toEqual([]);
  });

  it('reply-all includes original To/Cc minus own address', () => {
    const r = computeReplyRecipients(original, 'me@example.com', true);
    expect(r.to.map((a) => a.email)).toEqual(['ann@example.com', 'bob@example.com']);
    expect(r.cc.map((a) => a.email)).toEqual(['carol@example.com']);
  });

  it('prefers Reply-To over From', () => {
    const withReplyTo = msg({
      ...original,
      replyTo: [{ email: 'list@example.com' }],
    });
    const r = computeReplyRecipients(withReplyTo, 'me@example.com', false);
    expect(r.to).toEqual([{ email: 'list@example.com' }]);
  });

  it('own-address comparison is case-insensitive', () => {
    const r = computeReplyRecipients(original, 'ME@Example.com', true);
    expect(r.to.map((a) => a.email)).not.toContain('me@example.com');
  });

  it('replying to your own sent message falls back to the original To', () => {
    const own = msg({
      from: { email: 'me@example.com' },
      to: [{ email: 'bob@example.com' }],
    });
    const r = computeReplyRecipients(own, 'me@example.com', false);
    expect(r.to.map((a) => a.email)).toEqual(['bob@example.com']);
  });

  it('dedupes addresses across Reply-To and To', () => {
    const dup = msg({
      from: { email: 'ann@example.com' },
      to: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }],
    });
    const r = computeReplyRecipients(dup, 'me@example.com', true);
    expect(r.to.map((a) => a.email)).toEqual(['ann@example.com', 'bob@example.com']);
  });
});

describe('subject prefixes', () => {
  it('adds Re: once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('re: Hello')).toBe('re: Hello');
  });
  it('adds Fwd: once', () => {
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fwd: Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('FW: Hello')).toBe('FW: Hello');
  });
});

const forwarded: Message = {
  id: 'm1',
  threadId: 't1',
  accountId: 'acct_1',
  from: { name: 'Ann', email: 'ann@example.com' },
  to: [{ email: 'me@example.com' }],
  cc: [{ email: 'carol@example.com' }],
  subject: 'Report',
  date: '2026-07-01T12:00:00.000Z',
  body: { text: 'original text', html: '<p>original <b>html</b></p>' },
  attachments: [],
  flags: { read: true, starred: false, draft: false },
};

describe('buildForwardBody', () => {
  it('includes the forwarded-message header block and original text', () => {
    const body = buildForwardBody(forwarded, 'FYI');
    expect(body.text).toContain('FYI');
    expect(body.text).toContain('---------- Forwarded message ----------');
    expect(body.text).toContain('From: Ann <ann@example.com>');
    expect(body.text).toContain('Cc: carol@example.com');
    expect(body.text).toContain('original text');
  });

  it('builds an html version quoting the original html', () => {
    const body = buildForwardBody(forwarded);
    expect(body.html).toContain('<blockquote');
    expect(body.html).toContain('<p>original <b>html</b></p>');
  });

  it('escapes html in the comment', () => {
    const body = buildForwardBody(forwarded, '<script>alert(1)</script>');
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
  });

  it('builds a text body when the original has no body or sender', () => {
    const body = buildForwardBody({ ...forwarded, from: undefined, body: undefined });
    expect(body.html).toBeUndefined();
    expect(body.text).toContain('From: (unknown)');
  });

  it('omits the text part for an HTML-only original', () => {
    expect(buildForwardBody({ ...forwarded, body: { html: '<b>Hi</b>' } }).text).toBeUndefined();
  });

  it('handles text-only originals', () => {
    const body = buildForwardBody({ ...forwarded, body: { text: 'only text' } });
    expect(body.text).toContain('only text');
    expect(body.html).toBeUndefined();
  });
});

describe('selectReplySender', () => {
  const identities: SendAsIdentity[] = [
    { email: 'me@example.com', isPrimary: true, source: 'provider' },
    { email: 'sales@example.com', isPrimary: false, source: 'provider' },
  ];

  it('replies from the alias the original was addressed to', () => {
    const original = msg({ from: { email: 'ann@example.com' }, to: [{ email: 'Sales@example.com' }] });
    expect(selectReplySender(original, identities).email).toBe('sales@example.com');
  });

  it('keeps the sender identity when replying to your own message', () => {
    const original = msg({ from: { email: 'sales@example.com' }, to: [{ email: 'me@example.com' }] });
    expect(selectReplySender(original, identities).email).toBe('sales@example.com');
  });

  it('falls back to the primary identity', () => {
    const original = msg({ from: { email: 'ann@example.com' }, to: [{ email: 'list@example.com' }] });
    expect(selectReplySender(original, identities).email).toBe('me@example.com');
  });
});
