import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { EmailError } from '@fluxmail/core';
import type { EmailService } from '../src/service/emailService.js';
import { buildMcpServer, MODIFY_TOOLS, toSendRequest, type McpServerOptions } from '../src/mcp/buildServer.js';
import {
  ALL_MAIL_PERMISSION_POLICY,
  FULL_PERMISSION_POLICY,
  customPermissionPolicy,
  permissionPolicyForProfile,
} from '../src/permissions.js';
import { createTelemetry, type Telemetry } from '../src/telemetry.js';
import type { Logger } from '../src/logging.js';

const draftMessage = {
  id: 'd1',
  threadId: 't1',
  accountId: 'acct_1',
  from: { email: 'me@example.com' },
  to: [{ email: 'recipient@example.com' }],
  subject: 'Reply',
  date: '2026-07-11T09:00:00.000Z',
  body: { text: 'Reply' },
  attachments: [],
  flags: { read: true, starred: false, draft: true },
  draftId: 'd1',
};

function loggerSpy(): { logger: Logger; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const error = vi.fn();
  return {
    warn,
    error,
    logger: {
      info: vi.fn(),
      warn,
      error,
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
  };
}

async function connectMcp(service: Partial<EmailService>, options?: McpServerOptions) {
  const server = buildMcpServer(service as EmailService, { permissions: FULL_PERMISSION_POLICY, ...options });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function telemetrySpy(): {
  telemetry: Telemetry;
  capture: ReturnType<typeof vi.fn>;
  beginActivity: ReturnType<typeof vi.fn>;
  finishActivity: ReturnType<typeof vi.fn>;
} {
  const capture = vi.fn();
  const finishActivity = vi.fn();
  const beginActivity = vi.fn(() => finishActivity);
  return {
    capture,
    beginActivity,
    finishActivity,
    telemetry: { capture, beginActivity, shutdown: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('toSendRequest', () => {
  it('uses an existing draft when no replacement content is supplied', () => {
    expect(toSendRequest({ draftId: 'draft_1' })).toEqual({ draftId: 'draft_1' });
  });

  it('rejects content fields combined with an existing draft id', () => {
    expect(() => toSendRequest({ draftId: 'draft_1', bodyText: 'replacement' })).toThrow(/update the draft/);
    expect(() => toSendRequest({ draftId: 'draft_1', from: 'sales@example.com' })).toThrow(/update the draft/);
  });

  it('rejects replyAll without a reply target', () => {
    expect(() => toSendRequest({ replyAll: true })).toThrow(/requires replyToMessageId/);
  });
});

describe('MCP optional inputs', () => {
  it('advertises nullable optional fields while required fields still reject null', async () => {
    const client = await connectMcp({ enforceQuota: () => undefined });
    try {
      const validator = new AjvJsonSchemaValidator();
      for (const tool of (await client.listTools()).tools) {
        expect(JSON.stringify(tool.inputSchema)).not.toContain('"not":');
        const required = tool.inputSchema.required ?? [];
        // Validate each supplied field without requiring unrelated fields in the same tool.
        const validate = validator.getValidator({ ...tool.inputSchema, required: [] });
        for (const name of Object.keys(tool.inputSchema.properties ?? {})) {
          expect(validate({ [name]: null }).valid, `${tool.name}.${name}`).toBe(!required.includes(name));
        }
      }
      const listTool = (await client.listTools()).tools.find((tool) => tool.name === 'list_emails')!;
      expect(listTool.inputSchema.required ?? []).toEqual([]);
      expect(listTool.inputSchema.properties?.accountId).toMatchObject({
        description: 'Account to operate on. Optional when exactly one account is connected.',
      });
    } finally {
      await client.close();
    }
  });

  it('treats null listing filters and pagination as omitted', async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [], exhausted: true });
    const client = await connectMcp({ enforceQuota: () => undefined, listMessages });
    try {
      const tool = (await client.listTools()).tools.find((tool) => tool.name === 'list_emails')!;
      for (const args of [
        {},
        Object.fromEntries(Object.keys(tool.inputSchema.properties!).map((key) => [key, null])),
      ]) {
        const result = await client.callTool({ name: 'list_emails', arguments: args });
        expect(result.isError).toBeFalsy();
      }
      expect(listMessages.mock.calls).toEqual([
        [undefined, {}, {}],
        [undefined, {}, {}],
      ]);
    } finally {
      await client.close();
    }
  });

  it('preserves false filters and valid values alongside nulls', async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [], exhausted: true });
    const client = await connectMcp({ enforceQuota: () => undefined, listMessages });
    try {
      const result = await client.callTool({
        name: 'list_emails',
        arguments: {
          accountId: null,
          folder: 'inbox',
          from: 'ann@example.com',
          subject: null,
          read: false,
          starred: false,
          hasAttachment: false,
          pageSize: 3,
          pageToken: null,
          includeSnippet: false,
          includeSearchContext: false,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(listMessages).toHaveBeenCalledWith(
        undefined,
        { folder: 'inbox', from: 'ann@example.com', read: false, starred: false, hasAttachment: false },
        { pageSize: 3, includeSnippet: false, includeSearchContext: false },
      );
    } finally {
      await client.close();
    }
  });

  it('normalizes null search filters and nested batch pagination', async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [], exhausted: true });
    const searchMessagesBatch = vi.fn().mockResolvedValue({
      groups: [{ accountId: 'acct_1', page: { items: [], exhausted: true } }],
      exhausted: true,
    });
    const client = await connectMcp({ enforceQuota: () => undefined, listMessages, searchMessagesBatch });
    try {
      const searched = await client.callTool({
        name: 'search_emails',
        arguments: { query: 'is:unread', accountId: null, read: null, folder: null, pageToken: null },
      });
      expect(searched.isError).toBeFalsy();
      expect(listMessages).toHaveBeenCalledWith(undefined, { read: false }, {});
      const batched = await client.callTool({
        name: 'search_emails_batch',
        arguments: {
          accounts: [{ accountId: 'acct_1', pageToken: null }],
          query: 'is:unread',
          folder: null,
          pageSize: null,
          includeSnippet: null,
        },
      });
      expect(batched.isError).toBeFalsy();
      expect(searchMessagesBatch).toHaveBeenCalledWith({ accounts: [{ accountId: 'acct_1' }], query: { read: false } });
    } finally {
      await client.close();
    }
  });

  it('normalizes optional draft fields without treating false or empty content as absent', async () => {
    const createDraft = vi.fn().mockResolvedValue(draftMessage);
    const client = await connectMcp({ enforceQuota: () => undefined, createDraft });
    try {
      const result = await client.callTool({
        name: 'create_draft',
        arguments: {
          accountId: null,
          from: null,
          to: ['recipient@example.com'],
          cc: null,
          bcc: null,
          subject: '',
          bodyText: '',
          bodyHtml: null,
          replyToMessageId: null,
          replyAll: false,
          attachments: null,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(createDraft).toHaveBeenCalledWith(undefined, {
        to: [{ email: 'recipient@example.com' }],
        subject: '',
        body: { text: '' },
        replyAll: false,
      });
    } finally {
      await client.close();
    }
  });

  it('still rejects required nulls and invalid non-null optional values', async () => {
    const listMessages = vi.fn();
    const getMessage = vi.fn();
    const searchMessagesBatch = vi.fn();
    const client = await connectMcp({ enforceQuota: () => undefined, listMessages, getMessage, searchMessagesBatch });
    try {
      for (const args of [{ folder: '' }, { after: '' }, { pageToken: '' }, { pageSize: 0 }, { read: 'false' }]) {
        expect((await client.callTool({ name: 'list_emails', arguments: args })).isError).toBe(true);
      }
      expect((await client.callTool({ name: 'get_email', arguments: { messageId: null } })).isError).toBe(true);
      expect((await client.callTool({ name: 'search_emails', arguments: { query: null } })).isError).toBe(true);
      expect(
        (
          await client.callTool({
            name: 'search_emails_batch',
            arguments: { accounts: [{ accountId: null, pageToken: null }], query: 'invoice' },
          })
        ).isError,
      ).toBe(true);
      expect(listMessages).not.toHaveBeenCalled();
      expect(getMessage).not.toHaveBeenCalled();
      expect(searchMessagesBatch).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});

describe('MCP permissions', () => {
  const readTools = [
    'download_attachment',
    'get_email',
    'get_email_body',
    'get_status',
    'get_thread',
    'list_accounts',
    'list_emails',
    'list_folders',
    'list_labels',
    'list_scheduled_emails',
    'list_send_as',
    'search_emails',
    'search_emails_batch',
  ];
  const organizeTools = [
    'add_labels',
    'archive_emails',
    'mark_emails_read',
    'mark_emails_unread',
    'move_emails',
    'remove_labels',
    'star_emails',
    'unstar_emails',
  ];
  const trashTools = ['restore_emails', 'trash_emails'];

  async function toolNames(options: McpServerOptions): Promise<string[]> {
    const client = await connectMcp({ enforceQuota: () => undefined }, options);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  }

  it('defaults to the read-only profile', async () => {
    await expect(toolNames({ permissions: undefined })).resolves.toEqual(readTools);
  });

  it('advertises only read tools for the read-only profile', async () => {
    await expect(toolNames({ permissions: permissionPolicyForProfile('read-only') })).resolves.toEqual(readTools);
  });

  it('uses mail.read for every read tool', async () => {
    await expect(toolNames({ permissions: customPermissionPolicy(['mail.read']) })).resolves.toEqual(readTools);
  });

  it('adds safe write tools but not send tools for the read-write profile', async () => {
    const names = await toolNames({ permissions: permissionPolicyForProfile('read-write') });
    expect(names).toEqual(
      [
        ...readTools,
        ...organizeTools,
        ...trashTools,
        'cancel_scheduled_email',
        'create_draft',
        'delete_draft',
        'get_draft',
        'update_draft',
      ].sort(),
    );
    expect(names).not.toContain('send_email');
    expect(names).not.toContain('forward_email');
    expect(names).not.toContain('delete_emails');
  });

  it('uses one capability for trash and restore but keeps permanent delete separate', async () => {
    const modify = vi.fn().mockResolvedValue({ succeededIds: ['m1'], failed: [], uncertainIds: [] });
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.trash']),
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['trash_emails', 'restore_emails']);

    const trashed = await client.callTool({ name: 'trash_emails', arguments: { messageIds: ['m1'] } });
    expect(trashed.isError).toBeFalsy();
    expect(modify).toHaveBeenCalledWith(undefined, ['m1'], 'trash');

    const restored = await client.callTool({ name: 'restore_emails', arguments: { messageIds: ['m1'] } });
    expect(restored.isError).toBeFalsy();
    expect(modify).toHaveBeenCalledWith(undefined, ['m1'], 'untrash');

    const deleted = await client.callTool({ name: 'delete_emails', arguments: { messageIds: ['m1'] } });
    expect(deleted.isError).toBe(true);
    expect(modify).toHaveBeenCalledTimes(2);
  });

  it('requires an explicit mail.delete grant for permanent deletion', async () => {
    expect(FULL_PERMISSION_POLICY.capabilities).not.toContain('mail.delete');
    await expect(toolNames({ permissions: FULL_PERMISSION_POLICY })).resolves.not.toContain('delete_emails');
    await expect(toolNames({ permissions: ALL_MAIL_PERMISSION_POLICY })).resolves.toContain('delete_emails');
    await expect(
      toolNames({ permissions: customPermissionPolicy(['mail.read', 'mail.organize', 'mail.trash']) }),
    ).resolves.not.toContain('delete_emails');
  });

  it('uses mail.organize for reversible message organization', async () => {
    const modify = vi.fn().mockResolvedValue({ succeededIds: ['m1'], failed: [], uncertainIds: [] });
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.organize']),
    });

    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(organizeTools);

    for (const [name, action] of [
      ['mark_emails_read', 'markRead'],
      ['mark_emails_unread', 'markUnread'],
      ['star_emails', 'star'],
      ['unstar_emails', 'unstar'],
    ]) {
      const result = await client.callTool({ name: name!, arguments: { messageIds: ['m1'] } });
      expect(result.isError).toBeFalsy();
      expect(modify).toHaveBeenCalledWith(undefined, ['m1'], action);
    }
  });

  it('does not let generic move permissions change protected folders', async () => {
    const modify = vi.fn().mockResolvedValue({ succeededIds: ['m1'], failed: [], uncertainIds: [] });
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.organize']),
    });

    for (const folder of ['Trash', 'Archive', ' trash ']) {
      const result = await client.callTool({ name: 'move_emails', arguments: { messageIds: ['m1'], folder } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(String((result.content as Array<{ text: string }>)[0]!.text))).toMatchObject({
        error: 'invalid_request',
        message: 'Archive or trash these messages instead of moving them to this folder.',
      });
    }
    expect(modify).not.toHaveBeenCalled();
  });

  it('defers label-name validation to the provider', async () => {
    const modify = vi.fn().mockResolvedValue({ succeededIds: ['m1'], failed: [], uncertainIds: [] });
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.organize']),
    });

    const result = await client.callTool({
      name: 'add_labels',
      arguments: { messageIds: ['m1'], labels: ['Important'] },
    });

    expect(result.isError).toBeFalsy();
    expect(modify).toHaveBeenCalledWith(undefined, ['m1'], { addLabels: ['Important'] });
  });

  it('requires read access to expose forwarding', async () => {
    await expect(toolNames({ permissions: customPermissionPolicy(['mail.send']) })).resolves.not.toContain(
      'forward_email',
    );

    const deliverForward = vi.fn().mockResolvedValue({
      operationId: 'dop_2',
      accountId: 'acct_1',
      kind: 'forward',
      status: 'succeeded',
      result: { id: 'm2', threadId: 't2' },
    });
    const client = await connectMcp({ enforceQuota: () => undefined, deliverForward } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.send', 'mail.read']),
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('forward_email');

    const withAttachments = await client.callTool({
      name: 'forward_email',
      arguments: { messageId: 'm1', to: ['recipient@example.com'], idempotencyKey: 'forward-1' },
    });
    expect(withAttachments.isError).toBeFalsy();
    expect(deliverForward).toHaveBeenCalledOnce();

    const withoutAttachments = await client.callTool({
      name: 'forward_email',
      arguments: {
        messageId: 'm1',
        to: ['recipient@example.com'],
        includeAttachments: false,
        idempotencyKey: 'forward-2',
      },
    });
    expect(withoutAttachments.isError).toBeFalsy();
    expect(deliverForward).toHaveBeenCalledTimes(2);
  });
});

