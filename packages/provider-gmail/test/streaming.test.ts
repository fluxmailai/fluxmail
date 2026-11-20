import { readAttachmentStream } from '@fluxmail/core';
import { OAuth2Client } from 'googleapis-common';
import PostalMime from 'postal-mime';
import { describe, expect, it, vi } from 'vitest';
import { GmailProvider } from '../src/gmailProvider.js';
import { openStreamedField } from '../src/streamedField.js';

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  });
}

const file = Buffer.from(Array.from({ length: 1000 }, (_, index) => (index * 7) % 256));

describe('openStreamedField', () => {
  it('decodes a field split at any point and reads the metadata before it', async () => {
    const json = `{"size": ${file.length}, "data": "${file.toString('base64url')}"}`;
    for (const at of [1, 9, 20, 21, 22, 23, 500, json.length - 2]) {
      const check = vi.fn();
      const field = await openStreamedField(body(json.slice(0, at), json.slice(at)), 'data', check);
      expect(await readAttachmentStream(field.content)).toEqual(file);
      expect(check).toHaveBeenCalledWith({ size: file.length, data: '' }, file.length);
    }
  });

  it('accepts padded data with the padding in its own chunk', async () => {
    const encoded = Buffer.from('ab').toString('base64');
    const field = await openStreamedField(
      body(`{"raw":"${encoded.slice(0, -1)}`, `${encoded.slice(-1)}","id":"d1"}`),
      'raw',
      () => {},
    );
    expect(await readAttachmentStream(field.content)).toEqual(Buffer.from('ab'));
  });

  it('reads padding a JSON encoder escaped, even when the escape is split', async () => {
    const encoded = Buffer.from('ab').toString('base64url');
    const json = `{"data":"${encoded}\\u003d","size":2}`;
    for (const at of [10, 12, 14, json.length - 10]) {
      const field = await openStreamedField(body(json.slice(0, at), json.slice(at)), 'data', () => {});
      expect(await readAttachmentStream(field.content)).toEqual(Buffer.from('ab'));
    }
    const other = await openStreamedField(body('{"data":"YW\\u0022Jj"}'), 'data', () => {});
    await expect(readAttachmentStream(other.content)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('reports a dropped connection as a Gmail error', async () => {
    let sent = false;
    const dropping = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.error(new TypeError('terminated'));
        sent = true;
        controller.enqueue(Buffer.from('{"data":"YWJj'));
      },
    });
    const field = await openStreamedField(dropping, 'data', () => {});
    await expect(readAttachmentStream(field.content)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('fails on bad encoding, missing data and a rejected envelope', async () => {
    const read = async (json: string, check: () => void = () => {}) =>
      readAttachmentStream((await openStreamedField(body(json), 'data', check)).content);
    await expect(read('{"data":"ab$c"}')).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(read('{"data":"abcd')).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(openStreamedField(body('{"size":1}'), 'data', () => {})).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    await expect(
      read('{"data":"YWJj"}', () => {
        throw new Error('rejected');
      }),
    ).rejects.toThrow('rejected');
  });

  it('stops past maxBytes with the attachment size error', async () => {
    const field = await openStreamedField(body(`{"data":"${file.toString('base64url')}"}`), 'data', () => {}, 100);
    await expect(readAttachmentStream(field.content)).rejects.toMatchObject({
      code: 'invalid_request',
      data: { maxBytes: 100 },
    });
  });
});

function provider(fetchImpl: typeof fetch, payload: object) {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: 'token', expiry_date: Date.now() + 3_600_000 });
  const gmail = new GmailProvider({ accountId: 'acct_1', email: 'me@example.com', auth, fetch: fetchImpl });
  const get = vi.fn().mockResolvedValue({
    data: { id: 'm1', threadId: 't1', internalDate: '1751976000000', labelIds: ['DRAFT'], payload },
  });
  (gmail as unknown as { gmail: unknown }).gmail = {
    users: {
      messages: { get },
      labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
    },
  };
  return gmail;
}

const pdfPart = (size: number) => ({
  mimeType: 'multipart/mixed',
  parts: [
    { partId: '0', mimeType: 'text/plain', body: { size: 2, data: Buffer.from('hi').toString('base64url') } },
    {
      partId: '1',
      mimeType: 'application/pdf',
      filename: 'contract.pdf',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="contract.pdf"' }],
      body: { attachmentId: 'gmail-attachment', size },
    },
  ],
});

describe('GmailProvider.getAttachmentStream', () => {
  it('streams the attachment with the length Gmail lists first', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/gmail-attachment',
      );
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      return new Response(`{"size": ${file.length}, "data": "${file.toString('base64url')}"}`);
    });
    const gmail = provider(fetchImpl as typeof fetch, pdfPart(file.length));
    const stream = await gmail.getAttachmentStream('m1', 'gmail-attachment', { maxBytes: 5000 });
    expect(stream).toMatchObject({
      meta: { filename: 'contract.pdf', mimeType: 'application/pdf', sizeBytes: file.length },
      byteLength: file.length,
    });
    expect(await readAttachmentStream(stream.content)).toEqual(file);
  });

  it('rejects an attachment over the limit before downloading it', async () => {
    const fetchImpl = vi.fn();
    const gmail = provider(fetchImpl as typeof fetch, pdfPart(file.length));
    await expect(gmail.getAttachmentStream('m1', 'gmail-attachment', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: file.length, maxBytes: 10 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails the stream when the data does not match the listed size', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(`{"size": 3, "data": "${Buffer.from('four').toString('base64url')}"}`),
    );
    const gmail = provider(fetchImpl as typeof fetch, pdfPart(3));
    const stream = await gmail.getAttachmentStream('m1', 'gmail-attachment');
    await expect(readAttachmentStream(stream.content)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('uses a host download hook when one is set', async () => {
    const fetchImpl = vi.fn();
    const auth = new OAuth2Client();
    const gmail = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth,
      fetch: fetchImpl as typeof fetch,
      getAttachmentContent: async () => file,
    });
    (gmail as unknown as { gmail: unknown }).gmail = {
      users: { messages: { get: vi.fn().mockResolvedValue({ data: { id: 'm1', payload: pdfPart(file.length) } }) } },
    };
    const stream = await gmail.getAttachmentStream('m1', 'gmail-attachment');
    expect(stream.byteLength).toBe(file.length);
    expect(await readAttachmentStream(stream.content)).toEqual(file);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a missing attachment to not_found', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: 'Not Found' } }, { status: 404 }));
    const gmail = provider(fetchImpl as typeof fetch, pdfPart(3));
    await expect(gmail.getAttachmentStream('m1', 'gmail-attachment')).rejects.toMatchObject({ code: 'not_found' });
    await expect(gmail.getAttachmentStream('m1', 'part:9')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('GmailProvider.addDraftAttachment', () => {
  it('uploads the saved message with one more part and keeps its thread', async () => {
    const raw = Buffer.from(
      'From: me@example.com\r\nTo: ann@example.com\r\nSubject: Re: Contract\r\nIn-Reply-To: <orig@example.com>\r\nContent-Type: text/plain\r\n\r\nSigned copy attached.\r\n',
    );
    let uploaded: { url: string; contentType: string | null; body: Buffer } | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const chunks: Uint8Array[] = [];
        for await (const chunk of init.body as ReadableStream<Uint8Array>) chunks.push(chunk);
        uploaded = {
          url: String(url),
          contentType: new Headers(init.headers).get('content-type'),
          body: Buffer.concat(chunks),
        };
        return Response.json({ id: 'd1', message: { id: 'm1', threadId: 't1' } });
      }
      expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1?format=raw');
      return Response.json({ id: 'd1', message: { id: 'm1', threadId: 't1', raw: raw.toString('base64url') } });
    });
    const gmail = provider(fetchImpl as typeof fetch, { mimeType: 'text/plain', body: { size: 0 } });
    vi.spyOn(gmail, 'getMessage').mockResolvedValue({ id: 'm1' } as never);
    const draft = await gmail.addDraftAttachment('d1', {
      filename: 'contract.pdf',
      mimeType: 'application/pdf',
      byteLength: file.length,
      content: body(file.subarray(0, 500).toString('latin1')).pipeThrough(new TransformStream()),
    });
    expect(draft.draftId).toBe('d1');
    expect(uploaded!.url).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts/d1?uploadType=multipart');
    const boundary = /boundary=(\S+)/.exec(uploaded!.contentType!)![1];
    const parts = uploaded!.body.toString('latin1').split(`--${boundary}`);
    expect(JSON.parse(parts[1].split('\r\n\r\n')[1])).toEqual({ id: 'd1', message: { threadId: 't1' } });
    const message = parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2);
    const parsed = await PostalMime.parse(Buffer.from(message, 'latin1'));
    expect(parsed.inReplyTo).toBe('<orig@example.com>');
    expect(parsed.text?.trim()).toBe('Signed copy attached.');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: 'contract.pdf', mimeType: 'application/pdf' });
  });

  it("keeps the file's own error and releases a file it never read", async () => {
    const raw = Buffer.from('Subject: Hi\r\n\r\nHello');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        for await (const _chunk of init.body as ReadableStream<Uint8Array>) {
          // Read until the file fails.
        }
        return Response.json({});
      }
      return Response.json({ id: 'd1', message: { id: 'm1', threadId: 't1', raw: raw.toString('base64url') } });
    });
    const gmail = provider(fetchImpl as typeof fetch, { mimeType: 'text/plain', body: { size: 0 } });
    const tooLarge = new Error('The file is over the limit.');
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(tooLarge);
      },
    });
    await expect(
      gmail.addDraftAttachment('d1', {
        filename: 'a.bin',
        mimeType: 'application/octet-stream',
        byteLength: 1,
        content: failing,
      }),
    ).rejects.toBe(tooLarge);

    const missing = provider(
      vi.fn(async () => Response.json({ error: { message: 'Not Found' } }, { status: 404 })) as typeof fetch,
      { mimeType: 'text/plain', body: { size: 0 } },
    );
    const unread = body('never read');
    const cancel = vi.spyOn(unread, 'cancel');
    await expect(
      missing.addDraftAttachment('d1', { filename: 'a.txt', mimeType: 'text/plain', byteLength: 10, content: unread }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(cancel).toHaveBeenCalled();
  });
});
