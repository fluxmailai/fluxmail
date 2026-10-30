import { CancelledNotificationSchema, InitializeResultSchema, DiscoverResultSchema } from '@modelcontextprotocol/core';
import { isInitializeRequest, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import type { Transport, RequestId } from '@modelcontextprotocol/server';
import { mcpClientProperties } from '@fluxmail/core/mcp';
import { captureOperation, type Telemetry } from '../telemetry.js';

export { classifyMcpClient, mcpClientProperties, mcpClients } from '@fluxmail/core/mcp';
export type { McpClient, McpClientProperties } from '@fluxmail/core/mcp';

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
