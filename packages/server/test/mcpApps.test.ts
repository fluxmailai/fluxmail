import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, ClientCapabilities, Tool } from '@modelcontextprotocol/server';
import type { EmailProvider, Message } from '@fluxmail/core';
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
  SEND_CONFIRMATION_HTML,
  SEND_CONFIRMATION_RESOURCE_URI,
  SEND_CONFIRMATION_RESULT_META_KEY,
  type SendConfirmationData,
} from '@fluxmail/core/mcp';
import { GMAIL_CAPABILITIES } from '@fluxmail/provider-gmail';
import { buildMcpServer } from '../src/mcp/buildServer.js';
import { createApp } from '../src/http/app.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService, type SendPreview } from '../src/service/emailService.js';
import { accounts, openDb } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { ALL_MAIL_PERMISSION_POLICY, permissionPolicyForProfile } from '../src/permissions.js';
import type { FluxmailConfig } from '../src/config.js';

const contract: Tool[] = JSON.parse(readFileSync(new URL('./fixtures/mcp-contract.json', import.meta.url), 'utf8'));
const UI_CAPABILITIES: ClientCapabilities = {
  extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] } },
};
const TOOL_META = {
  ui: { resourceUri: SEND_CONFIRMATION_RESOURCE_URI },
  'ui/resourceUri': SEND_CONFIRMATION_RESOURCE_URI,
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const preview: SendPreview = {
  accountId: 'acct_1',
  from: 'me@example.com',
  to: [{ email: 'ann@example.com', name: 'Ann' }],
  cc: [],
  bcc: [{ email: 'hidden@example.com' }],
  subject: 'Quarterly report',
  attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }],
  bodyTextChars: 5,
  bodyHtmlChars: 12,
};

/** The result preview_send returned before MCP Apps support. */
function resultBefore(data: SendPreview): CallToolResult {
  return {
    structuredContent: { data },
    content: [{ type: 'text', text: JSON.stringify({ data }, null, 2) }],
  };
}

async function connectInMemory(service: Partial<EmailService>, capabilities?: ClientCapabilities) {
  const server = buildMcpServer(service as EmailService, { permissions: ALL_MAIL_PERMISSION_POLICY });
  const client = new Client({ name: 'claude-code', version: '2.0.0' }, capabilities ? { capabilities } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
}

/** The card data on a preview_send result, failing the test when it is missing. */
function cardOf(result: CallToolResult): SendConfirmationData {
  const card = result._meta?.[SEND_CONFIRMATION_RESULT_META_KEY] as SendConfirmationData | undefined;
  if (!card) throw new Error('preview_send result has no send confirmation data');
  return card;
}

let keys = 0;
function mockedService() {
  return {
    enforceQuota: () => undefined,
    previewSendWithBody: vi.fn(async () => ({ preview, body: { text: 'Hello', html: '<p>Hello</p>' } })),
    sendConfirmationKey: vi.fn(() => `fxui1.key-${++keys}`),
  } satisfies Partial<EmailService>;
}

describe('MCP Apps send confirmation for clients without the extension', () => {
  it('lists, previews and reads exactly as before', async () => {
    const service = mockedService();
    const client = await connectInMemory(service);
    expect((await client.listTools()).tools).toEqual(contract);
    expect((await client.listResources()).resources).toEqual([]);
    const result = await client.callTool({ name: 'preview_send', arguments: { to: ['ann@example.com'] } });
    expect(result).toEqual(resultBefore(preview));
    expect(JSON.stringify(result)).not.toContain('Hello');
  });

  it('declares no extension when a client lists other extensions', async () => {
    const client = await connectInMemory(mockedService(), {
      extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ['text/uri-list'] }, 'example.com/other': {} },
    });
    expect((await client.listTools()).tools.find((tool) => tool.name === 'preview_send')?._meta).toBeUndefined();
    expect(await client.callTool({ name: 'preview_send', arguments: {} })).toEqual(resultBefore(preview));
  });
});

