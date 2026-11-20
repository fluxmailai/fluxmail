import { describe, expect, it } from 'vitest';
import {
  attachmentItemError,
  bufferStream,
  exactLengthStream,
  isAttachmentReference,
  limitAttachmentStream,
  messageWithAttachment,
  readAttachmentStream,
  statedLengthStream,
} from '../src/index.js';

function streamOf(...chunks: Array<string | Buffer>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  });
}

async function text(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('latin1');
}

describe('attachment streams', () => {
  it('reads a stream whole and enforces the limit', async () => {
    await expect(readAttachmentStream(streamOf('ab', 'cd'))).resolves.toEqual(Buffer.from('abcd'));
    await expect(readAttachmentStream(streamOf('ab', 'cd'), 3)).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 4, maxBytes: 3 },
    });
    await expect(readAttachmentStream(bufferStream(Buffer.alloc(0)))).resolves.toHaveLength(0);
  });

  it('fails a stream once it passes the limit', async () => {
    await expect(readAttachmentStream(limitAttachmentStream(streamOf('abc', 'def'), 4))).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 6, maxBytes: 4 },
    });
    await expect(readAttachmentStream(limitAttachmentStream(streamOf('abc'), undefined))).resolves.toEqual(
      Buffer.from('abc'),
    );
  });

  it('fails a stream that is longer or shorter than its stated length', async () => {
    await expect(readAttachmentStream(exactLengthStream(streamOf('abc'), 3))).resolves.toEqual(Buffer.from('abc'));
    await expect(readAttachmentStream(exactLengthStream(streamOf('abc'), 2))).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { reason: 'invalid_response' },
    });
    await expect(readAttachmentStream(exactLengthStream(streamOf('abc'), 4))).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });
});

it('fails an upload that is not its stated size', async () => {
  await expect(readAttachmentStream(statedLengthStream(streamOf('abc'), 3))).resolves.toEqual(Buffer.from('abc'));
  for (const stated of [2, 4])
    await expect(readAttachmentStream(statedLengthStream(streamOf('abc'), stated))).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'The attachment is not the size its upload stated.',
    });
});

describe('attachment items', () => {
  it('accepts content or a mailbox reference, not a mix', () => {
    expect(attachmentItemError({ filename: 'a.pdf', mimeType: 'application/pdf', content: 'AA==' })).toBeUndefined();
    expect(attachmentItemError({ messageId: 'm1', attachmentId: 'a1' })).toBeUndefined();
    expect(attachmentItemError({ messageId: 'm1', attachmentId: 'a1', content: 'AA==' })).toBe(
      'Give each attachment either content or messageId and attachmentId, not both.',
    );
    expect(attachmentItemError({ messageId: 'm1' })).toBe(
      'An attachment from the mailbox needs both messageId and attachmentId.',
    );
    expect(attachmentItemError({ attachmentId: 'a1' })).toBe(
      'An attachment from the mailbox needs both messageId and attachmentId.',
    );
    expect(attachmentItemError({ messageId: 'm1', attachmentId: 'a1', filename: 'renamed.pdf' })).toBe(
      'An attachment from the mailbox keeps its own filename and type, so give only messageId and attachmentId.',
    );
    expect(attachmentItemError({ filename: 'a.pdf', mimeType: 'application/pdf' })).toBe(
      'Give each attachment content, or messageId and attachmentId.',
    );
    expect(attachmentItemError({ content: 'AA==' })).toBe('An attachment with content needs a filename and mimeType.');
    expect(isAttachmentReference({ messageId: 'm1', attachmentId: 'a1' })).toBe(true);
    expect(isAttachmentReference({ filename: 'a', mimeType: 'text/plain', content: '' })).toBe(false);
  });
});