describe('MCP typed search', () => {
  it('parses portable syntax and includes parser warnings in the result', async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [], exhausted: true });
    const client = await connectMcp({ enforceQuota: () => undefined, listMessages } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
    });

    const result = await client.callTool({
      name: 'search_emails',
      arguments: {
        query: 'form:ann@example.com is:unread',
        starred: true,
        includeSearchContext: true,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(listMessages).toHaveBeenCalledWith(
      undefined,
      { text: 'form:ann@example.com', read: false, starred: true },
      { includeSearchContext: true },
    );
    expect(JSON.stringify(result.content)).toContain('possible_operator_typo');
  });

  it('rejects invalid syntax and duplicate structured filters', async () => {
    const listMessages = vi.fn();
    const client = await connectMcp({ enforceQuota: () => undefined, listMessages } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
    });

    const invalid = await client.callTool({
      name: 'search_emails',
      arguments: { query: 'in:starred' },
    });
    expect(invalid.isError).toBe(true);

    const duplicate = await client.callTool({
      name: 'search_emails',
      arguments: { query: 'from:ann@example.com', from: 'bob@example.com' },
    });
    expect(duplicate.isError).toBe(true);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('returns mixed batch results and marks all-account failures as tool errors', async () => {
    const searchMessagesBatch = vi
      .fn()
      .mockResolvedValueOnce({
        groups: [
          {
            accountId: 'acct_1',
            page: {
              items: [{ searchContext: { status: 'matched', excerpt: 'private body excerpt' } }],
              exhausted: true,
            },
          },
          {
            accountId: 'acct_2',
            error: { code: 'provider_unavailable', message: 'Search timed out.', exhausted: false },
          },
        ],
        exhausted: false,
      })
      .mockResolvedValueOnce({
        groups: [
          {
            accountId: 'acct_2',
            error: { code: 'provider_unavailable', message: 'Search timed out.', exhausted: false },
          },
        ],
        exhausted: false,
      })
      .mockResolvedValueOnce({
        groups: [{ accountId: 'acct_1', page: { items: [], exhausted: true } }],
        exhausted: true,
      });
    const capture = vi.fn();
    const client = await connectMcp({ enforceQuota: () => undefined, searchMessagesBatch } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
      telemetry: { capture, shutdown: async () => undefined },
    });

    const mixed = await client.callTool({
      name: 'search_emails_batch',
      arguments: {
        accounts: [{ accountId: 'acct_1' }, { accountId: 'acct_2' }],
        query: 'invoice subject:report',
        includeSnippet: true,
        includeSearchContext: true,
      },
    });
    expect(mixed.isError).toBeFalsy();
    expect(JSON.stringify(mixed.content)).toContain('private body excerpt');
    expect(searchMessagesBatch).toHaveBeenNthCalledWith(1, {
      accounts: [{ accountId: 'acct_1' }, { accountId: 'acct_2' }],
      query: { subject: 'report', text: 'invoice' },
      includeSnippet: true,
      includeSearchContext: true,
    });

    const failed = await client.callTool({
      name: 'search_emails_batch',
      arguments: { accounts: [{ accountId: 'acct_2' }], query: 'subject:report' },
    });
    expect(failed.isError).toBe(true);
    const succeeded = await client.callTool({
      name: 'search_emails_batch',
      arguments: { accounts: [{ accountId: 'acct_1' }], query: 'subject:complete' },
    });
    expect(succeeded.isError).toBeFalsy();
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'search_emails_batch',
        outcome: 'error',
        error_code: 'account_failure',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private body excerpt');
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'search_emails_batch',
        outcome: 'success',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('subject:report');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('subject:complete');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('acct_1');
  });

  it('includes parser warnings in successful batch groups', async () => {
    const searchMessagesBatch = vi.fn().mockResolvedValue({
      groups: [{ accountId: 'acct_1', page: { items: [], exhausted: true } }],
      exhausted: true,
    });
    const client = await connectMcp({ enforceQuota: () => undefined, searchMessagesBatch } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
    });

    const result = await client.callTool({
      name: 'search_emails_batch',
      arguments: { accounts: [{ accountId: 'acct_1' }], query: 'form:ann@example.com' },
    });

    expect(result.isError).toBeFalsy();
    expect(searchMessagesBatch).toHaveBeenCalledWith({
      accounts: [{ accountId: 'acct_1' }],
      query: { text: 'form:ann@example.com' },
    });
    expect(JSON.stringify(result.content)).toContain('possible_operator_typo');
  });

  it('returns actionable local search diagnostics without calling the provider', async () => {
    const listMessages = vi.fn();
    const client = await connectMcp({ enforceQuota: () => undefined, listMessages } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
    });
    const result = await client.callTool({
      name: 'search_emails',
      arguments: { accountId: 'acct_1', query: 'from:ann@example.com', from: 'bob@example.com' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('diagnostics');
    expect(JSON.stringify(result.content)).toContain('invalid_request');
    expect(listMessages).not.toHaveBeenCalled();
  });
});

