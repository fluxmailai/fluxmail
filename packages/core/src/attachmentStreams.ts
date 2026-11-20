import { EmailError } from './errors.js';

/** The error an adapter raises for an attachment larger than the caller's limit. */
export function attachmentTooLargeError(sizeBytes: number, maxBytes: number): EmailError {
  return new EmailError('invalid_request', 'Attachment is too large to return through MCP.', { sizeBytes, maxBytes });
}

/** Rejects an attachment the metadata already shows is over the limit. */
export function assertAttachmentWithinLimit(sizeBytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && sizeBytes > maxBytes) throw attachmentTooLargeError(sizeBytes, maxBytes);
}

/** A stream of one buffer, for content an adapter already holds. */
export function bufferStream(content: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.close();
      sent = true;
      if (content.byteLength) controller.enqueue(content);
      controller.close();
    },
  });
}

/**
 * Passes the stream through, failing it with the adapter's size error once it yields more than maxBytes.
 * Without a limit it returns the stream unchanged.
 */
export function limitAttachmentStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number | undefined,
): ReadableStream<Uint8Array> {
  if (maxBytes === undefined) return stream;
  let sizeBytes = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maxBytes) throw attachmentTooLargeError(sizeBytes, maxBytes);
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Passes the stream through and fails it unless it yields exactly byteLength bytes, so a reader that was promised
 * that length sees a truncated or failed body instead of different content. The chunk that reaches byteLength is
 * held until the stream ends, so content longer than stated never delivers every promised byte before it fails.
 */
export function exactLengthStream(stream: ReadableStream<Uint8Array>, byteLength: number): ReadableStream<Uint8Array> {
  let sizeBytes = 0;
  let last: Uint8Array | undefined;
  const mismatch = () =>
    new EmailError('provider_unavailable', 'The attachment content did not match its reported size.', undefined, {
      phase: 'fetch',
      reason: 'invalid_response',
    });
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength === 0) return;
        sizeBytes += chunk.byteLength;
        if (sizeBytes > byteLength) throw mismatch();
        if (sizeBytes === byteLength) last = chunk;
        else controller.enqueue(chunk);
      },
      flush(controller) {
        if (sizeBytes !== byteLength) throw mismatch();
        if (last) controller.enqueue(last);
      },
    }),
  );
}

/** Reads a whole stream into one buffer, failing with the adapter's size error past maxBytes. */
export async function readAttachmentStream(stream: ReadableStream<Uint8Array>, maxBytes?: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sizeBytes += value.byteLength;
      if (maxBytes !== undefined && sizeBytes > maxBytes) throw attachmentTooLargeError(sizeBytes, maxBytes);
      chunks.push(value);
    }
    return Buffer.concat(chunks, sizeBytes);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** The error an adapter raises when a file it adds to a draft isn't the size the caller stated. */
export function uploadSizeMismatchError(): EmailError {
  return new EmailError('invalid_request', 'The attachment is not the size its upload stated.');
}

/** Passes an uploaded file through and fails it unless it is exactly the stated number of bytes. */
export function statedLengthStream(stream: ReadableStream<Uint8Array>, byteLength: number): ReadableStream<Uint8Array> {
  let sizeBytes = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > byteLength) throw uploadSizeMismatchError();
        controller.enqueue(chunk);
      },
      flush() {
        if (sizeBytes !== byteLength) throw uploadSizeMismatchError();
      },
    }),
  );
}
