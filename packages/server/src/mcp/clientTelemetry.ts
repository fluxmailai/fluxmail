import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CancelledNotificationSchema,
  InitializeResultSchema,
  isInitializeRequest,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { Telemetry } from '../telemetry.js';

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

// Client names are untrusted and may contain personal data. Export fixed labels only.
export function classifyMcpClient(name: unknown): McpClient {
  if (typeof name !== 'string' || !name.trim()) return 'unknown';
  if (name.length > 128) return 'other';
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, '_');
  return aliases.get(normalized) ?? 'other';
}

/** Install after the SDK's callbacks, before the transport starts. */
export function trackMcpInitialization(transport: Transport, telemetry: Telemetry, kind: 'stdio' | 'http'): void {
  const pending = new Map<RequestId, McpClient>();
  const onmessage = transport.onmessage;
  const onclose = transport.onclose;
  const send = transport.send.bind(transport);
  transport.onmessage = (message, extra) => {
    if (isInitializeRequest(message) && 'id' in message && message.id !== undefined) {
      pending.set(message.id, classifyMcpClient(message.params.clientInfo.name));
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
    const client = pending.get(message.id);
    if (client === undefined) return send(message, options);
    pending.delete(message.id);
    // Only the SDK's successful initialize result can produce the event. Keep
    // its request validation, cancellation and error-response behavior intact.
    const success = 'result' in message && InitializeResultSchema.safeParse(message.result).success;
    const finishActivity = success ? telemetry.beginActivity?.() : undefined;
    try {
      await send(message, options);
      if (success) {
        try {
          telemetry.capture('mcp client connected', {
            product_surface: 'mcp',
            operation: 'initialize',
            outcome: 'success',
            transport: kind,
            mcp_client: client,
          });
        } catch {
          // An injected analytics client must not affect the initialize response.
        }
      }
    } finally {
      finishActivity?.();
    }
  };
}