describe('attachment tool', () => {
  it('returns an embedded binary resource and passes the size limit to the service', async () => {
    const getAttachment = vi.fn().mockResolvedValue({
      meta: { id: 'a1', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
      content: Buffer.from('pdf'),
      accountId: 'acct_1',
    });
    const client = await connectMcp({ enforceQuota: () => undefined, getAttachment } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
      maxAttachmentBytes: 3,
    });

    const result = await client.callTool({
      name: 'download_attachment',
      arguments: { accountId: 'acct_1', messageId: 'INBOX:42', attachmentId: 'AAMk=+/' },
    });

    expect(result.isError).toBeFalsy();
    expect(getAttachment).toHaveBeenCalledWith('acct_1', 'INBOX:42', 'AAMk=+/', 3);
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'resource_link', mimeType: 'application/pdf' }),
    );
    const link = result.content.find((item) => item.type === 'resource_link');
    expect(link?.type).toBe('resource_link');
    if (link?.type === 'resource_link') {
      const fetched = await client.readResource({ uri: link.uri });
      expect(fetched.contents).toContainEqual(expect.objectContaining({ blob: Buffer.from('pdf').toString('base64') }));
      expect(getAttachment).toHaveBeenLastCalledWith('acct_1', 'INBOX:42', 'AAMk=+/', 3);
    }
    const inline = await client.callTool({
      name: 'download_attachment',
      arguments: { accountId: 'acct_1', messageId: 'INBOX:42', attachmentId: 'AAMk=+/', inline: true },
    });
    expect(inline.content).toContainEqual({
      type: 'resource',
      resource: expect.objectContaining({ blob: Buffer.from('pdf').toString('base64') }),
    });
  });

  it('checks the final decoded size even when a provider ignores the limit', async () => {
    const getAttachment = vi.fn().mockResolvedValue({
      meta: { id: 'a1', filename: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: 4 },
      content: Buffer.alloc(4),
    });
    const client = await connectMcp({ enforceQuota: () => undefined, getAttachment } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
      maxAttachmentBytes: 3,
    });

    const result = await client.callTool({
      name: 'download_attachment',
      arguments: { accountId: 'acct_1', messageId: 'm1', attachmentId: 'a1' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('invalid_request');
  });
});

