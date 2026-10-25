import { CancelledNotificationSchema, InitializeResultSchema, DiscoverResultSchema } from '@modelcontextprotocol/core';
import { isInitializeRequest, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import type { Transport, RequestId } from '@modelcontextprotocol/server';
import { captureOperation, type Telemetry } from '../telemetry.js';

export const mcpClients = [
  'claude',
  'claude_desktop',
  'claude_code',
  'codex',
  'cursor',
  'chatgpt',
  'vscode',
  'windsurf',
  'cline',
  'roo_code',
  'goose',
  'zed',
  'muse',
  'other',
  'unknown',
] as const;
export type McpClient = (typeof mcpClients)[number];

const aliases: ReadonlyMap<string, McpClient> = new Map([
  ['claude', 'claude'],
  ['claude_ai', 'claude'],
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
]);

// Client names are untrusted. Classify them into fixed labels for stable grouping.
export function classifyMcpClient(name: unknown): McpClient {
  if (typeof name !== 'string' || !name.trim()) return 'unknown';
  if (name.length > 128) return 'other';
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, '_');
  return aliases.get(normalized) ?? 'other';
}

export interface McpClientProperties {
  mcp_client: McpClient;
  /** The self-reported name, trimmed. Omitted when blank or longer than 128 characters. */
  mcp_client_name?: string;
  /** The self-reported version, trimmed. Omitted when blank or longer than 64 characters. */
  mcp_client_version?: string;
  /** A dated MCP revision such as `2026-07-28`. Omitted when absent or malformed. */
  mcp_protocol_version?: string;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

/** Describe an untrusted `clientInfo` object and protocol version from a request. */
export function mcpClientProperties(info: unknown, protocolVersion?: unknown): McpClientProperties {
  const client: { name?: unknown; version?: unknown } = info && typeof info === 'object' ? info : {};
  const name = boundedText(client.name, 128);
  const version = boundedText(client.version, 64);
  return {
    mcp_client: classifyMcpClient(client.name),
    ...(name ? { mcp_client_name: name } : {}),
    ...(version ? { mcp_client_version: version } : {}),
    ...(typeof protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(protocolVersion)
      ? { mcp_protocol_version: protocolVersion }
      : {}),
  };
}

/** Install after the SDK's callbacks, before the transport starts. */
export function trackMcpInitialization(transport: Transport, telemetry: Telemetry, kind: 'stdio' | 'http'): void {
  const pending = new Map<
    RequestId,
    { info: unknown; protocolVersion?: unknown; operation: 'initialize' | 'server/discover'; started: number }
  >();
  const onmessage = transport.onmessage;
  const onclose = transport.onclose;
  const send = transport.send.bind(transport);
  transport.onmessage = (message, extra) => {
    if (isInitializeRequest(message) && 'id' in message && message.id !== undefined) {
      pending.set(message.id, {
        info: message.params.clientInfo,
        operation: 'initialize',
        started: performance.now(),
      });
    } else if ('method' in message && message.method === 'server/discover' && 'id' in message) {
      pending.set(message.id, {
        info: message.params?._meta?.[CLIENT_INFO_META_KEY],
        protocolVersion: message.params?._meta?.[PROTOCOL_VERSION_META_KEY],
        operation: 'server/discover',
        started: performance.now(),
      });
    } else {
      const canceled = CancelledNotificationSchema.safeParse(message);
      if (canceled.success && canceled.data.params.requestId !== undefined) {
        pending.delete(canceled.data.params.requestId);
      }
    }
    onmessage?.(message, extra);
  };
  transport.onclose = () => {
    pending.clear();
    onclose?.();
  };
  transport.send = async (message, options) => {
    if (!('id' in message) || message.id === undefined) return send(message, options);
    const entry = pending.get(message.id);
    if (entry === undefined) return send(message, options);
    pending.delete(message.id);
    // Only the SDK's successful handshake or discovery result can produce the event. Keep
    // its request validation, cancellation and error-response behavior intact.
    const schema = entry.operation === 'initialize' ? InitializeResultSchema : DiscoverResultSchema;
    const success = 'result' in message && schema.safeParse(message.result).success;
    // Legacy initialization reports the negotiated version in its result.
    const client = mcpClientProperties(
      entry.info,
      success && entry.operation === 'initialize' ? message.result.protocolVersion : entry.protocolVersion,
    );
    const finishActivity = telemetry.beginActivity?.();
    try {
      await send(message, options);
      if (entry.operation === 'server/discover') {
        captureOperation(telemetry, {
          productSurface: 'mcp',
          operation: entry.operation,
          outcome: success ? 'success' : 'error',
          durationMs: performance.now() - entry.started,
          transport: kind,
          ...(!success ? { errorCode: 'invalid_request' } : {}),
          properties: { ...client },
        });
      }
      if (success) {
        try {
          telemetry.capture('mcp client connected', {
            product_surface: 'mcp',
            operation: entry.operation,
            outcome: 'success',
            transport: kind,
            ...client,
          });
        } catch {
          // Analytics must not affect the protocol response.
        }
      }
    } finally {
      finishActivity?.();
    }
  };
}