describe('MCP Apps send confirmation for clients with the extension', () => {
  it('links preview_send to the card and lists and serves the card', async () => {
    const client = await connectInMemory(mockedService(), UI_CAPABILITIES);
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === 'preview_send')?._meta).toEqual(TOOL_META);
    // Only preview_send carries UI metadata; the rest of the contract is unchanged.
    expect(tools.map(({ _meta: _ignored, ...tool }) => tool)).toEqual(contract);
    expect(tools.filter((tool) => tool._meta)).toHaveLength(1);

    expect((await client.listResources()).resources).toEqual([
      {
        uri: SEND_CONFIRMATION_RESOURCE_URI,
        name: 'send_confirmation',
        title: 'Email preview',
        description: expect.any(String),
        mimeType: MCP_APPS_MIME_TYPE,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            prefersBorder: true,
          },
        },
      },
    ]);
    const { contents } = await client.readResource({ uri: SEND_CONFIRMATION_RESOURCE_URI });
    expect(contents).toEqual([
      {
        uri: SEND_CONFIRMATION_RESOURCE_URI,
        mimeType: MCP_APPS_MIME_TYPE,
        text: SEND_CONFIRMATION_HTML,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            prefersBorder: true,
          },
        },
      },
    ]);
  });

  it('adds the body and a fresh idempotency key in _meta without changing content', async () => {
    const service = mockedService();
    const client = await connectInMemory(service, UI_CAPABILITIES);
    const first = (await client.callTool({ name: 'preview_send', arguments: {} })) as CallToolResult;
    const second = (await client.callTool({ name: 'preview_send', arguments: {} })) as CallToolResult;
    const { _meta, ...rest } = first;
    expect(rest).toEqual(resultBefore(preview));
    const card = _meta?.[SEND_CONFIRMATION_RESULT_META_KEY] as SendConfirmationData;
    expect(card).toEqual({
      version: 1,
      idempotencyKey: expect.stringMatching(/^fxui1\.key-\d+$/),
      body: { text: 'Hello', html: '<p>Hello</p>' },
    });
    const secondCard = cardOf(second);
    expect(secondCard.idempotencyKey).not.toBe(card.idempotencyKey);
  });

  it('leaves error results unchanged', async () => {
    const service = mockedService();
    service.previewSendWithBody.mockRejectedValueOnce(new Error('boom'));
    const client = await connectInMemory(service, UI_CAPABILITIES);
    const result = (await client.callTool({ name: 'preview_send', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
  });

  it('offers no card to a connection that cannot send', async () => {
    const server = buildMcpServer(mockedService() as unknown as EmailService, {
      permissions: permissionPolicyForProfile('read-only'),
    });
    const client = new Client({ name: 'host', version: '1' }, { capabilities: UI_CAPABILITIES });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.some((tool) => tool._meta)).toBe(false);
    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri: SEND_CONFIRMATION_RESOURCE_URI })).rejects.toThrow();
  });
});

const original: Message = {
  id: 'm1',
  threadId: 't1',
  accountId: 'acct_test',
  from: { email: 'ann@example.com', name: 'Ann' },
  to: [{ email: 'owner@example.com' }],
  subject: 'Lunch',
  date: '2026-10-25T00:00:00Z',
  body: { text: 'Are you free on Friday?' },
  attachments: [],
  flags: { read: true, starred: false, draft: false },
};

function setupHttp() {
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 1024,
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
    getMessage: vi.fn(async () => original),
    listSendAs: vi.fn(async () => [{ email: 'owner@example.com', isPrimary: true }]),
    send: vi.fn(async () => ({ id: 'sent_1', threadId: 't1' })),
  };
  vi.spyOn(registry, 'getProvider').mockReturnValue(provider as unknown as EmailProvider);
  const service = new EmailService(registry, db);
  const app = createApp({ config, db, registry, service, telemetry: { capture: vi.fn(), shutdown: async () => {} } });
  const full = createApiKey(db, 'full', owner.id, ALL_MAIL_PERMISSION_POLICY).key;
  const read = createApiKey(db, 'read', owner.id, permissionPolicyForProfile('read-only')).key;
  return { app, provider, full, read };
}