describe('typed MCP responses', () => {
  it('hides unexpected exception text and returns a request ID', async () => {
    const getMessage = vi.fn().mockRejectedValue(new Error('private database password'));
    const client = await connectMcp({ enforceQuota: () => undefined, getMessage } as Partial<EmailService>);
    const result = await client.callTool({ name: 'get_email', arguments: { messageId: 'm1' } });
    expect(result.isError).toBe(true);
    const error = JSON.parse(String(result.content.find((item) => item.type === 'text')?.text));
    expect(error).toMatchObject({ error: 'internal', requestId: expect.any(String) });
    expect(JSON.stringify(result.content)).not.toContain('private database password');
  });

  it('marks partial bulk changes as errors while retaining each outcome', async () => {
    const { telemetry, capture } = telemetrySpy();
    const modify = vi.fn().mockResolvedValue({
      succeededIds: ['m1'],
      failed: [{ messageId: 'm2', code: 'not_found' }],
      uncertainIds: ['m3'],
    });
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, { telemetry });
    const result = await client.callTool({
      name: 'mark_emails_read',
      arguments: { messageIds: ['m1', 'm2', 'm3'] },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: { succeededIds: ['m1'], failed: [{ messageId: 'm2', code: 'not_found' }], uncertainIds: ['m3'] },
    });
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'mark_emails_read',
        outcome: 'error',
        error_code: 'account_failure',
        action: 'markRead',
      }),
    );
  });

  it('advertises output schemas accepted by clients using the MCP default dialect', async () => {
    const client = await connectMcp({ enforceQuota: () => undefined });
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object', properties: { data: expect.any(Object) } });
      expect(tool.outputSchema?.$schema, tool.name).toBeUndefined();
      expect(tool.outputSchema?.required, tool.name).toContain('data');
    }
  });

  it('bounds body content in typed MCP responses', async () => {
    const getMessage = vi.fn().mockResolvedValue({ ...draftMessage, body: { text: 'x'.repeat(60_000) } });
    const client = await connectMcp({ enforceQuota: () => undefined, getMessage } as Partial<EmailService>);
    const first = await client.callTool({
      name: 'get_email',
      arguments: { messageId: 'private-message', bodyFormat: 'text' },
    });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({
      data: { bodyTruncation: { text: { totalChars: 60_000, nextOffset: 50_000 } } },
    });
    const next = await client.callTool({
      name: 'get_email_body',
      arguments: { messageId: 'private-message', format: 'text', offset: 50_000 },
    });
    expect(next.structuredContent).toMatchObject({ data: { totalChars: 60_000, offset: 50_000 } });
    expect((next.structuredContent as { data: { text: string } }).data.text).toHaveLength(10_000);
  });

  it('records safe success and error telemetry for new lookups', async () => {
    const { telemetry, capture } = telemetrySpy();
    const getDraft = vi
      .fn()
      .mockResolvedValueOnce(draftMessage)
      .mockRejectedValueOnce(new EmailError('not_found', 'private draft ID'));
    const previewSend = vi.fn().mockResolvedValue({
      accountId: 'acct_1',
      from: 'me@example.com',
      to: [{ email: 'private@example.com' }],
      cc: [],
      bcc: [],
      subject: 'private subject',
      attachments: [],
      bodyTextChars: 3,
      bodyHtmlChars: 0,
    });
    const getDelivery = vi.fn().mockReturnValue({
      operationId: 'private-operation',
      accountId: 'acct_1',
      kind: 'send',
      status: 'uncertain',
      error: { code: 'provider_unavailable' },
    });
    const getMessage = vi
      .fn()
      .mockResolvedValueOnce(draftMessage)
      .mockRejectedValueOnce(new EmailError('not_found', 'private body'));
    const client = await connectMcp(
      { enforceQuota: () => undefined, getDraft, previewSend, getDelivery, getMessage } as Partial<EmailService>,
      { telemetry },
    );
    await client.callTool({ name: 'get_draft', arguments: { draftId: 'private-draft' } });
    await client.callTool({ name: 'get_draft', arguments: { draftId: 'private-draft' } });
    await client.callTool({ name: 'preview_send', arguments: { to: ['private@example.com'], bodyText: 'Hi!' } });
    await client.callTool({ name: 'get_email_body', arguments: { messageId: 'private-message', format: 'text' } });
    await client.callTool({ name: 'get_email_body', arguments: { messageId: 'private-message', format: 'text' } });
    await client.callTool({
      name: 'get_delivery_operation',
      arguments: { accountId: 'acct_1', operationId: 'private-operation' },
    });
    previewSend.mockRejectedValueOnce(new EmailError('not_found', 'private preview'));
    getDelivery.mockImplementationOnce(() => {
      throw new EmailError('not_found', 'private operation');
    });
    await client.callTool({ name: 'preview_send', arguments: { to: ['private@example.com'], bodyText: 'Hi!' } });
    await client.callTool({
      name: 'get_delivery_operation',
      arguments: { accountId: 'acct_1', operationId: 'private-operation' },
    });
    for (const operation of ['get_draft', 'preview_send', 'get_delivery_operation', 'get_email_body']) {
      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({ product_surface: 'mcp', operation, outcome: 'success' }),
      );
    }
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'get_draft',
        outcome: 'error',
        error_code: 'not_found',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'get_email_body',
        outcome: 'error',
        error_code: 'not_found',
      }),
    );
    for (const operation of ['preview_send', 'get_delivery_operation']) {
      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({ product_surface: 'mcp', operation, outcome: 'error', error_code: 'not_found' }),
      );
    }
    const captured = JSON.stringify(capture.mock.calls);
    for (const privateValue of [
      'private-draft',
      'private-operation',
      'private@example.com',
      'private subject',
      'private-message',
      'private body',
      'private preview',
    ])
      expect(captured).not.toContain(privateValue);
  });
});

