import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type Tool } from '@modelcontextprotocol/server';
import { EmailError, type EmailProvider, type Message } from '@fluxmail/core';
import { GMAIL_CAPABILITIES } from '@fluxmail/provider-gmail';
import { buildMcpServer } from '../src/mcp/buildServer.js';
import { createApp } from '../src/http/app.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService } from '../src/service/emailService.js';
import { accounts, openDb } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { ALL_MAIL_PERMISSION_POLICY, FULL_PERMISSION_POLICY, permissionPolicyForProfile } from '../src/permissions.js';
import type { FluxmailConfig } from '../src/config.js';

const contract: Tool[] = JSON.parse(readFileSync(new URL('./fixtures/mcp-contract.json', import.meta.url), 'utf8'));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const attachment = { id: 'a1', filename: 'private.txt', mimeType: 'text/plain', sizeBytes: 2 };
const message: Message = {
  id: 'm1',
  threadId: 't1',
  accountId: 'acct_test',
  to: [{ email: 'owner@example.com' }],
  subject: 'private subject',
  date: '2026-10-25T00:00:00Z',
  body: { text: 'private body' },
  attachments: [attachment],
  flags: { read: true, starred: false, draft: false },
};

function setup() {
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 10,
    licenseServerUrl: 'https://license.invalid',
  };
  const db = openDb(':memory:');
  cleanups.push(() => (db as unknown as { $client: { close(): void } }).$client.close());
  const registry = new AccountRegistry(db, config);
  cleanups.push(() => registry.close());
  const owner = addMember(db, { name: 'Owner' });
  db.insert(accounts)
    .values({
      id: 'acct_test',
      provider: 'gmail',
      email: 'owner@example.com',
      ownerMemberId: owner.id,
      status: 'active',
      createdAt: Date.now(),
    })
    .run();
  const provider = {
    capabilities: GMAIL_CAPABILITIES,
    listMessages: vi.fn(async () => ({ items: [message], exhausted: true })),
    getMessage: vi.fn(async () => message),
    getAttachment: vi.fn(async () => ({ meta: attachment, content: Buffer.from('hi') })),
    send: vi.fn(async () => ({ id: 'sent_1', threadId: 't1' })),
  };
  vi.spyOn(registry, 'getProvider').mockReturnValue(provider as unknown as EmailProvider);
  const capture = vi.fn();
  const service = new EmailService(registry, db);
  const app = createApp({ config, db, registry, service, telemetry: { capture, shutdown: async () => {} } });
  const full = createApiKey(db, 'full', owner.id, FULL_PERMISSION_POLICY).key;
  const read = createApiKey(db, 'read', owner.id, permissionPolicyForProfile('read-only')).key;
  const foreign = createApiKey(db, 'restricted-mailboxes', owner.id, FULL_PERMISSION_POLICY, []).key;
  return { app, provider, capture, service, full, read, foreign };
}

async function connect(app: ReturnType<typeof createApp>, key: string, era: 'legacy' | 'modern') {
  const client = new Client(
    { name: 'codex', version: '1.0.0' },
    {
      versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    },
  );
  cleanups.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost:8977/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: (url, init) => app.request(new Request(url, init)),
    }),
  );
  expect(client.getProtocolEra()).toBe(era);
  return client;
}

const sendArgs = {
  to: ['recipient@example.com'],
  subject: 'private subject',
  bodyText: 'private body',
  idempotencyKey: 'private-key',
};

