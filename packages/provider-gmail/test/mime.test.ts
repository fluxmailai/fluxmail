import { describe, expect, it } from 'vitest';
import { buildRawMessage, buildRawMessageStream } from '../src/mime.js';

describe('buildRawMessage', () => {
  it('includes the sender display name in the From header', async () => {
    const raw = await buildRawMessage(
      { to: [{ email: 'bob@example.com' }], subject: 'Hi', body: { text: 'hello' } },
      { name: 'Richard Chu', email: 'me@example.com' },
    );
    expect(raw.toString()).toMatch(/From: "?Richard Chu"? <me@example\.com>/);
  });

  it('falls back to a bare address when no name is available', async () => {
    const raw = await buildRawMessage(
      { to: [{ email: 'bob@example.com' }], subject: 'Hi', body: { text: 'hello' } },
      { email: 'me@example.com' },
    );
    expect(raw.toString()).toMatch(/From: (me@example\.com|<me@example\.com>)/);
  });

  it('keeps the Bcc header, which Gmail needs to deliver to bcc recipients', async () => {
    const raw = await buildRawMessage(
      {
        to: [{ email: 'bob@example.com' }],
        bcc: [{ email: 'hidden@example.com' }],
        subject: 'Hi',
        body: { text: 'hello' },
      },
      { email: 'me@example.com' },
    );
    expect(raw.toString()).toMatch(/^Bcc: hidden@example\.com$/m);
  });

  it('sets reply threading headers', async () => {
    const raw = await buildRawMessage(
      { to: [{ email: 'bob@example.com' }], subject: 'Re: Hi', body: { text: 'hello' } },
      { email: 'me@example.com' },
      { inReplyTo: '<orig@mail.example.com>', references: '<root@mail.example.com> <orig@mail.example.com>' },
    );
    const text = raw.toString();
    expect(text).toContain('In-Reply-To: <orig@mail.example.com>');
    expect(text).toContain('References: <root@mail.example.com> <orig@mail.example.com>');
  });

  it('preserves inline attachment content ids', async () => {
    const raw = await buildRawMessage(
      {
        to: [{ email: 'bob@example.com' }],
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
      { email: 'me@example.com' },
    );
    const text = raw.toString();
    expect(text).toContain('Content-ID: <chart@example.com>');
    expect(text).toContain('Content-Disposition: inline; filename=chart.png');
  });

  it('rejects malformed base64 attachment content', async () => {
    await expect(
      buildRawMessage(
        {
          to: [{ email: 'bob@example.com' }],
          body: { text: 'hello' },
          attachments: [{ filename: 'bad.bin', mimeType: 'application/octet-stream', content: '!!!!' }],
        },
        { email: 'me@example.com' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('accepts base64 attachment content wrapped in whitespace', async () => {
    const wrapped = Buffer.from('image data')
      .toString('base64')
      .replace(/(.{4})/g, '$1\r\n');
    const raw = await buildRawMessage(
      {
        to: [{ email: 'bob@example.com' }],
        body: { text: 'hello' },
        attachments: [{ filename: 'wrapped.bin', mimeType: 'application/octet-stream', content: wrapped }],
      },
      { email: 'me@example.com' },
    );

    expect(raw.toString()).toContain(Buffer.from('image data').toString('base64'));
  });

  it('allows a zero-byte attachment', async () => {
    const raw = await buildRawMessage(
      {
        to: [{ email: 'bob@example.com' }],
        body: { text: 'hello' },
        attachments: [{ filename: 'empty.bin', mimeType: 'application/octet-stream', content: '' }],
      },
      { email: 'me@example.com' },
    );

    expect(raw.toString()).toContain('filename=empty.bin');
  });
});

describe('buildRawMessageStream', () => {
  async function read(stream: import('node:stream').Readable): Promise<string> {
    let raw = '';
    for await (const chunk of stream) raw += Buffer.from(chunk).toString();
    return raw;
  }

  it('streams the same attachment encoding as the buffered builder', async () => {
    const content = Buffer.alloc(200_000, 7).toString('base64');
    const draft = {
      to: [{ email: 'bob@example.com' }],
      subject: 'Hi',
      body: { text: 'hello' },
      attachments: [{ filename: 'a.bin', mimeType: 'application/octet-stream', content }],
    };
    const streamed = await read(buildRawMessageStream(draft, { email: 'me@example.com' }));
    const buffered = (await buildRawMessage(draft, { email: 'me@example.com' })).toString();
    const attachment = (raw: string) => {
      const start = raw.indexOf('\r\n\r\n', raw.indexOf('Content-Disposition: attachment')) + 4;
      return Buffer.from(raw.slice(start, raw.indexOf('\r\n--', start)).replace(/\r\n/g, ''), 'base64');
    };
    expect(attachment(streamed).equals(Buffer.alloc(200_000, 7))).toBe(true);
    expect(attachment(buffered).equals(attachment(streamed))).toBe(true);
  });

  it('rejects non-canonical base64', () => {
    for (const content of ['QQ=x', 'QR==', 'Q']) {
      expect(() =>
        buildRawMessageStream(
          {
            to: [{ email: 'bob@example.com' }],
            body: { text: 'x' },
            attachments: [{ filename: 'a', mimeType: 'text/plain', content }],
          },
          { email: 'me@example.com' },
        ),
      ).toThrow('Attachment content must be valid base64');
    }
  });
});