describe('scheduled send tools', () => {
  function connect(service: Partial<EmailService>) {
    return connectMcp({ enforceQuota: () => undefined, ...service });
  }

  it('registers the scheduling tools', async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('send_email');
    expect(names).toContain('list_scheduled_emails');
    expect(names).toContain('cancel_scheduled_email');
  });

  it('marks an uncertain send as an error with an operation ID', async () => {
    const capture = vi.fn();
    const telemetry = createTelemetry({
      dataDir: mkdtempSync(join(tmpdir(), 'fluxmail-mcp-telemetry-')),
      env: {},
      client: { capture, shutdown: async () => undefined },
    });
    const deliver = vi.fn().mockResolvedValue({
      operationId: 'dop_uncertain',
      accountId: 'acct_1',
      kind: 'send',
      status: 'uncertain',
      error: { code: 'provider_unavailable' },
    });
    const client = await connectMcp({ enforceQuota: () => undefined, deliver } as Partial<EmailService>, { telemetry });
    const result = await client.callTool({
      name: 'send_email',
      arguments: { to: ['recipient@example.com'], bodyText: 'Hi', idempotencyKey: 'uncertain-key' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { operationId: 'dop_uncertain', status: 'uncertain' } });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'operation completed',
        properties: expect.objectContaining({
          operation: 'send_email',
          outcome: 'error',
          error_code: 'account_failure',
        }),
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: '$exception',
        properties: expect.objectContaining({
          deployment_type: 'self_hosted',
          product_surface: 'mcp',
          error_code: 'account_failure',
        }),
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(/recipient@example|uncertain-key|dop_uncertain/);
    await client.close();
    await telemetry.shutdown();
  });

  it('routes send_email with sendAt to scheduleDelivery', async () => {
    const scheduleDelivery = vi.fn().mockResolvedValue({
      operationId: 'dop_1',
      accountId: 'acct_1',
      kind: 'scheduled',
      status: 'queued',
      scheduleId: 'sch_1',
    });
    const deliver = vi.fn();
    const client = await connect({ scheduleDelivery, deliver } as Partial<EmailService>);

    const result = await client.callTool({
      name: 'send_email',
      arguments: {
        to: ['bob@example.com'],
        subject: 'Later',
        bodyText: 'hi',
        sendAt: '2026-07-11T09:00:00-07:00',
        idempotencyKey: 'schedule-1',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(deliver).not.toHaveBeenCalled();
    expect(scheduleDelivery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ subject: 'Later' }),
      '2026-07-11T09:00:00-07:00',
      'schedule-1',
    );
    // sendAt must not leak into the composed message content.
    expect(scheduleDelivery.mock.calls[0]![1]).not.toHaveProperty('sendAt');
  });

  it('routes send_email without sendAt to deliver', async () => {
    const scheduleDelivery = vi.fn();
    const deliver = vi.fn().mockResolvedValue({
      operationId: 'dop_1',
      accountId: 'acct_1',
      kind: 'send',
      status: 'succeeded',
      result: { id: 'm1', threadId: 't1' },
    });
    const client = await connect({ scheduleDelivery, deliver } as Partial<EmailService>);

    const result = await client.callTool({
      name: 'send_email',
      arguments: { draftId: 'draft_1', idempotencyKey: 'send-1' },
    });

    expect(result.isError).toBeFalsy();
    expect(scheduleDelivery).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(undefined, { draftId: 'draft_1' }, 'send-1');
  });

  it('rejects a sendAt without a timezone before reaching the service', async () => {
    const scheduleDelivery = vi.fn();
    const client = await connect({ scheduleDelivery } as Partial<EmailService>);

    const result = await client.callTool({
      name: 'send_email',
      arguments: { draftId: 'draft_1', sendAt: '2026-07-11T09:00:00', idempotencyKey: 'schedule-1' },
    });

    expect(result.isError).toBe(true);
    expect(scheduleDelivery).not.toHaveBeenCalled();
  });

  it('uses mail.send for immediate and scheduled delivery', async () => {
    const deliver = vi.fn().mockResolvedValue({
      operationId: 'dop_1',
      accountId: 'acct_1',
      kind: 'send',
      status: 'succeeded',
      result: { id: 'm1', threadId: 't1' },
    });
    const scheduleDelivery = vi.fn().mockResolvedValue({
      operationId: 'dop_2',
      accountId: 'acct_1',
      kind: 'scheduled',
      status: 'queued',
      scheduleId: 'sch_1',
    });
    const client = await connectMcp(
      { enforceQuota: () => undefined, deliver, scheduleDelivery } as Partial<EmailService>,
      {
        permissions: customPermissionPolicy(['mail.send']),
      },
    );

    const direct = await client.callTool({
      name: 'send_email',
      arguments: { to: ['bob@example.com'], subject: 'Hello', bodyText: 'Hi', idempotencyKey: 'send-1' },
    });
    expect(direct.isError).toBeFalsy();

    const reply = await client.callTool({
      name: 'send_email',
      arguments: { replyToMessageId: 'm1', bodyText: 'Hi', idempotencyKey: 'send-2' },
    });
    expect(reply.isError).toBe(true);

    const draft = await client.callTool({
      name: 'send_email',
      arguments: { draftId: 'draft_1', idempotencyKey: 'send-3' },
    });
    expect(draft.isError).toBeFalsy();

    const scheduled = await client.callTool({
      name: 'send_email',
      arguments: {
        to: ['bob@example.com'],
        subject: 'Later',
        bodyText: 'Hi',
        sendAt: '2026-07-11T09:00:00-07:00',
        idempotencyKey: 'schedule-1',
      },
    });
    expect(scheduled.isError).toBeFalsy();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(scheduleDelivery).toHaveBeenCalledOnce();
  });

  it('uses mail.send plus read access for replies', async () => {
    const deliver = vi.fn().mockResolvedValue({
      operationId: 'dop_1',
      accountId: 'acct_1',
      kind: 'send',
      status: 'succeeded',
      result: { id: 'm2', threadId: 't1' },
    });
    const client = await connectMcp({ enforceQuota: () => undefined, deliver } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.send', 'mail.read']),
    });

    const reply = await client.callTool({
      name: 'send_email',
      arguments: { replyToMessageId: 'm1', bodyText: 'Hi', idempotencyKey: 'reply-1' },
    });
    expect(reply.isError).toBeFalsy();
    expect(deliver).toHaveBeenCalledOnce();
  });
});

describe('tool metadata', () => {
  it('gives every tool a title and explicit read-only and destructive hints', async () => {
    const client = await connectMcp({ enforceQuota: () => undefined }, { permissions: ALL_MAIL_PERMISSION_POLICY });
    try {
      for (const tool of (await client.listTools()).tools) {
        expect(tool.title, tool.name).toBeTruthy();
        expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
        if (!tool.annotations?.readOnlyHint) {
          expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
        }
      }
    } finally {
      await client.close();
    }
  });

  it('does not steer the agent away from other tools', async () => {
    for (const permissions of [permissionPolicyForProfile('read-only'), ALL_MAIL_PERMISSION_POLICY]) {
      const client = await connectMcp({ enforceQuota: () => undefined }, { permissions, transport: 'stdio' });
      try {
        const { tools } = await client.listTools();
        const text = [client.getInstructions(), ...tools.map((tool) => tool.description)].join('\n');
        expect(text).not.toMatch(/browser|connector|other email integration|another tool|other tools fail/i);
      } finally {
        await client.close();
      }
    }
  });
});

