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
  const pending = new Map<RequestId, MissingToolReason>();
  const onmessage = transport.onmessage;
  const onclose = transport.onclose;
  const send = transport.send.bind(transport);
  transport.onmessage = (message, extra) => {
    if ('method' in message && message.method === 'tools/call' && 'id' in message && message.id !== undefined) {
      const name = (message.params as { name?: unknown } | undefined)?.name;
      const reason = typeof name === 'string' ? reasonFor(name) : undefined;
      if (reason) pending.set(message.id, reason);
    }
    onmessage?.(message, extra);
  };
  transport.onclose = () => {
    pending.clear();
    onclose?.();
  };
  transport.send = (message, options) => {
    if (!('id' in message) || message.id === undefined) return send(message, options);
    const reason = pending.get(message.id);
    pending.delete(message.id);
    if (reason === undefined || !('error' in message) || message.error.code !== INVALID_PARAMS) {
      return send(message, options);
    }
    const data = { ...(message.error.data as object | undefined), reason };
    return send({ ...message, error: { ...message.error, data } }, options);
  };
}
