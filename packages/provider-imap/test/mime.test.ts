import { Encoder } from 'nodemailer/lib/base64';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
import { POSTAL_OPTIONS } from '../src/imapProvider.js';
import { composeMessage, stripBccHeader } from '../src/mime.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IMAP MIME composition', () => {
  it('keeps Bcc in the stored copy and strips it from delivery', async () => {
    const stored = await composeMessage(
      {
        to: [{ email: 'visible@example.com' }],
        bcc: [{ email: 'hidden@example.com' }],
        subject: 'Test',
        body: { text: 'hello' },
      },
      { email: 'sender@example.com' },
    );
    expect(stored.toString()).toMatch(/^Bcc: hidden@example\.com$/m);
    expect(stripBccHeader(stored).toString()).not.toMatch(/^Bcc:/im);
  });

  it('uses CRLF line endings when bodies contain bare LF', async () => {
    const raw = await composeMessage(
      {
        to: [{ email: 'visible@example.com' }],
        subject: 'x',
        body: { text: 'line one\nline two', html: '<p>one</p>\n<p>two</p>' },
      },
      { email: 'sender@example.com' },
    );
    const source = raw.toString('binary');
    expect(source).not.toMatch(/(?<!\r)\n/);
    expect(source).toContain('line one\r\nline two');
    expect(source).toContain('<p>one</p>\r\n<p>two</p>');
  });

  it('preserves inline attachment content ids', async () => {
    const raw = await composeMessage(
      {
        to: [{ email: 'visible@example.com' }],
        subject: 'Inline image',
        body: { html: '<img src="cid:chart@example.com">' },
        attachments: [
          {
            filename: 'chart.png',
            mimeType: 'image/png',
            content: Buffer.from('image data').toString('base64'),
            contentId: 'chart@example.com',
            disposition: 'inline',
          },
        ],
      },
      { email: 'sender@example.com' },
    );
    const text = raw.toString();
    expect(text).toContain('Content-ID: <chart@example.com>');
    expect(text).toContain('Content-Disposition: inline; filename=chart.png');
  });

  it('rejects invalid attachment base64', async () => {
    await expect(
      composeMessage(
        {
          to: [{ email: 'visible@example.com' }],
          body: { text: 'hello' },
          attachments: [{ filename: 'x', mimeType: 'text/plain', content: '$not-base64' }],
        },
        { email: 'sender@example.com' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('enforces the PostalMime header-size limit', async () => {
    const raw = Buffer.from(`X-Large: ${'a'.repeat(POSTAL_OPTIONS.maxHeadersSize + 1)}\r\n\r\nbody`);
    await expect(PostalMime.parse(raw, POSTAL_OPTIONS)).rejects.toThrow(/Maximum header size/);
  });

  it('enforces the PostalMime nesting-depth limit', async () => {
    const nested = (depth: number): string => {
      if (depth === 0) return 'Content-Type: text/plain\r\n\r\nbody';
      const boundary = `boundary-${depth}`;
      return (
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\n${nested(depth - 1)}\r\n--${boundary}--\r\n`
      );
    };
    await expect(PostalMime.parse(Buffer.from(nested(4)), { ...POSTAL_OPTIONS, maxNestingDepth: 3 })).rejects.toThrow(
      /nesting/i,
    );
  });

  describe('attachment input', () => {
    const compose = (mimeType: string, bytes: Buffer, filename = 'a.bin') =>
      composeMessage(
        {
          to: [{ email: 'visible@example.com' }],
          body: { text: 'hello' },
          attachments: [{ filename, mimeType, content: bytes.toString('base64') }],
        },
        { email: 'sender@example.com' },
      );

    it.each([0, 1, 64 * 1024, 64 * 1024 + 1, 200_000])(
      'base64-encodes a %i-byte attachment in 48 KiB slices',
      async (size) => {
        const encode = vi.spyOn(Encoder.prototype as unknown as { _transform: () => void }, '_transform');
        const bytes = Buffer.from(Array.from({ length: size }, (_, i) => (i * 131) % 256));
        const parsed = await PostalMime.parse(await compose('application/octet-stream', bytes));

        expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer).equals(bytes)).toBe(true);
        // 64 KiB of base64 decodes to 48 KiB.
        const slices = Array.from({ length: Math.ceil(size / 49_152) }, (_, i) => Math.min(49_152, size - i * 49_152));
        expect(encode.mock.calls.map(([chunk]) => (chunk as unknown as Buffer).length)).toEqual(slices);
      },
    );

    it('keeps text attachments base64-encoded and byte for byte', async () => {
      const bytes = Buffer.from('a,b\nc,d\n'.repeat(20_000));
      const raw = await compose('text/csv', bytes);

      expect(raw.toString()).toMatch(/Content-Type: text\/csv[^]*?Content-Transfer-Encoding: base64/);
      const parsed = await PostalMime.parse(raw);
      expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer).equals(bytes)).toBe(true);
    });

    it.each(['message/rfc822', ''])('labels a large ASCII message attachment of type %j 7bit', async (mimeType) => {
      const bytes = Buffer.from('Subject: inner\r\n\r\n' + 'line of text\r\n'.repeat(10_000));
      const raw = (await compose(mimeType, bytes, 'forwarded.eml')).toString();

      expect(raw).toMatch(/Content-Type: message\/rfc822[^]*?Content-Transfer-Encoding: 7bit/);
      expect(raw).toContain('line of text\r\n'.repeat(10_000));
    });
  });
});