describe('modify tools', () => {
  const modifyResult = { succeededIds: ['m1'], failed: [], uncertainIds: [] };
  const modifyToolNames = Object.values(MODIFY_TOOLS).map((tool) => tool.name);

  it('maps every modify action to exactly one tool', async () => {
    expect(Object.keys(MODIFY_TOOLS).sort()).toEqual(
      [
        'addLabels',
        'archive',
        'delete',
        'markRead',
        'markUnread',
        'move',
        'removeLabels',
        'star',
        'trash',
        'unstar',
        'untrash',
      ].sort(),
    );
    expect(new Set(modifyToolNames).size).toBe(modifyToolNames.length);

    const client = await connectMcp({ enforceQuota: () => undefined }, { permissions: ALL_MAIL_PERMISSION_POLICY });
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of modifyToolNames)
        expect(
          listed.filter((item) => item === name),
          name,
        ).toHaveLength(1);
      expect(listed).not.toContain('modify_emails');
    } finally {
      await client.close();
    }
  });

  it('lists only the tools for each granted capability', async () => {
    const expected = {
      'mail.organize': [
        'mark_emails_read',
        'mark_emails_unread',
        'star_emails',
        'unstar_emails',
        'archive_emails',
        'move_emails',
        'add_labels',
        'remove_labels',
      ],
      'mail.trash': ['trash_emails', 'restore_emails'],
      'mail.delete': ['delete_emails'],
    } as const;
    for (const [capability, names] of Object.entries(expected)) {
      const client = await connectMcp(
        { enforceQuota: () => undefined },
        { permissions: customPermissionPolicy([capability as keyof typeof expected]) },
      );
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(names);
      } finally {
        await client.close();
      }
    }
    const readOnly = await connectMcp(
      { enforceQuota: () => undefined },
      { permissions: permissionPolicyForProfile('read-only') },
    );
    try {
      const listed = (await readOnly.listTools()).tools.map((tool) => tool.name);
      for (const name of modifyToolNames) expect(listed).not.toContain(name);
    } finally {
      await readOnly.close();
    }
  });

  it('advertises the agreed annotations and inputs without an action argument', async () => {
    const client = await connectMcp({ enforceQuota: () => undefined }, { permissions: ALL_MAIL_PERMISSION_POLICY });
    try {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      const destructive = new Set(['move_emails', 'trash_emails', 'delete_emails']);
      for (const name of modifyToolNames) {
        const tool = tools.get(name)!;
        expect(tool.annotations, name).toEqual({
          readOnlyHint: false,
          destructiveHint: destructive.has(name),
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(tool.inputSchema.properties, name).not.toHaveProperty('action');
        expect(tool.inputSchema.properties?.messageIds, name).toMatchObject({ type: 'array', minItems: 1 });
        expect(tool.inputSchema.properties?.accountId, name).toBeDefined();
      }
      expect(tools.get('move_emails')!.inputSchema.required).toEqual(['messageIds', 'folder']);
      for (const name of ['add_labels', 'remove_labels']) {
        expect(tools.get(name)!.inputSchema.required).toEqual(['messageIds', 'labels']);
        expect(tools.get(name)!.inputSchema.properties?.labels).toMatchObject({ minItems: 1, maxItems: 100 });
      }
      expect(tools.get('archive_emails')!.inputSchema.required).toEqual(['messageIds']);
    } finally {
      await client.close();
    }
  });

  it('runs the shared implementation with each tool action and its arguments', async () => {
    const modify = vi.fn().mockResolvedValue(modifyResult);
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: ALL_MAIL_PERMISSION_POLICY,
    });
    try {
      const cases: Array<[string, Record<string, unknown>, unknown, string]> = [
        ['mark_emails_read', {}, 'markRead', 'markRead'],
        ['mark_emails_unread', {}, 'markUnread', 'markUnread'],
        ['star_emails', {}, 'star', 'star'],
        ['unstar_emails', {}, 'unstar', 'unstar'],
        ['archive_emails', {}, 'archive', 'archive'],
        ['move_emails', { folder: 'Projects' }, { move: 'Projects' }, 'move'],
        ['add_labels', { labels: ['Customer'] }, { addLabels: ['Customer'] }, 'addLabels'],
        ['remove_labels', { labels: ['Customer'] }, { removeLabels: ['Customer'] }, 'removeLabels'],
        ['trash_emails', {}, 'trash', 'trash'],
        ['restore_emails', {}, 'untrash', 'untrash'],
        ['delete_emails', {}, 'delete', 'delete'],
      ];
      for (const [name, extra, serviceAction, resultAction] of cases) {
        modify.mockClear();
        const result = await client.callTool({
          name,
          arguments: { accountId: 'acct_1', messageIds: ['m1', 'm2'], ...extra },
        });
        expect(result.isError, name).toBeFalsy();
        expect(modify, name).toHaveBeenCalledExactlyOnceWith('acct_1', ['m1', 'm2'], serviceAction);
        expect(result.structuredContent, name).toMatchObject({ data: { ...modifyResult, action: resultAction } });
      }
    } finally {
      await client.close();
    }
  });

  it('rejects calls that omit the extra input or pass an action argument', async () => {
    const modify = vi.fn().mockResolvedValue(modifyResult);
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: ALL_MAIL_PERMISSION_POLICY,
    });
    try {
      for (const [name, args] of [
        ['move_emails', { messageIds: ['m1'] }],
        ['add_labels', { messageIds: ['m1'] }],
        ['add_labels', { messageIds: ['m1'], labels: [] }],
        ['remove_labels', { messageIds: ['m1'], labels: [] }],
        ['archive_emails', { messageIds: [] }],
      ] as const) {
        expect((await client.callTool({ name, arguments: args })).isError, name).toBe(true);
      }
      // Unknown arguments are stripped, so a stray action cannot change what a tool does.
      const archived = await client.callTool({
        name: 'archive_emails',
        arguments: { messageIds: ['m1'], action: 'delete' },
      });
      expect(archived.isError).toBeFalsy();
      expect(modify).toHaveBeenCalledExactlyOnceWith(undefined, ['m1'], 'archive');
    } finally {
      await client.close();
    }
  });

  it('treats modify_emails as an unknown tool', async () => {
    const modify = vi.fn().mockResolvedValue(modifyResult);
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: ALL_MAIL_PERMISSION_POLICY,
    });
    try {
      const result = await client.callTool({
        name: 'modify_emails',
        arguments: { messageIds: ['m1'], action: 'archive' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Tool modify_emails not found');
      expect(modify).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('records the tool and action on success and error without private input', async () => {
    const { telemetry, capture } = telemetrySpy();
    const modify = vi
      .fn()
      .mockResolvedValueOnce({ succeededIds: ['private-message'], failed: [], uncertainIds: [] })
      .mockRejectedValueOnce(new EmailError('not_found', 'private provider response'));
    const client = await connectMcp({ enforceQuota: () => undefined, modify } as Partial<EmailService>, {
      permissions: ALL_MAIL_PERMISSION_POLICY,
      telemetry,
    });
    try {
      const args = { accountId: 'private-account', messageIds: ['private-message'], folder: 'Private Projects' };
      expect((await client.callTool({ name: 'move_emails', arguments: args })).isError).toBeFalsy();
      expect((await client.callTool({ name: 'move_emails', arguments: args })).isError).toBe(true);

      const events = capture.mock.calls
        .filter(([event]) => event === 'operation completed')
        .map(([, properties]) => properties);
      expect(events).toEqual([
        expect.objectContaining({
          product_surface: 'mcp',
          operation: 'move_emails',
          outcome: 'success',
          action: 'move',
        }),
        expect.objectContaining({
          product_surface: 'mcp',
          operation: 'move_emails',
          outcome: 'error',
          error_code: 'not_found',
          action: 'move',
        }),
      ]);
      const captured = JSON.stringify(capture.mock.calls);
      for (const privateValue of ['private-account', 'private-message', 'Private Projects', 'private provider']) {
        expect(captured).not.toContain(privateValue);
      }
    } finally {
      await client.close();
    }
  });
});

describe('permission instructions', () => {
  it('tells the agent how to enable disabled actions for a stdio connection', async () => {
    const client = await connectMcp(
      { enforceQuota: () => undefined },
      {
        permissions: permissionPolicyForProfile('read-only'),
        transport: 'stdio',
      },
    );
    const instructions = client.getInstructions()!;
    expect(instructions).toContain('Tools for the disabled actions below are not available.');
    expect(instructions).toContain('explicit approval for that permission change.');
    expect(instructions).toContain('A request to perform an email action does not authorize changing permissions.');
    expect(instructions).toContain(
      '- mail.send (Send or schedule messages). To enable it, start "fluxmail stdio --profile full"',
    );
    expect(instructions).toContain('- mail.drafts (Create, update, and delete drafts; cancel scheduled sends).');
    expect(instructions).not.toContain('- mail.read');
  });

  it('names the API key command for an HTTP connection', async () => {
    const client = await connectMcp(
      { enforceQuota: () => undefined },
      {
        permissions: permissionPolicyForProfile('read-write'),
        transport: 'http',
        permissionSource: { kind: 'api_key', keyId: 'key_123' },
      },
    );
    const instructions = client.getInstructions()!;
    expect(instructions).toContain(
      '- mail.send (Send or schedule messages). To enable it, an administrator can run ' +
        '"fluxmail apikey permissions key_123 --profile full".',
    );
    expect(instructions).toContain(
      '- mail.delete (Permanently delete messages). To enable it, an administrator can run ' +
        '"fluxmail apikey permissions key_123 --profile read-write --allow mail.delete".',
    );
    expect(instructions).not.toContain('- mail.trash');
  });

  it('lists only permanent deletion for the full profile', async () => {
    const client = await connectMcp({ enforceQuota: () => undefined }, { permissions: FULL_PERMISSION_POLICY });
    const instructions = client.getInstructions()!;
    expect(instructions).toContain('- mail.delete (Permanently delete messages).');
    expect(instructions).not.toContain('- mail.send');
  });

  it('adds nothing when every action is allowed', async () => {
    const client = await connectMcp({ enforceQuota: () => undefined }, { permissions: ALL_MAIL_PERMISSION_POLICY });
    expect(client.getInstructions()).not.toContain('limited permissions');
  });
});

describe('reply permissions', () => {
  it('requires read access for reply drafts', async () => {
    const createDraft = vi.fn();
    const client = await connectMcp({ enforceQuota: () => undefined, createDraft } as Partial<EmailService>, {
      permissions: customPermissionPolicy(['mail.drafts']),
      transport: 'stdio',
    });

    const result = await client.callTool({
      name: 'create_draft',
      arguments: { replyToMessageId: 'm1', bodyText: 'Reply' },
    });
    expect(result.isError).toBe(true);
    expect(createDraft).not.toHaveBeenCalled();
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
      error: 'permission_denied',
      message:
        'This MCP connection does not allow: mail.read. To enable it, start ' +
        '"fluxmail stdio --allow mail.read --allow mail.drafts" in the MCP client configuration, ' +
        'replacing any existing --profile or --allow options, then restart the client.',
      data: { missingCapabilities: ['mail.read'] },
    });
  });

  it('uses the normal create and update capabilities for reply drafts', async () => {
    const createDraft = vi.fn().mockResolvedValue(draftMessage);
    const updateDraft = vi.fn().mockResolvedValue(draftMessage);
    const client = await connectMcp(
      { enforceQuota: () => undefined, createDraft, updateDraft } as Partial<EmailService>,
      { permissions: customPermissionPolicy(['mail.drafts', 'mail.read']) },
    );

    const created = await client.callTool({
      name: 'create_draft',
      arguments: { replyToMessageId: 'm1', bodyText: 'Reply' },
    });
    const updated = await client.callTool({
      name: 'update_draft',
      arguments: { draftId: 'd1', replyToMessageId: 'm1', bodyText: 'Updated reply' },
    });

    expect(created.isError).toBeFalsy();
    expect(updated.isError).toBeFalsy();
    expect(createDraft).toHaveBeenCalledOnce();
    expect(updateDraft).toHaveBeenCalledOnce();
  });
});

