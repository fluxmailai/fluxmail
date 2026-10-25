import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, createMcpHandler } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from '../src/mcp/buildServer.js';
import { classifyMcpClient, mcpClientProperties, mcpClients } from '../src/mcp/clientTelemetry.js';
import type { EmailService } from '../src/service/emailService.js';
import {
  createTelemetry,
  installTelemetryStreamEndHandler,
  setTelemetryEnabled,
  type Telemetry,
} from '../src/telemetry.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function analytics(env: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fluxmail-mcp-client-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const capture = vi.fn();
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const telemetry = createTelemetry({ dataDir, env, client: { capture, shutdown } });
  cleanups.push(() => telemetry.shutdown());
  const connections = () =>
    capture.mock.calls.map(([event]) => event).filter((event) => event.event === 'mcp client connected');
  return { dataDir, capture, shutdown, telemetry, connections };
}

function server(telemetry: Telemetry, transport: 'stdio' | 'http') {
  return buildMcpServer(
    {
      enforceQuota: () => undefined,
      listLabels: async () => [{ id: 'private-label-id', name: 'private-label-name' }],
    } as Partial<EmailService> as EmailService,
    { telemetry, transport },
  );
}

async function harness(kind: 'stdio' | 'http', telemetry: Telemetry) {
  if (kind === 'http') {
    // Match the application's stateless HTTP lifecycle: a server per request.
    const handler = createMcpHandler(() => server(telemetry, kind));
    cleanups.push(() => handler.close());
    const http = createServer(toNodeHandler(handler));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () => new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve()))),
    );
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    return {
      request: async (message: JSONRPCMessage) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version':
              'params' in message && message.params?._meta?.['io.modelcontextprotocol/protocolVersion']
                ? '2026-07-28'
                : '2025-06-18',
            ...('method' in message ? { 'mcp-method': message.method } : {}),
            ...('params' in message && typeof message.params?.name === 'string'
              ? { 'mcp-name': message.params.name }
              : {}),
            'user-agent': 'private-user-agent@example.com',
          },
          body: JSON.stringify(message),
        });
        if (response.status === 202) return undefined;
        if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
          const data = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
          return JSON.parse(data!.slice(6));
        }
        return response.json();
      },
    };
  }

  const input = new PassThrough();
  const output = new PassThrough();
  const responses = new Map<string | number, (message: JSONRPCMessage) => void>();
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as JSONRPCMessage;
      buffer = buffer.slice(newline + 1);
      if ('id' in message) {
        responses.get(message.id)?.(message);
        responses.delete(message.id);
      }
    }
  });
  const mcp = serveStdio(() => server(telemetry, kind), { transport: new StdioServerTransport(input, output) });
  installTelemetryStreamEndHandler(input, () => telemetry.shutdown());
  cleanups.push(() => mcp.close());
  return {
    input,
    request: async (message: JSONRPCMessage) => {
      const response =
        'id' in message
          ? new Promise<JSONRPCMessage>((resolve) => responses.set(message.id, resolve))
          : Promise.resolve(undefined);
      input.write(`${JSON.stringify(message)}\n`);
      const result = await response;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return result;
    },
  };
}

function initialize(name: string, id: string | number = 'private-request-id'): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: { experimental: { privateCapability: {} } },
      clientInfo: { name, version: ' 1.2.3 ', title: 'Private Client Title' },
    },
  };
}

