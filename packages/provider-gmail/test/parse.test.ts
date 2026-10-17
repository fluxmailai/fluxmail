import { describe, expect, it } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { decodeBase64Url, encodeBase64Url, findAttachment, parseGmailMessage, walkParts } from '../src/parse.js';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function bufferB64url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

const multipartMessage: gmail_v1.Schema$Message = {
  id: 'msg1',
  threadId: 'thread1',
  internalDate: '1751976000000',
  snippet: 'Hi there',
  labelIds: ['INBOX', 'UNREAD', 'STARRED', 'Label_7'],
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Ann <ann@example.com>' },
      { name: 'To', value: 'me@example.com' },
      { name: 'Subject', value: 'Report' },
      { name: 'Message-ID', value: '<abc@mail.example.com>' },
    ],
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('plain body') } },
          { mimeType: 'text/html', body: { data: b64url('<p>html body</p>') } },
        ],
      },
      {
        mimeType: 'application/pdf',
        filename: 'report.pdf',
        headers: [
          { name: 'Content-ID', value: '<report-image@example.com>' },
          { name: 'Content-Disposition', value: 'inline; filename="report.pdf"' },
        ],
        body: { attachmentId: 'att1', size: 12345 },
      },
      {
        partId: '3',
        mimeType: 'text/plain',
        filename: 'notes.txt',
        body: { data: b64url('inline attachment'), size: 17 },
      },
    ],
  },
};

describe('base64url conversion', () => {
  it.each([
    { bytes: [], encoded: '' },
    { bytes: [0xfb], encoded: '-w' },
    { bytes: [0xfb, 0xff], encoded: '-_8' },
    { bytes: [0xfb, 0xff, 0xff], encoded: '-___' },
  ])('encodes and decodes $encoded without padding', ({ bytes, encoded }) => {
    const content = Buffer.from(bytes);
    expect(encodeBase64Url(content)).toBe(encoded);
    expect(decodeBase64Url(encoded).equals(content)).toBe(true);
  });

  it.each(['-w==', '+w==', '-_8=', '+/8=', '-___', '+///'])('accepts padded and standard base64: %s', (encoded) => {
    expect(decodeBase64Url(encoded)).toEqual(Buffer.from(encoded, 'base64'));
  });

  it('round-trips a 10 MB attachment containing URL-unsafe base64 characters', () => {
    const content = Buffer.alloc(10_000_000, 0xff);
    const encoded = encodeBase64Url(content);

    expect(encoded).toBe(`${'_'.repeat(13_333_332)}_w`);
    expect(decodeBase64Url(encoded).equals(content)).toBe(true);
  });
});