describe('tool telemetry', () => {
  it('records attachment delivery mode on success and error without private input', async () => {
    const { telemetry, capture } = telemetrySpy();
    const getAttachment = vi
      .fn()
      .mockResolvedValueOnce({
        meta: { id: 'private-attachment', filename: 'private.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
        content: Buffer.from('pdf'),
        accountId: 'private-account',
      })
      .mockResolvedValueOnce({
        meta: { id: 'private-attachment', filename: 'private.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
        content: Buffer.from('pdf'),
        accountId: 'private-account',
      })
      .mockRejectedValueOnce(new EmailError('not_found', 'private provider response'))
      .mockRejectedValueOnce(new EmailError('not_found', 'private provider response'))
      .mockResolvedValueOnce({
        meta: { id: 'private-attachment', filename: 'private.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
        content: Buffer.from('pdf'),
        accountId: 'private-account',
      })
      .mockRejectedValueOnce(new EmailError('not_found', 'private provider response'));
    const client = await connectMcp({ enforceQuota: () => undefined, getAttachment } as Partial<EmailService>, {
      permissions: permissionPolicyForProfile('read-only'),
      telemetry,
    });
    const args = {
      accountId: 'private-account',
      messageId: 'private-message',
      attachmentId: 'private-attachment',
    };
    await client.callTool({ name: 'download_attachment', arguments: args });
    await client.callTool({ name: 'download_attachment', arguments: { ...args, inline: true } });
    await client.callTool({ name: 'download_attachment', arguments: args });
    await client.callTool({ name: 'download_attachment', arguments: { ...args, inline: true } });
    await client.callTool({ name: 'download_attachment', arguments: { ...args, pages: '2-3' } });
    await client.callTool({ name: 'download_attachment', arguments: { ...args, pages: '2-3' } });

    const events = capture.mock.calls
      .filter(([, properties]) => properties.operation === 'download_attachment')
      .map(([, properties]) => properties);
    expect(events).toEqual([
      expect.objectContaining({ product_surface: 'mcp', outcome: 'success', destination: 'resource' }),
      expect.objectContaining({ product_surface: 'mcp', outcome: 'success', destination: 'inline' }),
      expect.objectContaining({ product_surface: 'mcp', outcome: 'error', destination: 'resource' }),
      expect.objectContaining({ product_surface: 'mcp', outcome: 'error', destination: 'inline' }),
      expect.objectContaining({ product_surface: 'mcp', outcome: 'success', destination: 'pdf_pages' }),
      expect.objectContaining({ product_surface: 'mcp', outcome: 'error', destination: 'pdf_pages' }),
    ]);
    const captured = JSON.stringify(capture.mock.calls);
    for (const privateValue of [
      'private-account',
      'private-message',
      'private-attachment',
      'private.pdf',
      'private provider response',
    ]) {
      expect(captured).not.toContain(privateValue);
    }
  });

  it('records sanitized send-as discovery success and errors', async () => {
    const { telemetry, capture } = telemetrySpy();
    const listSendAs = vi
      .fn()
      .mockResolvedValueOnce([{ email: 'private-alias@example.com', isPrimary: false, source: 'provider' as const }])
      .mockRejectedValueOnce(new EmailError('provider_unavailable', 'private discovery response'));
    const client = await connectMcp({ enforceQuota: () => undefined, listSendAs } as Partial<EmailService>, {
      telemetry,
      transport: 'http',
    });

    await client.callTool({ name: 'list_send_as', arguments: { accountId: 'private-account' } });
    await client.callTool({ name: 'list_send_as', arguments: { accountId: 'private-account' } });

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'mcp', operation: 'list_send_as', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'list_send_as',
        outcome: 'error',
        error_code: 'provider_unavailable',
      }),
    );
    const captured = JSON.stringify(capture.mock.calls);
    expect(captured).not.toContain('private-alias@example.com');
    expect(captured).not.toContain('private-account');
    expect(captured).not.toContain('private discovery response');
  });

  it('lists labels and records sanitized success telemetry', async () => {
    const { telemetry, capture } = telemetrySpy();
    const listLabels = vi.fn().mockResolvedValue([{ id: 'private-id', name: 'private-project' }]);
    const client = await connectMcp({ enforceQuota: () => undefined, listLabels } as Partial<EmailService>, {
      telemetry,
      transport: 'http',
    });

    const result = await client.callTool({ name: 'list_labels', arguments: { accountId: 'private-account' } });

    expect(result.isError).toBeFalsy();
    expect(listLabels).toHaveBeenCalledWith('private-account');
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'list_labels',
        transport: 'http',
        outcome: 'success',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-account');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-project');
  });

  it('captures the tool, transport, outcome, and allowlisted feature properties', async () => {
    const { telemetry, capture, beginActivity, finishActivity } = telemetrySpy();
    const service = {
      enforceQuota: () => undefined,
      scheduleDelivery: vi.fn().mockResolvedValue({
        operationId: 'dop_1',
        accountId: 'acct_1',
        kind: 'scheduled',
        status: 'queued',
        scheduleId: 'sch_1',
      }),
    } as Partial<EmailService>;
    const client = await connectMcp(service, { telemetry, transport: 'http' });

    await client.callTool({
      name: 'send_email',
      arguments: {
        to: ['private@example.com'],
        subject: 'private subject',
        bodyText: 'private body',
        sendAt: '2026-07-11T09:00:00-07:00',
        idempotencyKey: 'schedule-private',
      },
    });

    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'mcp',
      operation: 'send_email',
      transport: 'http',
      outcome: 'success',
      duration_ms: expect.any(Number),
      mode: 'direct',
      scheduled: true,
      reply_all: false,
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private@example.com');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private subject');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private body');
    // Initialization and the tool call each keep shutdown open until capture.
    expect(beginActivity).toHaveBeenCalledTimes(2);
    expect(finishActivity).toHaveBeenCalledTimes(2);
  });

  it('captures a safe label error code without the error message', async () => {
    const { telemetry, capture } = telemetrySpy();
    const { logger, warn, error } = loggerSpy();
    const service = {
      enforceQuota: () => undefined,
      listLabels: vi.fn(() => {
        throw new EmailError('provider_unavailable', 'private provider response');
      }),
    } as Partial<EmailService>;
    const client = await connectMcp(service, { telemetry, transport: 'stdio', logger });

    await client.callTool({ name: 'list_labels', arguments: {} });

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'mcp',
        operation: 'list_labels',
        transport: 'stdio',
        outcome: 'error',
        error_code: 'provider_unavailable',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private provider response');
    expect(warn).toHaveBeenCalledWith(
      'mcp.operation_failed',
      'private provider response',
      expect.objectContaining({ code: 'provider_unavailable' }),
      expect.objectContaining({ productSurface: 'mcp', operation: 'list_labels' }),
    );
    expect(error).not.toHaveBeenCalled();
  });
});