describe('MCP client classifier', () => {
  it.each([
    ['claude', 'claude'],
    ['claude-ai', 'claude'],
    ['claude_desktop', 'claude_desktop'],
    ['claude_code', 'claude_code'],
    ['codex', 'codex'],
    ['codex_mcp_client', 'codex'],
    ['cursor', 'cursor'],
    ['cursor_vscode', 'cursor'],
    ['chatgpt', 'chatgpt'],
    ['openai_mcp', 'chatgpt'],
    ['vscode', 'vscode'],
    ['visual_studio_code', 'vscode'],
    ['windsurf', 'windsurf'],
    ['cline', 'cline'],
    ['roo_code', 'roo_code'],
    ['goose', 'goose'],
    ['zed', 'zed'],
    ['muse', 'muse'],
    ['  CLAUDE -_ Code  ', 'claude_code'],
    ['Visual Studio Code', 'vscode'],
  ])('classifies %s as %s', (name, expected) => expect(classifyMcpClient(name)).toBe(expected));

  it.each([undefined, null, false, 42, {}, [], '', ' \t\n'])('classifies missing or empty %j as unknown', (name) => {
    expect(classifyMcpClient(name)).toBe('unknown');
  });

  it.each([
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'cursor-private@example.com',
    'my-claude-code',
    'claude.ai',
    'codex/custom',
    'x'.repeat(129),
    `${' '.repeat(124)}codex`,
    'other',
    'unknown',
  ])('keeps unrecognized %s in other', (name) => expect(classifyMcpClient(name)).toBe('other'));

  it('sends the trimmed client name and version with its category, within the length limits', () => {
    expect(mcpClientProperties({ name: '  Claude Code ', version: ' 1.0.0 ' }, '2026-07-28')).toEqual({
      mcp_client: 'claude_code',
      mcp_client_name: 'Claude Code',
      mcp_client_version: '1.0.0',
      mcp_protocol_version: '2026-07-28',
    });
    expect(mcpClientProperties({ name: 'codex', version: 'v'.repeat(64) })).toEqual({
      mcp_client: 'codex',
      mcp_client_name: 'codex',
      mcp_client_version: 'v'.repeat(64),
    });
    expect(mcpClientProperties({ name: 'codex', version: 'v'.repeat(65) })).toEqual({
      mcp_client: 'codex',
      mcp_client_name: 'codex',
    });
    for (const version of [undefined, 42, '', 'latest', '2026-7-28', '2026-07-28; private'])
      expect(mcpClientProperties({ name: 'codex' }, version)).toEqual({
        mcp_client: 'codex',
        mcp_client_name: 'codex',
      });
    expect(mcpClientProperties({ name: 'x'.repeat(128) })).toEqual({
      mcp_client: 'other',
      mcp_client_name: 'x'.repeat(128),
    });
    expect(mcpClientProperties({ name: 'x'.repeat(129) })).toEqual({ mcp_client: 'other' });
    for (const info of [undefined, null, 'codex', {}, { name: 42 }, { name: ' \t' }])
      expect(mcpClientProperties(info)).toEqual({ mcp_client: 'unknown' });
  });

  it('accepts normalized aliases up to the exact length limit', () => {
    expect(classifyMcpClient(`${' '.repeat(123)}codex`)).toBe('codex');
    expect(new Set(mcpClients).size).toBe(15);
  });
});

