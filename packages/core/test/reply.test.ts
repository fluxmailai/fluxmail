import { describe, expect, it } from 'vitest';
import {
  buildForwardBody,
  buildReplyBody,
  isValidTimeZone,
  quotedImages,
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
  it('writes the forwarded-message header as Gmail does', () => {
    const body = buildForwardBody(
      msg({
        from: { name: 'Ann', email: 'ann@example.com' },
        to: [{ email: 'me@example.com' }],
        cc: [{ name: 'Carol', email: 'carol@example.com' }],
        subject: 'Report',
        date: '2026-11-04T03:26:31.000Z',
        body: { text: 'original text', html: '<p>original <b>html</b></p><script>x()</script>' },
      }),
      'FYI',
      { timeZone: 'America/New_York' },
    );
    expect(body.text).toBe(
      'FYI\n\n---------- Forwarded message ---------\nFrom: Ann <ann@example.com>\n' +
        'Date: Tue, Nov 3, 2026 at 10:26 PM\nSubject: Report\nTo: <me@example.com>\n' +
        'Cc: Carol <carol@example.com>\n\noriginal text',
    );
    expect(body.html).toBe(
      '<p>FYI</p><div class="fluxmail_forward"><div>---------- Forwarded message ---------<br>' +
        'From: <strong>Ann</strong> &lt;ann@example.com&gt;<br>Date: Tue, Nov 3, 2026 at 10:26 PM<br>' +
        'Subject: Report<br>To: &lt;me@example.com&gt;<br>Cc: Carol &lt;carol@example.com&gt;</div><br>' +
        '<p>original <b>html</b></p></div>',
    );
  });

  it('dates a forward in UTC without a time zone', () => {
    expect(buildForwardBody(forwarded).text).toContain('\nDate: Wed, Jul 1, 2026 at 12:00 PM UTC\n');
  });

  it('escapes html in the comment', () => {
    const body = buildForwardBody(forwarded, '<script>alert(1)</script>');
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
  });

  it('builds a text body when the original has no body or sender', () => {
    const body = buildForwardBody({ ...forwarded, from: undefined, body: undefined });
    expect(body.html).toBeUndefined();
    expect(body.text).toContain('From: (unknown sender)');
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

describe('buildReplyBody', () => {
  const original = msg({
    from: { name: 'Ann', email: 'ann@example.com' },
    date: '2026-07-09T14:05:00.000Z',
    body: {
      text: 'First line\r\n\r\n\r\nSecond <line>',
      html: '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>First <b>html</b></p><script>x()</script></body></html>',
    },
  });
  const header = 'On Thu, Jul 9, 2026 at 2:05 PM UTC Ann <ann@example.com> wrote:';
  const quote = (inner: string) =>
    `<div class="fluxmail_quote"><div>${header.replace('<', '&lt;').replace('>', '&gt;')}</div>` +
    `<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote></div>`;

  it('quotes the original text below the reply', () => {
    expect(buildReplyBody(original, { text: 'Thanks!' })).toEqual({
      text: `Thanks!\n\n${header}\n> First line\n>\n> Second <line>`,
    });
  });

  it('quotes the sanitized original html', () => {
    const body = buildReplyBody(original, { html: '<p>Thanks!</p>' });
    expect(body.text).toBeUndefined();
    expect(body.html).toBe(`<p>Thanks!</p>${quote('<p>First <b>html</b></p>')}`);
  });

  it('keeps hostile markup in the original inside the quote', () => {
    const hostile = msg({
      from: original.from,
      date: original.date,
      body: {
        html:
          '<style>div{display:none}</style><p onclick="x()" style="position:fixed;color:red;margin-top:-90px">Hi</p>' +
          '</blockquote></div><p>Approved, wire the funds</p><iframe src="https://evil.example"></iframe>' +
          '<a href="javascript:alert(1)">x</a><a href="https://example.com">y</a><img src="https://example.com/t.png" onerror="x()"><form><b>z',
      },
    });
    expect(buildReplyBody(hostile, { html: '<p>Thanks!</p>' }).html).toBe(
      '<p>Thanks!</p>' +
        quote(
          '<p style="color:red">Hi</p><p>Approved, wire the funds</p><a>x</a>' +
            '<a href="https://example.com" target="_blank" rel="noopener noreferrer">y</a><img src="https://example.com/t.png"><b>z</b>',
        ),
    );
  });

  it('keeps only formatting styles that are spelled out plainly', () => {
    const styled = msg({
      from: original.from,
      date: original.date,
      body: {
        html:
          '<p style="p\\6fsition:fixed; color:red; margin-top:calc(0px - 1000px); margin-bottom: 4px; ' +
          'font-weight:bold !important; width:var(--x); background-color: rgb(1, 2, 3); top:0; ' +
          'border-left: 1px solid #ccc; font-family: Arial/**/; color: \\72 ed">x</p>',
      },
    });
    expect(buildReplyBody(styled, { html: '<p>Hi</p>' }).html).toContain(
      '<p style="color:red; margin-bottom:4px; font-weight:bold; background-color:rgb(1, 2, 3); border-left:1px solid #ccc">x</p>',
    );
  });

  it('keeps what the user wrote after an earlier quote', () => {
    const first = buildReplyBody(original, { text: 'Thanks!', html: '<p>Thanks!</p>' });
    const withPostscript = {
      text: `${first.text}\n\nPS: ship to my new address`,
      html: `${first.html}<p>PS: ship to my new address</p>`,
    };
    const again = buildReplyBody(original, withPostscript);
    expect(again.text).toBe(`${first.text}\n\nPS: ship to my new address`);
    expect(again.html).toBe(`${first.html}<p>PS: ship to my new address</p>`);
    expect(again.html!.match(/fluxmail_quote/g)).toHaveLength(1);
  });

  it('quotes an image-only original in an html reply', () => {
    const image = msg({
      from: original.from,
      date: original.date,
      body: { html: '<div><img src="https://example.com/receipt.png" alt=""></div>' },
    });
    expect(buildReplyBody(image, { text: 'Got it', html: '<p>Got it</p>' })).toEqual({
      text: 'Got it',
      html: `<p>Got it</p>${quote('<div><img src="https://example.com/receipt.png" alt=""></div>')}`,
    });
    expect(buildReplyBody(image, { text: 'Got it' })).toEqual({ text: 'Got it' });
  });

  it('adds a line break only when the reply does not end with a paragraph', () => {
    expect(buildReplyBody(original, { html: 'Thanks!' }).html).toMatch(/^Thanks!<br><div class="fluxmail_quote">/);
    expect(buildReplyBody(original, { html: '<ul><li>Yes</li></ul>' }).html).toMatch(
      /^<ul><li>Yes<\/li><\/ul><div class="fluxmail_quote">/,
    );
  });

  it('puts the quote inside a complete html document', () => {
    expect(buildReplyBody(original, { html: '<html><body><p>Thanks!</p></body></html>' }).html).toBe(
      `<html><body><p>Thanks!</p>${quote('<p>First <b>html</b></p>')}</body></html>`,
    );
  });

  it('replaces a quote it added earlier instead of adding another', () => {
    const first = buildReplyBody(original, { text: 'Thanks!', html: '<p>Thanks!</p>' });
    const edited = {
      text: first.text!.replace('Thanks!', 'Thanks a lot!'),
      html: first.html!.replace('Thanks!', 'Thanks a lot!'),
    };
    expect(buildReplyBody(original, edited)).toEqual(
      buildReplyBody(original, { text: 'Thanks a lot!', html: '<p>Thanks a lot!</p>' }),
    );
    const crlf = { text: edited.text.replace(/\n/g, '\r\n') };
    expect(buildReplyBody(original, crlf).text).toBe(buildReplyBody(original, { text: 'Thanks a lot!' }).text);
    // The earlier quote is found even after the time zone changes.
    const tokyo = buildReplyBody(original, { text: 'Thanks!', html: '<p>Thanks!</p>' }, { timeZone: 'Asia/Tokyo' });
    expect(buildReplyBody(original, tokyo)).toEqual(
      buildReplyBody(original, { text: 'Thanks!', html: '<p>Thanks!</p>' }),
    );
    // A quote of someone else, or quoted lines the user wrote, stay.
    const other = 'Thanks!\n\nOn Mon, Jul 6, 2026 at 9:00 AM Bob <bob@example.com> wrote:\n> Earlier';
    expect(buildReplyBody(original, { text: other }).text).toBe(
      `${other}\n\n${header}\n> First line\n>\n> Second <line>`,
    );
  });

  it('quotes readable text from an html-only original or an empty text part, and escaped text in html', () => {
    const htmlOnly = msg({ from: original.from, body: { html: '<p>Only <b>html</b></p><p>Next</p>' } });
    expect(buildReplyBody(htmlOnly, { text: 'Hi' }).text).toMatch(/wrote:\n> Only html\n> Next$/);
    const emptyText = msg({ from: original.from, body: { text: ' ', html: '<p>Meeting at 3</p>' } });
    expect(buildReplyBody(emptyText, { text: 'Hi' }).text).toMatch(/wrote:\n> Meeting at 3$/);
    const textOnly = msg({ from: original.from, body: { text: 'a < b\nc' } });
    expect(buildReplyBody(textOnly, { html: '<p>Hi</p>' }).html).toContain('>a &lt; b<br>c</blockquote>');
  });

  it('falls back to a text quote, then a shortened quote, then no quote, when the result is too large', () => {
    const reply = { text: 'Hi', html: '<p>Hi</p>' };
    const textInHtml = buildReplyBody(original, reply, { fits: (body) => !body.html?.includes('<b>') });
    expect(textInHtml.html).toContain('First line<br><br><br>Second &lt;line&gt;</blockquote>');
    expect(textInHtml.text).toContain('> First line');
    const long = msg({ from: original.from, date: original.date, body: { text: 'word '.repeat(2000) } });
    const short = buildReplyBody(long, { text: 'Hi' }, { fits: (body) => (body.text?.length ?? 0) <= 4000 });
    expect(short.text!.length).toBeLessThanOrEqual(4000);
    expect(short.text).toMatch(/^Hi\n\nOn .+ wrote:\n> word word/);
    expect(short.text).toMatch(/\n> …$/);
    expect(buildReplyBody(original, reply, { fits: () => false })).toEqual(reply);
  });

  it('leaves the reply alone when the original has no body', () => {
    expect(buildReplyBody(msg({}), { text: 'Hi' })).toEqual({ text: 'Hi' });
  });

  it('writes the date in the given time zone, or in UTC', () => {
    const at = (date: string, timeZone?: string) =>
      buildReplyBody(msg({ date, body: { text: 'x' } }), {}, { timeZone }).text;
    expect(at('2026-11-04T03:26:31Z', 'America/New_York')).toMatch(
      /^On Tue, Nov 3, 2026 at 10:26 PM \(unknown sender\) wrote:/,
    );
    expect(at('2026-11-04T03:26:31Z', 'Asia/Kolkata')).toMatch(
      /^On Wed, Nov 4, 2026 at 8:56 AM \(unknown sender\) wrote:/,
    );
    for (const zone of [undefined, 'UTC', 'Etc/UTC', 'GMT', 'Not/AZone'])
      expect(at('2026-11-04T00:05:00Z', zone)).toMatch(
        /^On Wed, Nov 4, 2026 at 12:05 AM UTC \(unknown sender\) wrote:/,
      );
    expect(at('2026-11-04T00:05:00Z', 'Europe/London')).toMatch(
      /^On Wed, Nov 4, 2026 at 12:05 AM \(unknown sender\) wrote:/,
    );
    expect(at('not a date')).toMatch(/^On not a date \(unknown sender\) wrote:/);
  });

  it('recognizes IANA time zones', () => {
    expect(isValidTimeZone('Europe/Tallinn')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});

describe('quotedImages', () => {
  const image = (id: string, contentId: string | undefined, sizeBytes = 3) => ({
    id,
    filename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes,
    ...(contentId ? { contentId } : {}),
  });
  const original = msg({
    attachments: [image('a', 'logo@x'), image('b', 'chart@x'), image('c', 'unused@x'), image('d', undefined)],
  });
  const html = '<img src="cid:logo@x"><img src=cid:chart@x>';
  const download = async () => new Uint8Array([1, 2, 3]);

  it('returns the attachments the html shows, marked inline', async () => {
    expect(await quotedImages(original, html, { maxCount: 20, maxBytes: 100, download })).toEqual([
      { filename: 'a.png', mimeType: 'image/png', content: 'AQID', contentId: 'logo@x', disposition: 'inline' },
      { filename: 'b.png', mimeType: 'image/png', content: 'AQID', contentId: 'chart@x', disposition: 'inline' },
    ]);
    expect(await quotedImages(original, undefined, { maxCount: 20, maxBytes: 100, download })).toEqual([]);
  });

  it('skips images the message has and keeps within the limits', async () => {
    const existing = [{ filename: 'logo.png', mimeType: 'image/png', content: 'AQID', contentId: 'logo@x' }];
    const ids = async (options: Partial<Parameters<typeof quotedImages>[2]>) =>
      (await quotedImages(original, html, { maxCount: 20, maxBytes: 100, download, ...options })).map(
        (attachment) => attachment.contentId,
      );
    expect(await ids({ attachments: existing })).toEqual(['chart@x']);
    expect(await ids({ attachments: existing, maxCount: 1 })).toEqual([]);
    expect(await ids({ maxBytes: 5 })).toEqual(['logo@x']);
    expect(
      await ids({ download: async (attachment) => (attachment.id === 'a' ? undefined : new Uint8Array([1])) }),
    ).toEqual(['chart@x']);
  });
});
