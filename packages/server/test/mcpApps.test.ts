import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, ClientCapabilities, Tool } from '@modelcontextprotocol/server';
import type { EmailProvider, Message } from '@fluxmail/core';
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
  MAX_BODY_CHARS,
  MESSAGE_READER_HTML,
  MESSAGE_READER_RESOURCE_URI,
  MESSAGE_READER_RESULT_META_KEY,
  selectBody,
  SEND_CONFIRMATION_HTML,
  SEND_CONFIRMATION_RESOURCE_URI,
  SEND_CONFIRMATION_RESULT_META_KEY,
  type MessageReaderData,
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

async function connectInMemory(
  service: Partial<EmailService>,
  capabilities?: ClientCapabilities,
  capture?: ReturnType<typeof vi.fn>,
) {
  const server = buildMcpServer(service as EmailService, {
    permissions: ALL_MAIL_PERMISSION_POLICY,
    ...(capture ? { telemetry: { capture, shutdown: async () => {} } } : {}),
  });
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
    // Only the card tools carry UI metadata; the rest of the contract is unchanged.
    expect(tools.map(({ _meta: _ignored, ...tool }) => tool)).toEqual(contract);
    expect(tools.filter((tool) => tool._meta).map((tool) => tool.name)).toEqual(['get_email', 'preview_send']);

    expect((await client.listResources()).resources).toContainEqual({
      uri: SEND_CONFIRMATION_RESOURCE_URI,
      name: 'send_confirmation',
      title: 'Send email',
      description: expect.any(String),
      mimeType: MCP_APPS_MIME_TYPE,
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
          prefersBorder: true,
        },
      },
    });
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
    expect((await client.listTools()).tools.find((tool) => tool.name === 'preview_send')).toBeUndefined();
    expect((await client.listResources()).resources.map((resource) => resource.uri)).not.toContain(
      SEND_CONFIRMATION_RESOURCE_URI,
    );
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
  const capture = vi.fn();
  const app = createApp({ config, db, registry, service, telemetry: { capture, shutdown: async () => {} } });
  const full = createApiKey(db, 'full', owner.id, ALL_MAIL_PERMISSION_POLICY).key;
  const read = createApiKey(db, 'read', owner.id, permissionPolicyForProfile('read-only')).key;
  return { app, provider, full, read, capture };
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
      MESSAGE_READER_RESOURCE_URI,
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

  it('gives the card inline images the HTML references', async () => {
    const { app, full } = setupHttp();
    const client = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    const logo = Buffer.from('logo').toString('base64');
    const result = (await client.callTool({
      name: 'preview_send',
      arguments: {
        to: ['ann@example.com'],
        bodyHtml: '<p>Hi</p><img src="cid:logo@x">',
        attachments: [
          { filename: 'logo.png', mimeType: 'image/png', content: logo, contentId: 'logo@x', disposition: 'inline' },
        ],
      },
    })) as CallToolResult;
    expect(cardOf(result).body.inlineImages).toEqual({ 'logo@x': `data:image/png;base64,${logo}` });
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
    const scheduled = await client.callTool({
      name: 'send_email',
      arguments: { to: ['ann@example.com'], bodyText: 'Hello', idempotencyKey: forged, sendAt: '2099-01-01T09:00:00Z' },
    });
    expect(scheduled.isError).toBe(true);
    expect(JSON.stringify(scheduled.content)).toContain('This email preview has expired');
    expect(provider.send).not.toHaveBeenCalled();
  });
});

/** The operation events captured for one operation. */
function operationEvents(capture: ReturnType<typeof vi.fn>, operation: string): Array<Record<string, unknown>> {
  return capture.mock.calls
    .filter(([event, properties]) => event === 'operation completed' && properties.operation === operation)
    .map(([, properties]) => properties as Record<string, unknown>);
}

