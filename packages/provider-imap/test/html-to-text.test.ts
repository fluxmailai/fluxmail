import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { POSTAL_OPTIONS } from '../src/imapProvider.js';

// postal-mime derives a message's plain text from a separate text/html part when another part is
// text/plain. Hostile HTML must not make that conversion block the event loop.
function mixed(html: string) {
  return new TextEncoder().encode(
    [
      'From: a@example.test',
      'To: b@example.test',
      'Subject: t',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="BB"',
      '',
      '--BB',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'x',
      '--BB',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
      '--BB--',
      '',
    ].join('\r\n'),
  );
}

describe('HTML to text conversion', () => {
  it.each([
    '<body',
    '<head',
    '</head',
    '<!doctype',
    '</body',
    '<!--',
    '<script>',
    '<script',
    '<a href=x',
    '<a\thref=x',
    '<span',
    '<li',
    '<br',
    '<p',
    '<hr',
    '<',
  ])('converts 200 KB of unterminated %j openers quickly', async (opener) => {
    const html = opener.repeat(Math.ceil(200_000 / opener.length));
    const started = performance.now();
    await PostalMime.parse(mixed(html), POSTAL_OPTIONS);
    // postal-mime 2.7 took over five seconds on most of these.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('keeps the text of ordinary HTML', async () => {
    const html = [
      '<!DOCTYPE html><html><head><title>T</title>',
      '<style>p { color: red }</style></head>',
      '<body class="main">',
      '<!-- tracking -->',
      '<script type="text/javascript">alert(1)</script>',
      '<div>Hello <b>Bob</b>,<br/>see <a href="https://example.test/x">this</a>.</div>',
      '<p>Line one</p><ul><li>First</li>',
      '<li>Second</li></ul><hr>',
      '<table><tr><td>Cell</td></tr></table>',
      '<span>Fish &amp; chips &#x263A;</span>',
      '</body></html>',
    ].join('\n');
    const email = await PostalMime.parse(mixed(html), POSTAL_OPTIONS);
    // Only the content matters here; postal-mime owns the exact spacing.
    for (const line of [
      'Hello Bob,',
      'see (https://example.test/x) this.',
      'Line one',
      '* Second',
      'Cell',
      'Fish & chips ☺',
    ])
      expect(email.text).toContain(line);
    expect(email.text).not.toMatch(/alert|tracking|color: red/);
  });
});