describe.each(['stdio', 'http'] as const)('%s initialization telemetry', (kind) => {
  it.each([
    ['Codex-MCP-Client', 'codex'],
    ['private@example.com custom client', 'other'],
    ['', 'unknown'],
  ])('records one safe event for %j', async (name, category) => {
    const { telemetry, capture, connections, dataDir } = analytics();
    const client = await harness(kind, telemetry);
    expect(await client.request(initialize(name))).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
    await client.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await client.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await client.request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_labels', arguments: { accountId: 'private-account-id' } },
    });
    await telemetry.shutdown();
    expect(connections()).toHaveLength(1);
    expect(connections()[0]).toMatchObject({
      distinctId: expect.stringMatching(/^[a-f0-9]{32}$/),
      disableGeoip: true,
      properties: {
        product_surface: 'mcp',
        operation: 'initialize',
        outcome: 'success',
        transport: kind,
        mcp_client: category,
        ...(name ? { mcp_client_name: name } : {}),
        mcp_client_version: '1.2.3',
        mcp_protocol_version: '2025-06-18',
        deployment_type: 'self_hosted',
        $process_person_profile: false,
      },
    });
    expect(Object.keys(connections()[0].properties).sort()).toEqual(
      [
        'product_surface',
        'operation',
        'outcome',
        'transport',
        'mcp_client',
        ...(name ? ['mcp_client_name'] : []),
        'mcp_client_version',
        'mcp_protocol_version',
        'deployment_type',
        '$process_person_profile',
        'fluxmail_version',
        'node_version',
        'platform',
        'arch',
      ].sort(),
    );
    expect(capture.mock.calls.map(([event]) => event.event)).toEqual(['mcp client connected', 'operation completed']);
    const serialized = JSON.stringify(capture.mock.calls);
    for (const value of [
      'Private Client Title',
      'privateCapability',
      'private-request-id',
      'private-user-agent',
      'private-account-id',
      'private-label',
      dataDir,
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('does not count malformed initialization or unsolicited initialized notifications', async () => {
    const { telemetry, connections } = analytics();
    const client = await harness(kind, telemetry);
    await client.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // A ping provides a barrier for stdio's notification handler.
    await client.request({ jsonrpc: '2.0', id: 1, method: 'ping' });
    for (const params of [
      undefined,
      {},
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex' } },
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 123, version: 'private' } },
    ]) {
      expect(
        await client.request({ jsonrpc: '2.0', id: 2, method: 'initialize', ...(params ? { params } : {}) }),
      ).toHaveProperty('error');
    }
    await client.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await client.request({ jsonrpc: '2.0', id: 3, method: 'ping' });
    expect(connections()).toHaveLength(0);
    await client.request(initialize('cursor'));
    expect(connections()).toHaveLength(1);
  });

  it('counts each successful initialization and reconnection with the same installation ID', async () => {
    const { telemetry, connections } = analytics();
    const client = await harness(kind, telemetry);
    await client.request(initialize('claude-ai', 1));
    await client.request(initialize('claude-code', 1));
    await client.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await client.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await client.request({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const reconnected = await harness(kind, telemetry);
    await reconnected.request(initialize('claude-desktop'));
    expect(connections().map((event) => event.properties.mcp_client)).toEqual([
      'claude',
      'claude_code',
      'claude_desktop',
    ]);
    expect(new Set(connections().map((event) => event.distinctId)).size).toBe(1);
  });

  it.each(['setting', 'environment', 'do_not_track'] as const)('respects telemetry opt-out via %s', async (source) => {
    const { telemetry, capture, dataDir } = analytics(
      source === 'environment' ? { FLUXMAIL_TELEMETRY: '0' } : source === 'do_not_track' ? { DO_NOT_TRACK: '1' } : {},
    );
    if (source === 'setting') setTelemetryEnabled(dataDir, false);
    const client = await harness(kind, telemetry);
    expect(await client.request(initialize('codex'))).toHaveProperty('result');
    expect(capture).not.toHaveBeenCalled();
  });
});

it('flushes initialize telemetry when stdio ends', async () => {
  const { telemetry, connections, shutdown } = analytics();
  const client = await harness('stdio', telemetry);
  client.input!.end(`${JSON.stringify(initialize('codex'))}\n`);
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  expect(connections()).toHaveLength(1);
});

it('does not count a canceled initialize or failed response delivery', async () => {
  const { telemetry, connections } = analytics();
  const mcp = server(telemetry, 'stdio');
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const send = vi.fn().mockRejectedValue(new Error('private transport failure'));
  transport.send = send;
  mcp.server.onerror = () => {};
  await mcp.connect(transport);
  cleanups.push(() => mcp.close());
  await client.send(initialize('codex', 1));
  await client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(send).not.toHaveBeenCalled();
  await client.send(initialize('cursor', 2));
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(connections()).toHaveLength(0);
});

it('does not count a valid request rejected by the SDK handler', async () => {
  const { telemetry, connections } = analytics();
  const mcp = server(telemetry, 'stdio');
  mcp.server.setRequestHandler('initialize', () => {
    throw new Error('private initialization rejection');
  });
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const response = vi.fn();
  client.onmessage = response;
  await mcp.connect(transport);
  cleanups.push(() => mcp.close());
  await client.send(initialize('codex'));
  await vi.waitFor(() => expect(response).toHaveBeenCalledOnce());
  expect(response.mock.calls[0][0]).toHaveProperty('error');
  expect(connections()).toHaveLength(0);
});

it('keeps shutdown open until an in-flight initialize response is sent and captured', async () => {
  const { telemetry, connections, shutdown } = analytics();
  const mcp = server(telemetry, 'stdio');
  const [client, transport] = InMemoryTransport.createLinkedPair();
  let finishSend!: () => void;
  const delivery = new Promise<void>((resolve) => {
    finishSend = resolve;
  });
  const send = vi.fn(() => delivery);
  transport.send = send;
  await mcp.connect(transport);
  cleanups.push(() => mcp.close());
  await client.send(initialize('codex'));
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  const closing = telemetry.shutdown();
  expect(shutdown).not.toHaveBeenCalled();
  expect(connections()).toHaveLength(0);
  finishSend();
  await closing;
  expect(connections()).toHaveLength(1);
  expect(shutdown).toHaveBeenCalledOnce();
});

it('preserves initialization when an injected analytics client throws', async () => {
  const capture = vi.fn(() => {
    throw new Error('private analytics failure');
  });
  const client = await harness('stdio', { capture, shutdown: async () => {} });
  expect(await client.request(initialize('codex'))).toHaveProperty('result');
  expect(capture).toHaveBeenCalledOnce();
  expect(await client.request({ jsonrpc: '2.0', id: 2, method: 'ping' })).toHaveProperty('result');
});

describe.each(['http', 'stdio'] as const)('%s discovery telemetry', (kind) => {
  const envelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  it('allows tool calls as the first modern request without recording a connection', async () => {
    const { telemetry, connections } = analytics();
    const transport = await harness(kind, telemetry);
    const result = await transport.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_labels', arguments: {}, _meta: envelope },
    });
    expect(result).toHaveProperty('result.structuredContent.data');
    expect(connections()).toHaveLength(0);
  });

  it('allows a modern discovery probe followed by legacy initialization', async () => {
    const { telemetry, connections } = analytics();
    const transport = await harness(kind, telemetry);
    expect(
      await transport.request({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope } }),
    ).toHaveProperty('result');
    expect(await transport.request(initialize('codex', 2))).toHaveProperty('result.protocolVersion');
    await transport.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(
      await transport.request({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_labels', arguments: {} },
      }),
    ).toHaveProperty('result.structuredContent.data');
    expect(connections().map((event) => event.properties.operation)).toEqual(['server/discover', 'initialize']);
  });

  it('records successful discovery with only the classified per-request identity', async () => {
    const { telemetry, capture, connections } = analytics();
    const transport = await harness(kind, telemetry);
    const result = await transport.request({
      jsonrpc: '2.0',
      id: 'private-id',
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'codex', version: '0.9.0', title: 'private-title' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
    expect(result).toHaveProperty('result');
    await vi.waitFor(() => expect(connections()).toHaveLength(1));
    expect(connections()[0].properties).toMatchObject({
      operation: 'server/discover',
      mcp_client: 'codex',
      mcp_client_name: 'codex',
      mcp_client_version: '0.9.0',
      mcp_protocol_version: '2026-07-28',
      transport: kind,
    });
    expect(capture.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        event: 'operation completed',
        properties: expect.objectContaining({
          operation: 'server/discover',
          outcome: 'success',
          duration_ms: expect.any(Number),
          mcp_client: 'codex',
          mcp_client_version: '0.9.0',
          mcp_protocol_version: '2026-07-28',
        }),
      }),
    );
    const events = JSON.stringify(capture.mock.calls);
    for (const privateValue of ['private-id', 'private-title']) expect(events).not.toContain(privateValue);
  });

  it('records a rejected legacy discovery without a connection event or private input', async () => {
    const { telemetry, capture, connections } = analytics();
    const transport = await harness(kind, telemetry);
    await transport.request(initialize('codex'));
    const result = await transport.request({
      jsonrpc: '2.0',
      id: 'private-failure-id',
      method: 'server/discover',
      params: { privateInput: 'private-content' },
    });
    expect(result).toHaveProperty('error');
    await vi.waitFor(() =>
      expect(capture.mock.calls.map(([event]) => event)).toContainEqual(
        expect.objectContaining({
          event: 'operation completed',
          properties: expect.objectContaining({
            operation: 'server/discover',
            outcome: 'error',
            error_code: 'invalid_request',
            duration_ms: expect.any(Number),
          }),
        }),
      ),
    );
    expect(connections()).toHaveLength(1);
    const events = JSON.stringify(capture.mock.calls);
    expect(events).not.toContain('private-failure-id');
    expect(events).not.toContain('private-content');
  });

  it('attributes modern tool success and error events to the per-request client', async () => {
    const { telemetry, capture } = analytics();
    const transport = await harness(kind, telemetry);
    const meta = {
      ...envelope,
      'io.modelcontextprotocol/clientInfo': { name: 'Cursor', version: '2.1.0', title: 'private-title' },
    };
    expect(
      await transport.request({
        jsonrpc: '2.0',
        id: 'private-success-id',
        method: 'tools/call',
        params: { name: 'list_labels', arguments: { accountId: 'private-account-id' }, _meta: meta },
      }),
    ).toHaveProperty('result.structuredContent.data');
    // The stub service has no listAccounts, so this call fails inside the tool.
    expect(
      await transport.request({
        jsonrpc: '2.0',
        id: 'private-error-id',
        method: 'tools/call',
        params: { name: 'list_accounts', arguments: {}, _meta: meta },
      }),
    ).toHaveProperty('result.isError', true);
    const operations = () =>
      capture.mock.calls.map(([event]) => event).filter((event) => event.event === 'operation completed');
    await vi.waitFor(() => expect(operations()).toHaveLength(2));
    expect(operations().map((event) => event.properties)).toEqual([
      expect.objectContaining({
        operation: 'list_labels',
        outcome: 'success',
        transport: kind,
        mcp_client: 'cursor',
        mcp_client_name: 'Cursor',
        mcp_client_version: '2.1.0',
        mcp_protocol_version: '2026-07-28',
      }),
      expect.objectContaining({
        operation: 'list_accounts',
        outcome: 'error',
        error_code: 'internal',
        transport: kind,
        mcp_client: 'cursor',
        mcp_client_name: 'Cursor',
        mcp_client_version: '2.1.0',
        mcp_protocol_version: '2026-07-28',
      }),
    ]);
    const events = JSON.stringify(capture.mock.calls);
    for (const privateValue of [
      'private-title',
      'private-success-id',
      'private-error-id',
      'private-account-id',
      'private-label',
    ])
      expect(events).not.toContain(privateValue);
  });
});

