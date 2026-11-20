import { attachmentTooLargeError, invalidResponseError } from '@fluxmail/core';

// Gmail's JSON around attachment data or a raw message is small: a few IDs, labels and a snippet.
const ENVELOPE_LIMIT = 64 * 1024;
const PIECE = 64 * 1024;

/** A base64url string field of a Gmail JSON response, decoded as it arrives. */
export interface StreamedField {
  /** The JSON before the field, which may carry metadata such as an attachment's size. */
  prefix: string;
  /** The decoded bytes. It fails if the response is malformed or `check` rejects the whole envelope. */
  content: ReadableStream<Uint8Array>;
}

/**
 * Decodes one base64url field of a JSON response without holding the encoded text. Once the response ends, `check`
 * receives the parsed JSON, with the field set to an empty string, and the number of decoded bytes; it throws to fail
 * the stream. Past maxBytes the stream fails with the adapter's attachment size error.
 */
export async function openStreamedField(
  body: ReadableStream<Uint8Array>,
  field: string,
  check: (envelope: Record<string, unknown>, sizeBytes: number) => void,
  maxBytes?: number,
): Promise<StreamedField> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const opening = new RegExp(`"${field}"\\s*:\\s*"`);
  let envelope = '';
  let text = '';
  const fail = async (message: string): Promise<never> => {
    await reader.cancel().catch(() => undefined);
    throw invalidResponseError(message);
  };
  for (;;) {
    const chunk = await reader.read().catch(async (error: unknown) => {
      await reader.cancel().catch(() => undefined);
      throw error;
    });
    if (chunk.done) return fail('Gmail returned incomplete data.');
    envelope += decoder.decode(chunk.value, { stream: true });
    const match = opening.exec(envelope);
    if (match) {
      text = envelope.slice(match.index + match[0].length);
      envelope = envelope.slice(0, match.index);
      break;
    }
    if (envelope.length > ENVELOPE_LIMIT) return fail('Gmail returned an oversized response envelope.');
  }
  const prefix = envelope;
  let suffix = '';
  let encoded = '';
  let ended = false;
  let sizeBytes = 0;
  // Decodes complete base64 groups and keeps the rest for the next piece.
  const decode = (value: string, final: boolean): Buffer | undefined => {
    encoded += value;
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) throw invalidResponseError('Gmail returned invalid base64url data.');
    const count = final ? encoded.length : Math.floor(encoded.length / 4) * 4;
    if (!count) return undefined;
    const input = encoded.slice(0, count);
    if (!final && input.includes('=')) throw invalidResponseError('Gmail returned early base64 padding.');
    if (final && input.includes('=') && input.length % 4 !== 0)
      throw invalidResponseError('Gmail returned invalid base64 padding.');
    const output = Buffer.from(input, 'base64url');
    if (final && output.toString('base64url') !== input.replace(/=+$/, ''))
      throw invalidResponseError('Gmail returned invalid base64 padding.');
    encoded = encoded.slice(count);
    sizeBytes += output.length;
    if (maxBytes !== undefined && sizeBytes > maxBytes) throw attachmentTooLargeError(sizeBytes, maxBytes);
    return output.length ? output : undefined;
  };
  // The bytes decoded from one piece of text. After the closing quote, the rest is kept as JSON.
  const consume = (value: string): Buffer[] => {
    const out: Buffer[] = [];
    for (let offset = 0; offset < value.length; offset += PIECE) {
      let piece = value.slice(offset, offset + PIECE);
      if (!ended) {
        const end = piece.indexOf('"');
        if (end < 0) {
          // Padding belongs to the final group, even when it arrives separately.
          const padding = piece.indexOf('=');
          const decoded = decode(padding < 0 ? piece : piece.slice(0, padding), false);
          if (decoded) out.push(decoded);
          if (padding >= 0) {
            encoded += piece.slice(padding);
            if (encoded.length > 4 || !/^[A-Za-z0-9_-]*={1,2}$/.test(encoded))
              throw invalidResponseError('Gmail returned invalid base64 padding.');
          }
          continue;
        }
        const decoded = decode(piece.slice(0, end), true);
        if (decoded) out.push(decoded);
        ended = true;
        piece = piece.slice(end);
      }
      suffix += piece;
      if (suffix.length > ENVELOPE_LIMIT) throw invalidResponseError('Gmail returned an oversized response envelope.');
    }
    return out;
  };
  let pending: string | undefined = text;
  const content = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          let value: string;
          if (pending !== undefined) {
            value = pending;
            pending = undefined;
          } else {
            const chunk = await reader.read();
            if (chunk.done) {
              suffix += decoder.decode();
              if (!ended || encoded) throw invalidResponseError('Gmail returned incomplete data.');
              let parsed: unknown;
              try {
                parsed = JSON.parse(`${prefix}"${field}":"${suffix}`);
              } catch {
                throw invalidResponseError('Gmail returned malformed JSON.');
              }
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                throw invalidResponseError('Gmail returned malformed JSON.');
              check(parsed as Record<string, unknown>, sizeBytes);
              reader.releaseLock();
              controller.close();
              return;
            }
            value = decoder.decode(chunk.value, { stream: true });
          }
          const out = consume(value);
          if (out.length) {
            for (const piece of out) controller.enqueue(piece);
            return;
          }
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return { prefix, content };
}
