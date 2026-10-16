import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getResolvedPDFJS } from 'unpdf';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AttachmentMeta } from '@fluxmail/core';
import type { EmailService } from '../src/service/emailService.js';
import { buildMcpServer, type McpServerOptions } from '../src/mcp/buildServer.js';
import { permissionPolicyForProfile } from '../src/permissions.js';
import type { Logger } from '../src/logging.js';
import { PDF_CMAP_PDFJS_VERSION } from '../src/mcp/attachmentContent.js';

const attachment: AttachmentMeta = {
  id: 'attachment-id',
  filename: 'notes one.txt',
  mimeType: 'text/plain',
  sizeBytes: 2,
};
const attachmentUri = 'fluxmail://attachment/acct_1/message-id/attachment-id/notes%20one.txt';
let downloaded: { meta: AttachmentMeta; content: Buffer };
let getAttachment: ReturnType<typeof vi.fn>;

beforeEach(() => {
  downloaded = { meta: attachment, content: Buffer.from('hi') };
  getAttachment = vi.fn(async (accountId?: string) => ({ ...downloaded, accountId: accountId ?? 'acct_1' }));
});

function buildServer(options: McpServerOptions = {}) {
  return buildMcpServer({ enforceQuota: () => undefined, getAttachment } as Partial<EmailService> as EmailService, {
    permissions: permissionPolicyForProfile('read-only'),
    ...options,
  });
}