describe('MCP Apps send confirmation telemetry', () => {
  it('records whether preview_send offered the card and when a host loads it', async () => {
    const capture = vi.fn();
    const plain = await connectInMemory(mockedService(), undefined, capture);
    await plain.callTool({ name: 'preview_send', arguments: { to: ['ann@example.com'] } });
    const host = await connectInMemory(mockedService(), UI_CAPABILITIES, capture);
    await host.callTool({ name: 'preview_send', arguments: { to: ['ann@example.com'] } });
    expect(operationEvents(capture, 'preview_send').map((event) => event.app_offered)).toEqual([false, true]);

    await host.readResource({ uri: SEND_CONFIRMATION_RESOURCE_URI });
    expect(operationEvents(capture, 'send_confirmation_card')).toEqual([
      expect.objectContaining({
        product_surface: 'mcp',
        outcome: 'success',
        mcp_client_name: 'claude-code',
        mcp_client_version: '2.0.0',
      }),
    ]);
  });

  it('records sends from the card without the key or mail content', async () => {
    const { app, full, capture } = setupHttp();
    const client = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    const args = { to: ['private@example.com'], subject: 'Private subject', bodyText: 'Private body' };
    const preview = (await client.callTool({ name: 'preview_send', arguments: args })) as CallToolResult;
    const key = cardOf(preview).idempotencyKey;
    const fromCard = await client.callTool({ name: 'send_email', arguments: { ...args, idempotencyKey: key } });
    expect(fromCard.isError).not.toBe(true);
    const fromModel = await client.callTool({
      name: 'send_email',
      arguments: { to: ['other@example.com'], bodyText: 'Hi', idempotencyKey: 'model-key' },
    });
    expect(fromModel.isError).not.toBe(true);
    expect(operationEvents(capture, 'preview_send').map((event) => event.app_offered)).toEqual([true]);
    expect(operationEvents(capture, 'send_email').map(({ outcome, via_app }) => ({ outcome, via_app }))).toEqual([
      { outcome: 'success', via_app: true },
      { outcome: 'success', via_app: false },
    ]);
    const captured = JSON.stringify(capture.mock.calls);
    for (const value of [
      key,
      'model-key',
      'private@example.com',
      'Private subject',
      'Private body',
      'other@example.com',
    ])
      expect(captured).not.toContain(value);
  });

  it('records no app_offered for failed previews and keeps via_app on refused card sends', async () => {
    const capture = vi.fn();
    const service = mockedService();
    service.previewSendWithBody.mockRejectedValueOnce(new Error('private failure'));
    const client = await connectInMemory(service, UI_CAPABILITIES, capture);
    await client.callTool({ name: 'preview_send', arguments: { to: ['private@example.com'] } });
    await client.callTool({ name: 'preview_send', arguments: { unknown: 'private value' } });
    const failed = operationEvents(capture, 'preview_send');
    expect(failed.map((event) => event.outcome)).toEqual(['error', 'error']);
    for (const event of failed) expect(event).not.toHaveProperty('app_offered');

    const { app, full, capture: httpCapture, provider } = setupHttp();
    const http = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    const forged = 'fxui1.0.forged.forged';
    const refused = await http.callTool({
      name: 'send_email',
      arguments: { to: ['private@example.com'], bodyText: 'Private body', idempotencyKey: forged },
    });
    expect(refused.isError).toBe(true);
    expect(provider.send).not.toHaveBeenCalled();
    expect(operationEvents(httpCapture, 'send_email')).toEqual([
      expect.objectContaining({ outcome: 'error', error_code: 'invalid_request', via_app: true }),
    ]);
    const captured = JSON.stringify([...capture.mock.calls, ...httpCapture.mock.calls]);
    for (const value of [forged, 'private@example.com', 'Private body', 'private value', 'private failure'])
      expect(captured).not.toContain(value);
  });
});