async function connectHttp(
  app: ReturnType<typeof createApp>,
  key: string,
  era: 'legacy' | 'modern',
  capabilities?: ClientCapabilities,
) {
  const client = new Client(
    { name: 'host', version: '1.0.0' },
    {
      versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
      ...(capabilities ? { capabilities } : {}),
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

describe('MCP Apps send confirmation over HTTP', () => {
  it('follows capabilities on modern requests', async () => {
    const { app, full } = setupHttp();
    const plain = await connectHttp(app, full, 'modern');
    expect((await plain.listTools()).tools.some((tool) => tool._meta)).toBe(false);
    expect((await plain.listResources()).resources).toEqual([]);
    const plainResult = (await plain.callTool({
      name: 'preview_send',
      arguments: { to: ['ann@example.com'], subject: 'Hi', bodyText: 'Hello' },
    })) as CallToolResult;
    expect(plainResult._meta?.[SEND_CONFIRMATION_RESULT_META_KEY]).toBeUndefined();

    const host = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    expect((await host.listTools()).tools.find((tool) => tool.name === 'preview_send')?._meta).toEqual(TOOL_META);
    const hostResult = (await host.callTool({
      name: 'preview_send',
      arguments: { to: ['ann@example.com'], subject: 'Hi', bodyText: 'Hello' },
    })) as CallToolResult;
    const { [SEND_CONFIRMATION_RESULT_META_KEY]: card, ...otherMeta } = hostResult._meta ?? {};
    expect({ ...hostResult, _meta: otherMeta }).toEqual(plainResult);
    expect((card as SendConfirmationData).body).toEqual({ text: 'Hello' });
  });

  it('offers the card to older stateless clients, whose capabilities are unknown', async () => {
    const { app, full } = setupHttp();
    const client = await connectHttp(app, full, 'legacy');
    expect((await client.listTools()).tools.find((tool) => tool.name === 'preview_send')?._meta).toEqual(TOOL_META);
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([
      SEND_CONFIRMATION_RESOURCE_URI,
    ]);
  });

  it('shows the reply body with the quoted original, as it will be sent', async () => {
    const { app, full } = setupHttp();
    const client = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    const result = (await client.callTool({
      name: 'preview_send',
      arguments: { replyToMessageId: 'm1', bodyText: 'Yes, Friday works.' },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    const card = cardOf(result);
    expect(card.body.text).toContain('Yes, Friday works.');
    expect(card.body.text).toContain('Are you free on Friday?');
    expect(result.structuredContent).toMatchObject({
      data: { subject: 'Re: Lunch', to: [{ email: 'ann@example.com' }] },
    });
  });

  it('sends once when the card sends the previewed arguments twice with its key', async () => {
    const { app, full, provider } = setupHttp();
    const client = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    const args = { to: ['ann@example.com'], subject: 'Hi', bodyText: 'Hello', cc: null, bcc: null };
    const preview = (await client.callTool({ name: 'preview_send', arguments: args })) as CallToolResult;
    const card = cardOf(preview);
    const accountId = (preview.structuredContent as { data: SendPreview }).data.accountId;
    // The card sends the tool input with the resolved account and its key.
    const send = { ...args, accountId, idempotencyKey: card.idempotencyKey };
    const [first, second] = await Promise.all([
      client.callTool({ name: 'send_email', arguments: send }),
      client.callTool({ name: 'send_email', arguments: send }),
    ]);
    const retry = await client.callTool({ name: 'send_email', arguments: send });
    expect(provider.send).toHaveBeenCalledOnce();
    const operations = [first, second, retry].map(
      (result) => (result.structuredContent as { data: { operationId: string } }).data.operationId,
    );
    expect(new Set(operations).size).toBe(1);
    expect((retry.structuredContent as { data: { status: string } }).data.status).toBe('succeeded');
  });

  it('applies send scopes to calls from the card', async () => {
    const { app, read, provider } = setupHttp();
    const client = await connectHttp(app, read, 'modern', UI_CAPABILITIES);
    expect((await client.listTools()).tools.some((tool) => tool.name === 'preview_send')).toBe(false);
    await expect(
      client.callTool({
        name: 'send_email',
        arguments: { to: ['ann@example.com'], bodyText: 'Hello', idempotencyKey: 'ui-key' },
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('refuses a card send after another email left the mailbox, and after the message changed', async () => {
    const { app, full, provider } = setupHttp();
    const client = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    const args = { to: ['ann@example.com'], subject: 'Hi', bodyText: 'Hello' };
    const preview = (await client.callTool({ name: 'preview_send', arguments: args })) as CallToolResult;
    const card = cardOf(preview);
    expect(card.idempotencyKey).toMatch(/^fxui1\./);
    // The model sends the same email itself after the user says yes in chat.
    const own = await client.callTool({ name: 'send_email', arguments: { ...args, idempotencyKey: 'model-key' } });
    expect(own.isError).not.toBe(true);
    // Then the user clicks Send on the card.
    const fromCard = await client.callTool({
      name: 'send_email',
      arguments: { ...args, idempotencyKey: card.idempotencyKey },
    });
    expect(fromCard.isError).toBe(true);
    expect(JSON.stringify(fromCard.content)).toContain('Another email was sent from this mailbox after this preview');
    expect(provider.send).toHaveBeenCalledOnce();

    // A reply previewed against one original no longer matches once the original changes.
    const reply = (await client.callTool({
      name: 'preview_send',
      arguments: { replyToMessageId: 'm1', bodyText: 'Yes.' },
    })) as CallToolResult;
    const replyKey = cardOf(reply).idempotencyKey;
    provider.getMessage.mockResolvedValue({ ...original, body: { text: 'Actually, are you free on Monday?' } });
    const changed = await client.callTool({
      name: 'send_email',
      arguments: { replyToMessageId: 'm1', bodyText: 'Yes.', idempotencyKey: replyKey },
    });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed.content)).toContain('The email changed after this preview');
    expect(provider.send).toHaveBeenCalledOnce();
  });

  it('rejects card keys this server did not sign', async () => {
    const { app, full, provider } = setupHttp();
    const client = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    const preview = (await client.callTool({
      name: 'preview_send',
      arguments: { to: ['ann@example.com'], bodyText: 'Hello' },
    })) as CallToolResult;
    const key = cardOf(preview).idempotencyKey;
    const forged = key.slice(0, -2) + (key.endsWith('AA') ? 'BB' : 'AA');
    const result = await client.callTool({
      name: 'send_email',
      arguments: { to: ['ann@example.com'], bodyText: 'Hello', idempotencyKey: forged },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('This email preview has expired');
    expect(provider.send).not.toHaveBeenCalled();
  });
});