describe.each(['legacy', 'modern'] as const)('%s HTTP protocol', (era) => {
  it('preserves the complete pre-migration tool contract', async () => {
    const handler = createMcpHandler(() =>
      buildMcpServer({} as EmailService, { permissions: ALL_MAIL_PERMISSION_POLICY }),
    );
    cleanups.push(() => handler.close());
    const client = new Client(
      { name: 'contract', version: '1' },
      { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } },
    );
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
    // The modern SDK codec removes the retired task execution declaration.
    const expected = era === 'modern' ? contract.map(({ execution: _execution, ...tool }) => tool) : contract;
    expect((await client.listTools()).tools).toEqual(expected);
  });

  it('enforces API keys, scopes, mailbox ownership, schemas, and attachment limits', async () => {
    const { app, full, read, foreign, provider } = setup();
    const client = await connect(app, full, era);
    for (const name of ['get_status', 'list_accounts', 'list_emails']) {
      expect((await client.callTool({ name, arguments: {} })).isError).not.toBe(true);
    }
    expect((await client.callTool({ name: 'get_email', arguments: { messageId: 'm1' } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'get_email', arguments: { messageId: null } })).isError).toBe(true);
    expect(
      (await client.callTool({ name: 'preview_send', arguments: { to: sendArgs.to, bodyText: sendArgs.bodyText } }))
        .isError,
    ).not.toBe(true);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('send_email');
    expect(tools).not.toContain('delete_emails');
    const restricted = await connect(app, read, era);
    expect((await restricted.callTool({ name: 'send_email', arguments: sendArgs })).isError).toBe(true);
    const stranger = await connect(app, foreign, era);
    expect(
      (await stranger.callTool({ name: 'get_email', arguments: { accountId: 'acct_test', messageId: 'm1' } })).isError,
    ).toBe(true);
    const downloaded = await client.callTool({
      name: 'download_attachment',
      arguments: { messageId: 'm1', attachmentId: 'a1' },
    });
    const link = downloaded.content.find((item) => item.type === 'resource_link');
    expect(link).toBeDefined();
    const uri = (link as { uri: string }).uri;
    expect((await client.readResource({ uri })).contents).toEqual([{ uri, mimeType: 'text/plain', text: 'hi' }]);
    await expect(stranger.readResource({ uri })).rejects.toThrow();
    provider.getAttachment.mockResolvedValue({ meta: attachment, content: Buffer.alloc(11) });
    expect(
      (await client.callTool({ name: 'download_attachment', arguments: { messageId: 'm1', attachmentId: 'a1' } }))
        .isError,
    ).toBe(true);
    expect(provider.send).not.toHaveBeenCalled();
    await expect(connect(app, 'invalid-private-token', era)).rejects.toThrow();
  });

  it.each(['success', 'uncertain'] as const)('retries a %s send without dispatching again', async (outcome) => {
    const { app, full, provider, capture } = setup();
    if (outcome === 'uncertain')
      provider.send.mockRejectedValue(new EmailError('provider_unavailable', 'private provider response'));
    const client = await connect(app, full, era);
    const first = await client.callTool({ name: 'send_email', arguments: sendArgs });
    const second = await client.callTool({ name: 'send_email', arguments: sendArgs });
    expect(first.isError).toBe(outcome === 'uncertain' ? true : undefined);
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(provider.send).toHaveBeenCalledOnce();
    const conflict = await client.callTool({ name: 'send_email', arguments: { ...sendArgs, subject: 'changed' } });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.content)).toContain('idempotency_conflict');
    const events = JSON.stringify(capture.mock.calls);
    for (const value of [...Object.values(sendArgs).flat(), 'private provider response', full])
      expect(events).not.toContain(value);
  });
});

describe('modern HTTP requests without a handshake', () => {
  it('serves discovery, calls and resources directly and rejects conflicting protocol headers', async () => {
    const { app, full } = setup();
    const request = (method: string, params: Record<string, unknown> = {}, version = '2026-07-28') =>
      app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${full}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': version,
          'mcp-method': method,
          ...(typeof (params.name ?? params.uri) === 'string' ? { 'mcp-name': String(params.name ?? params.uri) } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
    for (const [method, params] of [
      ['tools/list', {}],
      ['tools/call', { name: 'list_accounts', arguments: {} }],
      ['resources/templates/list', {}],
      ['resources/list', {}],
      ['resources/read', { uri: 'fluxmail://attachment/acct_test/m1/a1/private.txt' }],
      ['server/discover', {}],
    ] as const) {
      const response = await request(method, params);
      const body = await response.json();
      expect(response.status, `${method}: ${JSON.stringify(body)}`).toBe(200);
      expect(body).toHaveProperty('result');
      expect(body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('fluxmail');
      if (method === 'server/discover') expect(body.result.capabilities.tools.listChanged).toBe(false);
    }
    const subscription = await request('subscriptions/listen', {});
    expect(await subscription.json()).toHaveProperty('error');
    const mismatch = await request('tools/list', {}, '2025-03-26');
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toHaveProperty('error');
  });
});