const READER_TOOL_META = {
  ui: { resourceUri: MESSAGE_READER_RESOURCE_URI },
  'ui/resourceUri': MESSAGE_READER_RESOURCE_URI,
};
const LOGO = Buffer.from('private logo bytes');
const received: Message = {
  id: 'm2',
  threadId: 't2',
  accountId: 'acct_1',
  from: { email: 'news@example.com', name: 'Private Sender' },
  to: [{ email: 'me@example.com' }],
  subject: 'Private newsletter',
  date: '2026-11-01T09:30:00Z',
  body: {
    text: 'Private plain body',
    html: '<p>Private formatted body</p><img src="cid:logo@x">' + '<p>more</p>'.repeat(10_000),
  },
  attachments: [
    { id: 'att_logo', filename: 'logo.png', mimeType: 'image/png', sizeBytes: LOGO.length, contentId: 'logo@x' },
    { id: 'att_unused', filename: 'unused.png', mimeType: 'image/png', sizeBytes: 10, contentId: 'unused@x' },
    { id: 'att_pdf', filename: 'terms.pdf', mimeType: 'application/pdf', sizeBytes: 4096 },
  ],
  flags: { read: false, starred: false, draft: false },
};

function readerService(message: Message = received) {
  return {
    enforceQuota: () => undefined,
    getMessage: vi.fn(async () => message),
    getAttachment: vi.fn(async () => ({
      meta: { id: 'att_logo', filename: 'logo.png', mimeType: 'image/png', sizeBytes: LOGO.length },
      content: LOGO,
    })),
  } satisfies Partial<EmailService>;
}

function readerOf(result: CallToolResult): MessageReaderData {
  const card = result._meta?.[MESSAGE_READER_RESULT_META_KEY] as MessageReaderData | undefined;
  if (!card) throw new Error('get_email result has no message reader data');
  return card;
}

describe('MCP Apps message reader for clients without the extension', () => {
  for (const [name, capabilities] of [
    ['no capabilities (Claude Code, Codex)', undefined],
    ['capabilities without MCP Apps', { extensions: { 'example.com/other': {} } }],
  ] as const) {
    it(`returns get_email exactly as before with ${name}`, async () => {
      const service = readerService();
      const client = await connectInMemory(service, capabilities);
      const tools = (await client.listTools()).tools;
      expect(tools.find((tool) => tool.name === 'get_email')?._meta).toBeUndefined();
      expect((await client.listResources()).resources).toEqual([]);
      for (const bodyFormat of [undefined, 'text', 'html', 'none'] as const) {
        const args = { messageId: 'm2', ...(bodyFormat ? { bodyFormat } : {}) };
        const result = await client.callTool({ name: 'get_email', arguments: args });
        const data = selectBody(received, bodyFormat ?? 'both', MAX_BODY_CHARS);
        expect(result).toEqual({
          structuredContent: { data },
          content: [{ type: 'text', text: JSON.stringify({ data }, null, 2) }],
        });
      }
      expect(service.getAttachment).not.toHaveBeenCalled();
    });
  }
});