describe('legacy tool client attribution', () => {
  const listLabels = (id: number): JSONRPCMessage => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'list_labels', arguments: {} },
  });
  const toolClient = (capture: ReturnType<typeof vi.fn>) =>
    capture.mock.calls
      .map(([event]) => event)
      .find((event) => event.event === 'operation completed' && event.properties.operation === 'list_labels')
      ?.properties;

  it('uses the initialized client for later stdio tool calls', async () => {
    const { telemetry, capture } = analytics();
    const transport = await harness('stdio', telemetry);
    await transport.request(initialize('Claude Code'));
    await transport.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await transport.request(listLabels(2));
    expect(toolClient(capture)).toMatchObject({
      mcp_client: 'claude_code',
      mcp_client_name: 'Claude Code',
      mcp_client_version: '1.2.3',
      mcp_protocol_version: '2025-06-18',
    });
  });

  it('reports only the protocol header for stateless HTTP tool calls, which carry no client identity', async () => {
    const { telemetry, capture } = analytics();
    const transport = await harness('http', telemetry);
    await transport.request(initialize('Claude Code'));
    await transport.request(listLabels(2));
    const properties = toolClient(capture);
    expect(properties).toMatchObject({ mcp_client: 'unknown', mcp_protocol_version: '2025-06-18' });
    expect(properties).not.toHaveProperty('mcp_client_name');
    expect(properties).not.toHaveProperty('mcp_client_version');
  });
});