describe('messageWithAttachment', () => {
  const file = Buffer.from(Array.from({ length: 200 }, (_, index) => index));

  it('adds a part before the closing boundary of a multipart/mixed message', async () => {
    const raw = Buffer.from(
      [
        'From: Ann <ann@example.com>',
        'Subject: Report',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed;',
        ' boundary="outer"',
        '',
        '--outer',
        'Content-Type: text/plain',
        '',
        'See attached.',
        '--outer--',
        '',
      ].join('\r\n'),
    );
    const out = await text(
      messageWithAttachment(raw, {
        filename: 'report.bin',
        mimeType: 'application/octet-stream',
        content: streamOf(file.subarray(0, 100), file.subarray(100)),
      }),
    );
    const [head, rest] = out.split('--outer--');
    expect(rest).toBe('\r\n');
    expect(head.startsWith(raw.subarray(0, raw.indexOf('--outer--') - 2).toString('latin1'))).toBe(true);
    expect(head).toContain(
      '\r\n--outer\r\nContent-Type: application/octet-stream;\r\n name="report.bin"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment;\r\n filename="report.bin"\r\n\r\n',
    );
    const encoded = head.slice(head.lastIndexOf('\r\n\r\n') + 4, -2);
    expect(encoded.split('\r\n').every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64')).toEqual(file);
  });

  it('wraps a single-part message and keeps its top-level headers', async () => {
    const raw = Buffer.from('From: ann@example.com\nSubject: Hi\nContent-Type: text/plain; charset=utf-8\n\nHello\n');
    const out = await text(
      messageWithAttachment(raw, { filename: 'résumé.pdf', mimeType: 'application/pdf', content: streamOf('PDF') }),
    );
    const boundary = /boundary="([^"]+)"/.exec(out)![1];
    expect(out).toBe(
      [
        'From: ann@example.com',
        'Subject: Hi',
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hello',
        '',
        `--${boundary}`,
        'Content-Type: application/pdf;',
        ' name="=?UTF-8?B?csOpc3Vtw6kucGRm?="',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment;',
        ` filename="r_sum_.pdf";`,
        ` filename*0*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
        '',
        'UERG',
        `--${boundary}--`,
        '',
      ].join('\n'),
    );
  });

  it('splits a long non-ASCII filename so no header line is too long', async () => {
    const filename = `${'契約書'.repeat(80)}.pdf`;
    const out = await text(
      messageWithAttachment(Buffer.from('Subject: Hi\r\n\r\nHello'), {
        filename,
        mimeType: 'application/pdf',
        content: streamOf('PDF'),
      }),
    );
    const lines = out.split('\r\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(998);
    const nameLines = lines.filter((line) => /name|=\?UTF-8\?B\?|filename/.test(line));
    expect(Math.max(...nameLines.map((line) => line.length))).toBeLessThanOrEqual(78);
    const words = [...out.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    expect(words.every((word) => word[0].length <= 75)).toBe(true);
    expect(Buffer.concat(words.map((word) => Buffer.from(word[1], 'base64'))).toString()).toBe(filename);
    const continuations = [...out.matchAll(/filename\*(\d+)\*=([^;\r\n]+)/g)];
    expect(continuations.map((match) => Number(match[1]))).toEqual(continuations.map((_, index) => index));
    expect(
      decodeURIComponent(
        continuations
          .map((match) => match[2])
          .join('')
          .replace("UTF-8''", ''),
      ),
    ).toBe(filename);
  });

  it('wraps a multipart/alternative message, which mail apps show as one body', async () => {
    const raw = Buffer.from(
      'Subject: Hi\r\nContent-Type: multipart/alternative; boundary=alt\r\n\r\n--alt\r\nContent-Type: text/plain\r\n\r\nHi\r\n--alt--\r\n',
    );
    const out = await text(
      messageWithAttachment(raw, { filename: 'a.txt', mimeType: 'text/plain', content: streamOf('a') }),
    );
    expect(out).toMatch(
      /^Subject: Hi\r\nMIME-Version: 1\.0\r\nContent-Type: multipart\/mixed; boundary="[^"]+"\r\n\r\n--/,
    );
    expect(out).toContain('Content-Type: multipart/alternative; boundary=alt\r\n\r\n--alt\r\n');
  });

  it('sends an unknown type as application/octet-stream and an empty file as an empty part', async () => {
    const raw = Buffer.from('Subject: Hi\r\n\r\nHello');
    const out = await text(
      messageWithAttachment(raw, { filename: 'x"y', mimeType: 'not a type', content: streamOf() }),
    );
    expect(out).toContain('Content-Type: application/octet-stream;\r\n name="x_y"');
    expect(out).toMatch(/filename="x_y"\r\n\r\n\r\n--[^\r\n]+--\r\n$/);
  });
});