describe('walkParts', () => {
  it('collects text, html, and attachments from a nested tree', () => {
    const walked = walkParts(multipartMessage.payload);
    expect(walked.body.text).toBe('plain body');
    expect(walked.body.html).toBe('<p>html body</p>');
    expect(walked.attachments).toEqual([
      {
        id: 'part:0.1',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12345,
        contentId: 'report-image@example.com',
        disposition: 'inline',
      },
      { id: 'inline:3', filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 17 },
    ]);
    expect(findAttachment(multipartMessage.payload, 'part:0.1')?.providerAttachmentId).toBe('att1');
  });

  it('keeps inline attachment data out of the message body and makes it retrievable', () => {
    const walked = walkParts(multipartMessage.payload);
    expect(walked.body.text).toBe('plain body');
    expect(findAttachment(multipartMessage.payload, 'inline:3')).toEqual({
      meta: { id: 'inline:3', filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 17 },
      content: Buffer.from('inline attachment'),
    });
  });

  it('decodes text using the charset declared by the MIME part', () => {
    const walked = walkParts({
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=windows-1252' }],
      body: { data: bufferB64url(Buffer.from([0x63, 0x61, 0x66, 0xe9])) },
    });

    expect(walked.body.text).toBe('café');
  });

  it('decodes UTF-8 bytes that Gmail returns under a legacy charset header', () => {
    const walked = walkParts({
      mimeType: 'text/html',
      headers: [{ name: 'Content-Type', value: 'text/html; charset=iso-8859-1' }],
      body: { data: bufferB64url(Buffer.from('Tote Bag × 1', 'utf8')) },
    });

    expect(walked.body.html).toBe('Tote Bag × 1');
  });

  it('uses the declared charset for 7-bit encodings', () => {
    const walked = walkParts({
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-7' }],
      body: { data: bufferB64url(Buffer.from('caf+AOk-')) },
    });

    expect(walked.body.text).toBe('café');
  });

  it('records text bodies that Gmail stores as external attachment data', () => {
    const part: gmail_v1.Schema$MessagePart = {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      body: { attachmentId: 'body-attachment-1', size: 50_000 },
    };
    const walked = walkParts(part);

    expect(walked.body.text).toBeUndefined();
    expect(walked.externalBodyParts.text).toEqual({
      attachmentId: 'body-attachment-1',
      part,
    });
  });

  it('keeps filename-less inline images as attachments', () => {
    const walked = walkParts({
      mimeType: 'image/png',
      partId: '2',
      headers: [
        { name: 'Content-ID', value: '<chart@example.com>' },
        { name: 'Content-Disposition', value: 'inline' },
      ],
      body: { data: b64url('image data'), size: 10 },
    });

    expect(walked.attachments).toEqual([
      {
        id: 'inline:2',
        filename: 'inline-2',
        mimeType: 'image/png',
        sizeBytes: 10,
        contentId: 'chart@example.com',
        disposition: 'inline',
      },
    ]);
  });

  it('keeps an HTML root with a content id as the message body', () => {
    const walked = walkParts({
      mimeType: 'text/html',
      partId: '1',
      headers: [{ name: 'Content-ID', value: '<root@example.com>' }],
      body: { data: b64url('<p>Hello</p>'), size: 12 },
    });

    expect(walked.body.html).toBe('<p>Hello</p>');
    expect(walked.attachments).toEqual([]);
  });

  it('keeps zero-byte attachments', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'application/octet-stream',
      partId: '4',
      filename: 'empty.bin',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="empty.bin"' }],
      body: { data: '', size: 0 },
    };
    const walked = walkParts(payload);

    expect(walked.attachments).toEqual([
      {
        id: 'inline:4',
        filename: 'empty.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 0,
        disposition: 'attachment',
      },
    ]);
    expect(findAttachment(payload, 'inline:4')?.content).toEqual(Buffer.alloc(0));
  });

  it('keeps filename-less parts with attachment disposition', () => {
    const walked = walkParts({
      mimeType: 'application/octet-stream',
      partId: '3',
      headers: [{ name: 'Content-Disposition', value: 'attachment' }],
      body: { attachmentId: 'att-no-name', size: 42 },
    });

    expect(walked.attachments).toEqual([
      {
        id: 'part:3',
        filename: 'attachment-3',
        mimeType: 'application/octet-stream',
        sizeBytes: 42,
        disposition: 'attachment',
      },
    ]);
  });

  it.each([
    [{ attachmentId: 'unnamed-file', size: 42 }, 'part:5'],
    [{ data: b64url('binary data'), size: 11 }, 'inline:5'],
  ])('keeps filename-less non-text payloads without a disposition', (body, id) => {
    const walked = walkParts({
      mimeType: 'application/octet-stream',
      partId: '5',
      body,
    });

    expect(walked.attachments).toEqual([
      {
        id,
        filename: 'attachment-5',
        mimeType: 'application/octet-stream',
        sizeBytes: body.size,
      },
    ]);
  });

  it('does not treat text inside an attached message as the outer body', () => {
    const walked = walkParts({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'message/rfc822',
          partId: '2',
          parts: [{ mimeType: 'text/plain', body: { data: b64url('private attached message') } }],
        },
      ],
    });

    expect(walked.body).toEqual({});
  });

  it('keeps attachments nested inside an attached message', () => {
    const walked = walkParts({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', partId: '0', body: { data: b64url('outer body') } },
        {
          mimeType: 'message/rfc822',
          partId: '1',
          parts: [
            {
              mimeType: 'multipart/mixed',
              partId: '1.0',
              parts: [
                { mimeType: 'text/plain', partId: '1.0.0', body: { data: b64url('inner body') } },
                {
                  mimeType: 'application/pdf',
                  partId: '1.0.1',
                  filename: 'report.pdf',
                  body: { attachmentId: 'nested-attachment', size: 42 },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(walked.body).toEqual({ text: 'outer body' });
    expect(walked.attachments).toEqual([
      expect.objectContaining({ id: 'part:1.0.1', filename: 'report.pdf', mimeType: 'application/pdf' }),
    ]);
  });
});

describe('parseGmailMessage', () => {
  const ctx = {
    accountId: 'acct_1',
    labelNames: new Map([['Label_7', 'Projects']]),
    includeBody: true,
    includeAttachments: true,
    includeHeaders: true,
  };

  it('maps flags from labelIds', () => {
    const m = parseGmailMessage(multipartMessage, ctx);
    expect(m.flags).toEqual({ read: false, starred: true, draft: false });
  });

  it('translates label ids to names', () => {
    const m = parseGmailMessage(multipartMessage, ctx);
    expect(m.labels).toContain('Projects');
    expect(m.labels).toContain('INBOX');
  });

  it('parses addresses, subject, and date', () => {
    const m = parseGmailMessage(multipartMessage, ctx);
    expect(m.from).toEqual({ name: 'Ann', email: 'ann@example.com' });
    expect(m.to).toEqual([{ email: 'me@example.com' }]);
    expect(m.subject).toBe('Report');
    expect(m.date).toBe(new Date(1751976000000).toISOString());
  });

  it('exposes threading headers when requested', () => {
    const m = parseGmailMessage(multipartMessage, ctx);
    expect(m.headers?.['Message-ID']).toBe('<abc@mail.example.com>');
  });

  it('omits body when includeBody is false', () => {
    const m = parseGmailMessage(multipartMessage, { ...ctx, includeBody: false });
    expect(m.body).toBeUndefined();
    expect(m.attachments).toHaveLength(2);
  });

  it('derives the canonical folder from location labels', () => {
    const m = parseGmailMessage(multipartMessage, ctx);
    expect(m.folder).toEqual({ id: 'INBOX', name: 'INBOX', role: 'inbox' });
  });

  it('prefers trash over other location labels when deriving the folder', () => {
    const trashed = { ...multipartMessage, labelIds: ['TRASH', 'INBOX', 'SENT'] };
    expect(parseGmailMessage(trashed, ctx).folder).toEqual({ id: 'TRASH', name: 'TRASH', role: 'trash' });
  });

  it('treats mail without a location label as archived', () => {
    const archived = { ...multipartMessage, labelIds: ['Label_7'] };
    expect(parseGmailMessage(archived, ctx).folder).toEqual({ id: 'archive', name: 'Archive', role: 'archive' });
  });

  it('omits attachment state when metadata responses have no MIME payload', () => {
    const m = parseGmailMessage(
      { ...multipartMessage, payload: { headers: multipartMessage.payload?.headers } },
      { ...ctx, includeBody: false, includeAttachments: false },
    );
    expect(m.attachments).toBeUndefined();
  });
});