describe('MCP Apps message reader for clients with the extension', () => {
  it('links get_email to the reader and lists and serves it', async () => {
    const client = await connectInMemory(readerService(), UI_CAPABILITIES);
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === 'get_email')?._meta).toEqual(READER_TOOL_META);
    for (const name of ['get_email_body', 'get_thread', 'list_emails'])
      expect(tools.find((tool) => tool.name === name)?._meta).toBeUndefined();
    expect((await client.listResources()).resources).toContainEqual({
      uri: MESSAGE_READER_RESOURCE_URI,
      name: 'message_reader',
      title: 'Email',
      description: expect.any(String),
      mimeType: MCP_APPS_MIME_TYPE,
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
          prefersBorder: true,
        },
      },
    });
    const { contents } = await client.readResource({ uri: MESSAGE_READER_RESOURCE_URI });
    expect(contents).toEqual([
      {
        uri: MESSAGE_READER_RESOURCE_URI,
        mimeType: MCP_APPS_MIME_TYPE,
        text: MESSAGE_READER_HTML,
        _meta: expect.objectContaining({ ui: expect.objectContaining({ prefersBorder: true }) }),
      },
    ]);
  });

  it('adds only the body parts the model result cut or left out, without changing content', async () => {
    const service = readerService();
    const client = await connectInMemory(service, UI_CAPABILITIES);
    const result = (await client.callTool({ name: 'get_email', arguments: { messageId: 'm2' } })) as CallToolResult;
    const { _meta, ...rest } = result;
    const data = selectBody(received, 'both', MAX_BODY_CHARS);
    expect(rest).toEqual({
      structuredContent: { data },
      content: [{ type: 'text', text: JSON.stringify({ data }, null, 2) }],
    });
    // The text came back whole; the HTML was cut for the model, so the card gets it in full.
    expect(readerOf(result)).toEqual({
      version: 1,
      body: {
        html: received.body!.html,
        inlineImages: { 'logo@x': `data:image/png;base64,${LOGO.toString('base64')}` },
      },
    });
    expect(service.getAttachment).toHaveBeenCalledOnce();
    expect(service.getAttachment).toHaveBeenCalledWith('acct_1', 'm2', 'att_logo', expect.any(Number));

    const none = (await client.callTool({
      name: 'get_email',
      arguments: { messageId: 'm2', bodyFormat: 'none' },
    })) as CallToolResult;
    expect(none.structuredContent).toEqual({ data: { ...received, body: undefined } });
    expect(readerOf(none).body).toMatchObject({ text: 'Private plain body', html: received.body!.html });
  });

  it('repeats nothing for a short message the result carries in full', async () => {
    const short: Message = { ...received, body: { text: 'Hi', html: '<p>Hi</p>' }, attachments: [] };
    const service = readerService(short);
    const client = await connectInMemory(service, UI_CAPABILITIES);
    const result = (await client.callTool({ name: 'get_email', arguments: { messageId: 'm2' } })) as CallToolResult;
    expect(readerOf(result)).toEqual({ version: 1, body: {} });
    expect(service.getAttachment).not.toHaveBeenCalled();
  });

  it('shows an inline image that fails to load as a placeholder', async () => {
    const service = readerService();
    service.getAttachment.mockRejectedValueOnce(new Error('provider down'));
    const client = await connectInMemory(service, UI_CAPABILITIES);
    const result = (await client.callTool({ name: 'get_email', arguments: { messageId: 'm2' } })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(readerOf(result).body.inlineImages).toBeUndefined();
  });

  it('leaves error results unchanged', async () => {
    const service = readerService();
    service.getMessage.mockRejectedValueOnce(new Error('boom'));
    const client = await connectInMemory(service, UI_CAPABILITIES);
    const result = (await client.callTool({ name: 'get_email', arguments: { messageId: 'm2' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
  });

  it('offers the reader to a read-only connection, and no send card', async () => {
    const server = buildMcpServer(readerService() as unknown as EmailService, {
      permissions: permissionPolicyForProfile('read-only'),
    });
    const client = new Client({ name: 'host', version: '1' }, { capabilities: UI_CAPABILITIES });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.filter((tool) => tool._meta).map((tool) => tool.name)).toEqual([
      'get_email',
    ]);
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([
      MESSAGE_READER_RESOURCE_URI,
    ]);
  });

  it('offers no reader to a connection that cannot read mail', async () => {
    const server = buildMcpServer(readerService() as unknown as EmailService, {
      permissions: { profile: 'custom', capabilities: ['mail.send'], supplementalCapabilities: [] },
    });
    const client = new Client({ name: 'host', version: '1' }, { capabilities: UI_CAPABILITIES });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.some((tool) => tool.name === 'get_email')).toBe(false);
    expect((await client.listResources()).resources.map((resource) => resource.uri)).not.toContain(
      MESSAGE_READER_RESOURCE_URI,
    );
    await expect(client.readResource({ uri: MESSAGE_READER_RESOURCE_URI })).rejects.toThrow();
  });
});

describe('MCP Apps message reader over HTTP', () => {
  it('follows capabilities on modern requests and skips inline images when capabilities are unknown', async () => {
    const { app, full, provider } = setupHttp();
    const withImage: Message = {
      ...original,
      body: { text: 'Hi', html: '<p>Hi</p><img src="cid:logo@x">' },
      attachments: [{ id: 'a1', filename: 'logo.png', mimeType: 'image/png', sizeBytes: 4, contentId: 'logo@x' }],
    };
    provider.getMessage.mockResolvedValue(withImage);
    Object.assign(provider, {
      getAttachment: vi.fn(async () => ({
        meta: { id: 'a1', filename: 'logo.png', mimeType: 'image/png', sizeBytes: 4 },
        content: Buffer.from('logo'),
      })),
    });
    const plain = await connectHttp(app, full, 'modern');
    const plainResult = (await plain.callTool({ name: 'get_email', arguments: { messageId: 'm1' } })) as CallToolResult;
    expect(plainResult._meta?.[MESSAGE_READER_RESULT_META_KEY]).toBeUndefined();

    const host = await connectHttp(app, full, 'modern', UI_CAPABILITIES);
    expect((await host.listTools()).tools.find((tool) => tool.name === 'get_email')?._meta).toEqual(READER_TOOL_META);
    const hostResult = (await host.callTool({ name: 'get_email', arguments: { messageId: 'm1' } })) as CallToolResult;
    const { [MESSAGE_READER_RESULT_META_KEY]: card, ...otherMeta } = hostResult._meta ?? {};
    expect({ ...hostResult, _meta: otherMeta }).toEqual(plainResult);
    expect((card as MessageReaderData).body.inlineImages).toEqual({
      'logo@x': `data:image/png;base64,${Buffer.from('logo').toString('base64')}`,
    });

    const legacy = await connectHttp(app, full, 'legacy');
    expect((await legacy.listTools()).tools.find((tool) => tool.name === 'get_email')?._meta).toEqual(READER_TOOL_META);
    const legacyResult = (await legacy.callTool({
      name: 'get_email',
      arguments: { messageId: 'm1' },
    })) as CallToolResult;
    expect(readerOf(legacyResult)).toEqual({ version: 1, body: {} });
    expect((provider as unknown as { getAttachment: ReturnType<typeof vi.fn> }).getAttachment).toHaveBeenCalledOnce();
  });
});

describe('MCP Apps message reader telemetry', () => {
  it('records whether get_email offered the reader and when a host loads it, without mail data', async () => {
    const capture = vi.fn();
    const plain = await connectInMemory(readerService(), undefined, capture);
    await plain.callTool({ name: 'get_email', arguments: { messageId: 'm2' } });
    const host = await connectInMemory(readerService(), UI_CAPABILITIES, capture);
    await host.callTool({ name: 'get_email', arguments: { messageId: 'm2' } });
    const failing = readerService();
    failing.getMessage.mockRejectedValueOnce(new Error('private failure'));
    const failed = await connectInMemory(failing, UI_CAPABILITIES, capture);
    await failed.callTool({ name: 'get_email', arguments: { messageId: 'm2' } });
    const events = operationEvents(capture, 'get_email');
    expect(events.map((event) => [event.outcome, event.app_offered])).toEqual([
      ['success', false],
      ['success', true],
      ['error', undefined],
    ]);

    await host.readResource({ uri: MESSAGE_READER_RESOURCE_URI });
    expect(operationEvents(capture, 'message_reader_card')).toEqual([
      expect.objectContaining({
        product_surface: 'mcp',
        outcome: 'success',
        mcp_client_name: 'claude-code',
        mcp_client_version: '2.0.0',
      }),
    ]);
    const captured = JSON.stringify(capture.mock.calls);
    for (const value of [
      'm2',
      'acct_1',
      'news@example.com',
      'Private Sender',
      'Private newsletter',
      'Private plain body',
      'Private formatted body',
      'logo.png',
      'private failure',
      LOGO.toString('base64'),
    ])
      expect(captured).not.toContain(value);
  });
});