async function connect(options: McpServerOptions = {}) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([buildServer(options).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type Content = { type: string; text?: string; [key: string]: unknown };

async function download(args: Record<string, unknown> = {}, options?: McpServerOptions) {
  const client = await connect(options);
  try {
    return (await client.callTool({
      name: 'download_attachment',
      arguments: { messageId: 'message-id', attachmentId: 'attachment-id', ...args },
    })) as { isError?: boolean; structuredContent?: unknown; content: Content[] };
  } finally {
    await client.close();
  }
}

describe('download_attachment', () => {
  it('returns metadata and a resource link, with content only when inline', async () => {
    const linked = await download();
    expect(getAttachment).toHaveBeenCalledWith(undefined, 'message-id', 'attachment-id', expect.any(Number));
    expect(linked.structuredContent).toEqual({ data: attachment });
    expect(linked.content).toEqual([
      { type: 'text', text: JSON.stringify({ data: attachment }, null, 2) },
      { type: 'resource_link', name: attachment.filename, uri: attachmentUri, mimeType: attachment.mimeType },
    ]);
    const inline = await download({ inline: true });
    expect(inline.content[2]).toEqual({
      type: 'resource',
      resource: { uri: attachmentUri, mimeType: 'text/plain', text: 'hi' },
    });
  });

  it('embeds binary and non-UTF-8 attachments as blobs and images as image content', async () => {
    const inline = async () => (await download({ inline: true })).content[2];
    downloaded = { meta: { ...attachment, mimeType: 'application/pdf' }, content: Buffer.from('%PDF') };
    expect(await inline()).toEqual({
      type: 'resource',
      resource: { uri: attachmentUri, mimeType: 'application/pdf', blob: 'JVBERg==' },
    });
    downloaded = { meta: { ...attachment, mimeType: 'text/plain; charset=utf-8' }, content: Buffer.from([0xff]) };
    expect(await inline()).toEqual({
      type: 'resource',
      resource: { uri: attachmentUri, mimeType: 'text/plain; charset=utf-8', blob: '/w==' },
    });
    downloaded = { meta: { ...attachment, mimeType: 'image/png' }, content: Buffer.from('iVBORw==', 'base64') };
    expect(await inline()).toEqual({ type: 'image', data: 'iVBORw==', mimeType: 'image/png' });
  });

  it('adds text extracted from an inline PDF and logs extraction failures', async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() } as unknown as Logger;
    downloaded = {
      meta: { ...attachment, filename: 'invoice.pdf', mimeType: 'application/pdf' },
      content: pdfWithPages(1, () => 'Invoice total: $1,284.50.'),
    };
    expect((await download({ inline: true })).content).toContainEqual({
      type: 'text',
      text: 'Text extracted from invoice.pdf:\n\nInvoice total: $1,284.50.',
    });
    expect((await download()).content).toHaveLength(2);
    downloaded = { ...downloaded, content: Buffer.from('not a pdf') };
    const content = (await download({ inline: true }, { logger })).content;
    expect(content.map((item) => item.type)).toEqual(['text', 'resource_link', 'resource']);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe('mcp.pdf_text_failed');
  });

  it('reads PDF text in page ranges of at most 200 pages', async () => {
    downloaded = {
      meta: { ...attachment, filename: 'long.pdf', mimeType: 'application/pdf' },
      content: pdfWithPages(250),
    };
    const first = (await download({ inline: true })).content;
    expect(first.map((item) => item.type)).toEqual(['text', 'resource_link', 'resource', 'text']);
    expect(first[3]!.text).toMatch(/^Text extracted from long\.pdf \(pages 1-200 of 250\):\n\nPage 1\n\nPage 2\n/);
    expect(first[3]!.text).toMatch(/Page 200$/);
    const rest = (await download({ pages: '201-400' })).content;
    expect(rest.map((item) => item.type)).toEqual(['text', 'resource_link', 'text']);
    expect(rest[2]!.text).toMatch(/^Text extracted from long\.pdf \(pages 201-250 of 250\):\n\nPage 201\n/);
    expect((await download({ pages: '7' })).content[2]!.text).toBe(
      'Text extracted from long.pdf (page 7 of 250):\n\nPage 7',
    );
    expect((await download({ pages: '300' })).content[2]!.text).toBe('long.pdf has 250 pages.');
    expect((await download({ pages: '5-3' })).isError).toBe(true);
  }, 30_000);

  it('stops PDF text at whole pages within the character budget', async () => {
    downloaded = {
      meta: { ...attachment, filename: 'dense.pdf', mimeType: 'application/pdf' },
      content: pdfWithPages(3, (page) => String(page).repeat(30_000)),
    };
    const [, , text] = (await download({ pages: '1-3' })).content;
    expect(text!.text).toMatch(/^Text extracted from dense\.pdf \(pages 1-2 of 3\):/);
    downloaded = { ...downloaded, content: pdfWithPages(1, () => 'x'.repeat(90_000)) };
    const [, , cut] = (await download({ pages: '1' })).content;
    expect(cut!.text).toBe(
      `Text extracted from dense.pdf (page 1 of 1, cut at 80,000 characters):\n\n${'x'.repeat(80_000)}`,
    );
  });

  it('reads text from PDFs that use predefined CJK character maps', async () => {
    downloaded = {
      meta: { ...attachment, filename: 'japanese.pdf', mimeType: 'application/pdf' },
      content: japanesePdf(),
    };
    expect((await download({ pages: '1' })).content[2]).toEqual({
      type: 'text',
      text: 'Text extracted from japanese.pdf:\n\n日本語',
    });
  });

  it('ships character maps from the pdf.js version that unpdf bundles', async () => {
    // Copy pdfjs-dist/cmaps for the new version into pdf-cmaps/ when this fails after an unpdf upgrade.
    expect((await getResolvedPDFJS()).version).toBe(PDF_CMAP_PDFJS_VERSION);
  });

  it('rejects page ranges for attachments that are not PDFs', async () => {
    const result = await download({ pages: '1-2' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Pages apply only to PDF attachments.');
  });

  it('gives 2025-03-26 clients the attachment URI as text instead of a resource link', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const responses = new Map<number, JSONRPCMessage>();
    clientTransport.onmessage = (message) => {
      if ('id' in message && typeof message.id === 'number') responses.set(message.id, message);
    };
    await buildServer().connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'old', version: '0.0.0' } },
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'download_attachment', arguments: { messageId: 'message-id', attachmentId: 'attachment-id' } },
    });
    await vi.waitFor(() => expect(responses.has(2)).toBe(true));
    expect(responses.get(1)).toMatchObject({ result: { protocolVersion: '2025-03-26' } });
    expect(responses.get(2)).toMatchObject({
      result: { content: [{ type: 'text', text: JSON.stringify({ data: attachment, uri: attachmentUri }, null, 2) }] },
    });
    await clientTransport.close();
  });

  it('uses the protocol version header on stateless HTTP requests', async () => {
    const call = async (protocolVersion?: string) => {
      const server = buildServer({ transport: 'http' });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'download_attachment',
              arguments: { messageId: 'message-id', attachmentId: 'attachment-id' },
            },
          }),
        }),
      );
      await server.close();
      const { result } = (await response.json()) as { result: { content: Content[] } };
      return result.content.map((item) => item.type);
    };
    await expect(call('2025-06-18')).resolves.toEqual(['text', 'resource_link']);
    await expect(call('2025-03-26')).resolves.toEqual(['text']);
    await expect(call()).resolves.toEqual(['text']);
  });

  it('reads UTF-8 text resources as text and binary resources as blobs', async () => {
    const client = await connect();
    try {
      expect(await client.readResource({ uri: attachmentUri })).toEqual({
        contents: [{ uri: attachmentUri, mimeType: 'text/plain', text: 'hi' }],
      });
      expect(getAttachment).toHaveBeenLastCalledWith('acct_1', 'message-id', 'attachment-id', expect.any(Number));
      downloaded = { meta: { ...attachment, mimeType: 'application/json' }, content: Buffer.from('{}') };
      expect(await client.readResource({ uri: attachmentUri })).toEqual({
        contents: [{ uri: attachmentUri, mimeType: 'application/json', text: '{}' }],
      });
      downloaded = { meta: { ...attachment, mimeType: 'application/zip' }, content: Buffer.from([0, 1]) };
      expect(await client.readResource({ uri: attachmentUri })).toEqual({
        contents: [{ uri: attachmentUri, mimeType: 'application/zip', blob: 'AAE=' }],
      });
    } finally {
      await client.close();
    }
  });
});

// One page that shows 日本語 through the predefined UniJIS-UCS2-H CMap, with no embedded font.
function japanesePdf(): Buffer {
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    streamObject('BT /F1 24 Tf 72 720 Td <65E5672C8A9E> Tj ET'),
    '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R >>',
    '<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
  ]);
}

function streamObject(stream: string): string {
  return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
}

function pdfWithPages(count: number, text = (page: number) => `Page ${page}`): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let page = 1; page <= count; page++) {
    // A tiny font keeps long test strings inside the page, where pdf.js reads them.
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objects.length + 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      streamObject(`BT /F1 0.01 Tf 72 720 Td (${text(page)}) Tj ET`),
    );
  }
  return pdfFromObjects(objects);
}

function pdfFromObjects(objects: string[]): Buffer {
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
