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
    // Only preview_send carries UI metadata; the rest of the contract is unchanged.
    expect(tools.map(({ _meta: _ignored, ...tool }) => tool)).toEqual(contract);
    expect(tools.filter((tool) => tool._meta)).toHaveLength(1);

    expect((await client.listResources()).resources).toEqual([
      {
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
