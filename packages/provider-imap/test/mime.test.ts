import { buffer } from 'node:stream/consumers';
import { Encoder } from 'nodemailer/lib/base64';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
import { POSTAL_OPTIONS } from '../src/imapProvider.js';
import { composeMessage, deliveryStream } from '../src/mime.js';

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
    expect((await buffer(deliveryStream(stored))).toString()).not.toMatch(/^Bcc:/im);
  });

  describe('delivery stream', () => {
    async function chunks(raw: Buffer): Promise<Buffer[]> {
      const read: Buffer[] = [];
      for await (const chunk of deliveryStream(raw)) read.push(chunk as Buffer);
      return read;
    }

    it('drops Bcc headers and their folded lines and keeps everything else byte for byte', async () => {
      const body = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 131) % 256));
      const raw = Buffer.concat([
        Buffer.from(
          'From: a@example.com\r\nBcc: one@example.com,\r\n two@example.com\r\nTo: b@example.com\r\n' +
            'BCC: three@example.com\r\nSubject: Bcc: in the subject\r\n\r\n',
        ),
        body,
      ]);
      const read = await chunks(raw);

      expect(Buffer.concat(read)).toEqual(
        Buffer.concat([
          Buffer.from('From: a@example.com\r\nTo: b@example.com\r\nSubject: Bcc: in the subject\r\n\r\n'),
          body,
        ]),
      );
      expect(read.slice(1).map((chunk) => chunk.length)).toEqual([65_536, 65_536, 65_536, 3_392]);
      expect(read.slice(1).every((chunk) => chunk.buffer === raw.buffer)).toBe(true);
    });

    it('leaves a Bcc line in the body alone', async () => {
      const raw = Buffer.from('To: b@example.com\r\n\r\nBcc: not a header\r\n');
      expect(Buffer.concat(await chunks(raw))).toEqual(raw);
    });

    it.each([
      [
        'LF line endings',
        'From: a@example.com\nBcc: hidden@example.com\n two@example.com\nTo: b@example.com\n\nBody\nBcc: kept\n',
        'From: a@example.com\nTo: b@example.com\n\nBody\nBcc: kept\n',
      ],
      [
        'no blank line',
        'From: a@example.com\r\nBcc: hidden@example.com\r\nTo: b@example.com\r\n',
        'From: a@example.com\r\nTo: b@example.com\r\n',
      ],
      ['no blank line and LF line endings', 'Bcc: hidden@example.com\nTo: b@example.com', 'To: b@example.com'],
    ])('drops Bcc headers from a message with %s', async (_case, raw, expected) => {
      expect(Buffer.concat(await chunks(Buffer.from(raw))).toString()).toBe(expected);
    });

    it('sends nothing for an empty message', async () => {
      expect(await chunks(Buffer.alloc(0))).toEqual([]);
    });
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
