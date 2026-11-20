import { readAttachmentStream } from '@fluxmail/core';
import { describe, expect, it, vi } from 'vitest';
import { OutlookProvider } from '../src/outlookProvider.js';

const json = (value: unknown, status = 200) => Response.json(value, { status });

function provider(fetchImpl: typeof fetch) {
  return new OutlookProvider({
    accountId: 'acct-1',
    tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('access-token') },
    fetch: fetchImpl,
  });
}

const metadata = {
  '@odata.type': '#microsoft.graph.fileAttachment',
  id: 'attachment-1',
  name: 'contract.pdf',
  contentType: 'application/pdf',
  size: 1_000_250,
};

function stream(content: Buffer, pieces = 4): ReadableStream<Uint8Array> {
  const size = Math.ceil(content.length / pieces);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= content.length) return controller.close();
      controller.enqueue(content.subarray(offset, offset + size));
      offset += size;
    },
  });
}

describe('OutlookProvider.getAttachmentStream', () => {
  const content = Buffer.alloc(1_000_000, 0x5a);

  it('streams the raw content with the length Graph declares', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/$value')) {
        expect(new Headers(init?.headers).get('accept')).toBe('*/*');
        return new Response(stream(content), { headers: { 'content-length': String(content.length) } });
      }
      expect(url.searchParams.get('$select')).toBe('id,name,contentType,size,isInline');
      return json(metadata);
    }) as unknown as typeof fetch;
    const opened = await provider(fetchMock).getAttachmentStream('message-1', 'attachment-1', { maxBytes: 2_000_000 });
    expect(opened).toMatchObject({
      byteLength: content.length,
      meta: { filename: 'contract.pdf', mimeType: 'application/pdf', sizeBytes: content.length },
    });
    expect((await readAttachmentStream(opened.content)).equals(content)).toBe(true);
  });

  it('streams content of unknown length and stops it at maxBytes', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).pathname.endsWith('/$value') ? new Response(stream(content)) : json(metadata),
    ) as unknown as typeof fetch;
    const unlimited = await provider(fetchMock).getAttachmentStream('message-1', 'attachment-1');
    expect(unlimited.byteLength).toBeUndefined();
    expect((await readAttachmentStream(unlimited.content)).length).toBe(content.length);
    const limited = await provider(fetchMock).getAttachmentStream('message-1', 'attachment-1', { maxBytes: 300_000 });
    await expect(readAttachmentStream(limited.content)).rejects.toMatchObject({
      code: 'invalid_request',
      data: { maxBytes: 300_000 },
    });
  });

  it('rejects a declared length over maxBytes before reading the content', async () => {
    const body = stream(content);
    const cancel = vi.spyOn(body, 'cancel');
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).pathname.endsWith('/$value')
        ? new Response(body, { headers: { 'content-length': String(content.length) } })
        : json(metadata),
    ) as unknown as typeof fetch;
    await expect(
      provider(fetchMock).getAttachmentStream('message-1', 'attachment-1', { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'invalid_request', data: { sizeBytes: content.length, maxBytes: 10 } });
    expect(cancel).toHaveBeenCalled();
  });

  it('refuses item attachments and missing attachments', async () => {
    const item = vi.fn(async () => json({ ...metadata, '@odata.type': '#microsoft.graph.itemAttachment' }));
    await expect(
      provider(item as unknown as typeof fetch).getAttachmentStream('message-1', 'attachment-1'),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    const missing = vi.fn(async () => json({ error: { code: 'ErrorItemNotFound', message: 'Not found' } }, 404));
    await expect(
      provider(missing as unknown as typeof fetch).getAttachmentStream('message-1', 'attachment-1'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('OutlookProvider.addDraftAttachment', () => {
  const draft = { id: 'draft-1', isDraft: true, subject: 'Contract', toRecipients: [], hasAttachments: false };

  it('posts a small file in one request', async () => {
    const posted: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname.endsWith('/attachments')) {
        posted.push(JSON.parse(String(init.body)));
        return json({}, 201);
      }
      return json(url.pathname.includes('/attachments') ? { value: [] } : draft);
    }) as unknown as typeof fetch;
    const result = await provider(fetchMock).addDraftAttachment('draft-1', {
      filename: 'note.txt',
      mimeType: 'text/plain',
      byteLength: 5,
      content: stream(Buffer.from('hello'), 2),
    });
    expect(result.draftId).toBe('draft-1');
    expect(posted).toEqual([
      expect.objectContaining({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'note.txt',
        contentType: 'text/plain',
        contentBytes: Buffer.from('hello').toString('base64'),
      }),
    ]);
  });

  it('uploads a large file through an upload session in 320 KiB-aligned chunks', async () => {
    const content = Buffer.from(Array.from({ length: 9_000_000 }, (_, index) => index % 251));
    const ranges: string[] = [];
    const received: Buffer[] = [];
    let session: unknown;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'upload.example.com') {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBeNull();
        ranges.push(headers.get('content-range')!);
        received.push(Buffer.from(init!.body as Uint8Array));
        return new Response(null, { status: ranges.length === 3 ? 201 : 200 });
      }
      if (url.pathname.endsWith('/createUploadSession')) {
        session = JSON.parse(String(init!.body));
        return json({ uploadUrl: 'https://upload.example.com/session' });
      }
      return json(url.pathname.includes('/attachments') ? { value: [] } : draft);
    }) as unknown as typeof fetch;
    await provider(fetchMock).addDraftAttachment('draft-1', {
      filename: 'contract.pdf',
      mimeType: 'application/pdf',
      byteLength: content.length,
      content: stream(content, 37),
    });
    expect(session).toEqual({
      AttachmentItem: {
        attachmentType: 'file',
        name: 'contract.pdf',
        size: content.length,
        contentType: 'application/pdf',
        isInline: false,
      },
    });
    expect(ranges).toEqual([
      'bytes 0-3932159/9000000',
      'bytes 3932160-7864319/9000000',
      'bytes 7864320-8999999/9000000',
    ]);
    expect(Buffer.concat(received).equals(content)).toBe(true);
  });

  it('fails when the file is not the size it was said to be', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'upload.example.com') return new Response(null, { status: 200 });
      if (url.pathname.endsWith('/createUploadSession')) return json({ uploadUrl: 'https://upload.example.com/s' });
      if (init?.method === 'POST') return json({}, 201);
      return json(draft);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);
    await expect(
      outlook.addDraftAttachment('draft-1', {
        filename: 'a.bin',
        mimeType: 'application/octet-stream',
        byteLength: 4_000_000,
        content: stream(Buffer.alloc(3_500_000)),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', message: 'The attachment is smaller than its stated size.' });
    await expect(
      outlook.addDraftAttachment('draft-1', {
        filename: 'a.bin',
        mimeType: 'application/octet-stream',
        byteLength: 4,
        content: stream(Buffer.from('hello')),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('refuses a message that is not a draft', async () => {
    const fetchMock = vi.fn(async () => json({ ...draft, isDraft: false })) as unknown as typeof fetch;
    await expect(
      provider(fetchMock).addDraftAttachment('draft-1', {
        filename: 'a.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        content: stream(Buffer.from('a')),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
