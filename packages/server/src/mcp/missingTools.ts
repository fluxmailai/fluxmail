import { CancelledNotificationSchema } from '@modelcontextprotocol/core';
import type { RequestId, Transport } from '@modelcontextprotocol/server';

/** Why a `tools/call` names a tool that isn't registered, as Fluxmail Cloud reports it. */
export type MissingToolReason = 'permission_denied' | 'unknown_tool';

const INVALID_PARAMS = -32602;

/**
 * The SDK answers a call to an unregistered tool with the same error whether the connection's
 * permissions leave the tool out or this server has no such tool. This adds the reason to that
 * error's data. Install after the SDK's callbacks, before the transport starts.
 */
export function explainMissingTools(
  transport: Transport,
  reasonFor: (name: string) => MissingToolReason | undefined,
): void {
  const pending = new Map<RequestId, { name: string; reason: MissingToolReason }>();
  const onmessage = transport.onmessage;
  const onclose = transport.onclose;
  const send = transport.send.bind(transport);
  transport.onmessage = (message, extra) => {
    if ('method' in message && message.method === 'tools/call' && 'id' in message && message.id !== undefined) {
      const name = (message.params as { name?: unknown } | undefined)?.name;
      const reason = typeof name === 'string' ? reasonFor(name) : undefined;
      if (reason) pending.set(message.id, { name: name as string, reason });
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
  transport.send = (message, options) => {
    // The server's own requests number their IDs separately from the client's.
    if ('method' in message || !('id' in message) || message.id === undefined) return send(message, options);
    const missing = pending.get(message.id);
    pending.delete(message.id);
    // Only the SDK's missing-tool error gets the reason. It rejects a malformed call first, with
    // another message, and that error may carry data of its own.
    if (
      missing === undefined ||
      !('error' in message) ||
      message.error.code !== INVALID_PARAMS ||
      message.error.data !== undefined ||
      message.error.message !== `Tool ${missing.name} not found`
    ) {
      return send(message, options);
    }
    return send({ ...message, error: { ...message.error, data: { reason: missing.reason } } }, options);
  };
}
