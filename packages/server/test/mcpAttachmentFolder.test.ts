import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { EmailService } from '../src/service/emailService.js';
import { buildMcpServer, type McpServerOptions } from '../src/mcp/buildServer.js';
import { AttachmentFolder } from '../src/mcp/attachmentFolder.js';
import { FULL_PERMISSION_POLICY } from '../src/permissions.js';

const draft = {
  id: 'd1',
  threadId: 't1',
  accountId: 'acct_1',
  to: [{ email: 'ann@example.com' }],
  subject: 'Report',
  date: '2026-11-19T10:00:00.000Z',
  body: { text: 'Attached' },
  attachments: [],
  flags: { read: true, starred: false, draft: true },
  draftId: 'd1',
};

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fluxmail-mcp-attachments-')));
  writeFileSync(path.join(root, 'report.pdf'), 'pdf bytes');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function connect(service: Partial<EmailService>, options: McpServerOptions = {}) {
  const server = buildMcpServer({ enforceQuota: () => undefined, ...service } as EmailService, {
    permissions: FULL_PERMISSION_POLICY,
    ...options,
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('attachment folder', () => {
  it('adds attachmentFiles and save_attachment only when the connection has a folder', async () => {
    const without = await connect({});
    const plain = (await without.listTools()).tools;
    expect(plain.find((tool) => tool.name === 'create_draft')?.inputSchema.properties).not.toHaveProperty(
      'attachmentFiles',
    );
    expect(plain.map((tool) => tool.name)).not.toContain('save_attachment');
    const rejected = await without.callTool({
      name: 'create_draft',
      arguments: { to: ['ann@example.com'], attachmentFiles: [{ path: 'report.pdf' }] },
    });
    expect(rejected.isError).toBe(true);

    const withFolder = await connect({}, { attachmentFolder: AttachmentFolder.open(root) });
    const tools = (await withFolder.listTools()).tools;
    for (const name of ['create_draft', 'update_draft', 'preview_send', 'send_email']) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema.properties).toHaveProperty('attachmentFiles');
    }
    expect(tools.find((tool) => tool.name === 'download_attachment')?.inputSchema.properties).not.toHaveProperty(
      'saveAs',
    );
    expect(tools.find((tool) => tool.name === 'save_attachment')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('attaches files from the folder', async () => {
    const createDraft = vi.fn().mockResolvedValue(draft);
    const client = await connect({ createDraft }, { attachmentFolder: AttachmentFolder.open(root) });

    const result = await client.callTool({
      name: 'create_draft',
      arguments: {
        to: ['ann@example.com'],
        bodyText: 'Attached',
        attachments: [{ filename: 'a.txt', mimeType: 'text/plain', content: 'YQ==' }],
        attachmentFiles: [{ path: 'report.pdf' }],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(createDraft.mock.calls[0]![1].attachments).toEqual([
      { filename: 'a.txt', mimeType: 'text/plain', content: 'YQ==' },
      { filename: 'report.pdf', mimeType: 'application/pdf', content: Buffer.from('pdf bytes').toString('base64') },
    ]);
  });

  it('refuses a file outside the folder without calling the service', async () => {
    const createDraft = vi.fn();
    const client = await connect({ createDraft }, { attachmentFolder: AttachmentFolder.open(root) });

    const result = await client.callTool({
      name: 'create_draft',
      arguments: { to: ['ann@example.com'], attachmentFiles: [{ path: '../../etc/passwd' }] },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('outside the attachment folder');
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('saves an attachment larger than the MCP limit to a new file', async () => {
    const content = Buffer.alloc(2_048, 1);
    const meta = { id: 'p1', filename: 'big.pdf', mimeType: 'application/pdf', sizeBytes: content.length };
    const getAttachment = vi.fn().mockResolvedValue({ meta, content, accountId: 'acct_1' });
    const client = await connect(
      { getAttachment },
      { attachmentFolder: AttachmentFolder.open(root), maxAttachmentBytes: 1_024 },
    );

    const saved = await client.callTool({
      name: 'save_attachment',
      arguments: { messageId: 'm1', attachmentId: 'p1', path: 'big.pdf' },
    });

    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent).toEqual({ data: { ...meta, savedTo: 'big.pdf' } });
    expect(getAttachment).toHaveBeenCalledWith(undefined, 'm1', 'p1');
    expect(readFileSync(path.join(root, 'big.pdf'))).toEqual(content);

    const again = await client.callTool({
      name: 'save_attachment',
      arguments: { messageId: 'm1', attachmentId: 'p1', path: 'big.pdf' },
    });
    expect(again.isError).toBe(true);
    expect(JSON.stringify(again.content)).toContain('already exists');
  });

  it('adds files to the attachments an update_draft keeps', async () => {
    const current = {
      ...draft,
      attachments: [{ id: 'p1', filename: 'contract.pdf', mimeType: 'application/pdf', sizeBytes: 3 }],
    };
    const updateDraft = vi.fn().mockResolvedValue(current);
    const client = await connect(
      {
        getDraft: vi.fn().mockResolvedValue(current),
        getAttachment: vi.fn().mockResolvedValue({ meta: current.attachments[0], content: Buffer.from('pdf') }),
        updateDraft,
      },
      { attachmentFolder: AttachmentFolder.open(root) },
    );

    const result = await client.callTool({
      name: 'update_draft',
      arguments: { draftId: 'd1', attachmentFiles: [{ path: 'report.pdf' }] },
    });

    expect(result.isError).toBeFalsy();
    expect(updateDraft.mock.calls[0]![2].attachments.map((item: { filename: string }) => item.filename)).toEqual([
      'contract.pdf',
      'report.pdf',
    ]);
  });

  it('points a send whose file is gone at the delivery record', async () => {
    const client = await connect({}, { attachmentFolder: AttachmentFolder.open(root) });

    const result = await client.callTool({
      name: 'send_email',
      arguments: {
        idempotencyKey: 'k1',
        to: ['ann@example.com'],
        bodyText: 'Attached',
        attachmentFiles: [{ path: 'moved.pdf' }],
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('check get_delivery_operation');
  });
});