describe('plan quota gate', () => {
  it('blocks tool calls while over quota but keeps get_status available', async () => {
    const listAccounts = vi.fn().mockReturnValue([]);
    const status = vi.fn().mockResolvedValue({ accounts: [], providersAvailable: [] });
    const enforceQuota = vi.fn(() => {
      throw new EmailError('entitlement_exceeded', 'Renew the license or remove mailboxes/members');
    });
    const client = await connectMcp({ listAccounts, status, enforceQuota } as Partial<EmailService>);

    const blocked = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain('entitlement_exceeded');
    expect(listAccounts).not.toHaveBeenCalled();

    const diagnostics = await client.callTool({ name: 'get_status', arguments: {} });
    expect(diagnostics.isError).toBeFalsy();
    expect(status).toHaveBeenCalled();
  });

  it('appends the renewal warning to tool results while the license is in grace', async () => {
    const listAccounts = vi.fn().mockReturnValue([]);
    const enforceQuota = vi.fn().mockReturnValue('The Fluxmail license expired yesterday');
    const client = await connectMcp({ listAccounts, enforceQuota } as Partial<EmailService>);

    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(result.isError).toBeFalsy();
    const texts = (result.content as Array<{ text: string }>).map((c) => c.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe('Note: The Fluxmail license expired yesterday');
  });
});
