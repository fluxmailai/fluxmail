import { randomBytes } from 'node:crypto';
import { safeAttachmentFilename } from './attachments.js';

const MIME_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/;
// 57 bytes encode to one 76-character base64 line.
const LINE_BYTES = 57;

/** A file to add to a saved message, read once from a stream. */
export interface AddedAttachment {
  filename: string;
  mimeType: string;
  content: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
}

interface RawHeader {
  name: string;
  value: string;
  raw: string;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).indexOf(needle, from);
}

function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).lastIndexOf(needle);
}

function headerBlock(raw: Uint8Array): { headers: RawHeader[]; eol: string; bodyStart: number } {
  const crlf = indexOfBytes(raw, Buffer.from('\r\n\r\n'));
  const lf = indexOfBytes(raw, Buffer.from('\n\n'));
  // A message without a blank line is all headers.
  const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
  const end = useCrlf ? crlf : lf;
  const eol = useCrlf || (end === -1 && indexOfBytes(raw, Buffer.from('\r\n')) !== -1) ? '\r\n' : '\n';
  const text = Buffer.from(raw.subarray(0, end === -1 ? raw.byteLength : end)).toString('latin1');
  const headers: RawHeader[] = [];
  for (const line of text.split(eol)) {
    const previous = headers.at(-1);
    if (/^[ \t]/.test(line) && previous) {
      previous.raw += eol + line;
      previous.value += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim(), raw: line });
  }
  return { headers, eol, bodyStart: end === -1 ? raw.byteLength : end + eol.length * 2 };
}

function boundaryOf(contentType: string): string | undefined {
  const match = /;\s*boundary\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+))/i.exec(contentType);
  const value = match?.[1]?.replace(/\\(.)/g, '$1') ?? match?.[2];
  return value || undefined;
}

function asciiFilename(filename: string): string {
  return safeAttachmentFilename(filename).replace(/[^\x20-\x7e]/g, '_');
}

function partHeaders(attachment: AddedAttachment, eol: string): string {
  const filename = safeAttachmentFilename(attachment.filename);
  const fallback = asciiFilename(filename);
  const ascii = fallback === filename;
  const mimeType = MIME_TYPE_PATTERN.test(attachment.mimeType) ? attachment.mimeType : 'application/octet-stream';
  // Mail apps read the RFC 2047 name on Content-Type and the RFC 2231 filename on Content-Disposition.
  const name = ascii ? fallback : `=?UTF-8?B?${Buffer.from(filename).toString('base64')}?=`;
  const disposition = ascii
    ? `filename="${fallback}"`
    : `filename="${fallback}";${eol} filename*=UTF-8''${encodeURIComponent(filename).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      )}`;
  return [
    `Content-Type: ${mimeType};${eol} name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment;${eol} ${disposition}`,
  ].join(eol);
}

async function* base64Lines(content: AddedAttachment['content'], eol: string): AsyncGenerator<Uint8Array> {
  let pending: Buffer = Buffer.alloc(0);
  let first = true;
  const emit = (bytes: Buffer) => {
    const lines: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += LINE_BYTES)
      lines.push(bytes.subarray(offset, offset + LINE_BYTES).toString('base64'));
    const text = (first ? '' : eol) + lines.join(eol);
    first = false;
    return Buffer.from(text, 'latin1');
  };
  for await (const chunk of content as AsyncIterable<Uint8Array>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    const whole = pending.length - (pending.length % LINE_BYTES);
    if (!whole) continue;
    yield emit(pending.subarray(0, whole));
    pending = pending.subarray(whole);
  }
  if (pending.length) yield emit(pending);
}

/**
 * A saved message with one more attachment, written as it is read. A multipart/mixed message gets the part before
 * its closing boundary, so its headers and other parts stay byte for byte. Any other message becomes the first part
 * of a new multipart/mixed message that keeps its top-level headers. The attachment is base64 encoded from the
 * stream, so the file is never held whole.
 */
export async function* messageWithAttachment(raw: Uint8Array, attachment: AddedAttachment): AsyncGenerator<Uint8Array> {
  const { headers, eol, bodyStart } = headerBlock(raw);
  const contentType = headers.find((header) => header.name === 'content-type')?.value ?? '';
  const boundary = /^multipart\/mixed\b/i.test(contentType) ? boundaryOf(contentType) : undefined;
  const closing = boundary ? lastIndexOfBytes(raw, Buffer.from(`${eol}--${boundary}--`)) : -1;
  if (boundary && closing >= bodyStart - eol.length) {
    yield raw.subarray(0, closing);
    yield Buffer.from(`${eol}--${boundary}${eol}${partHeaders(attachment, eol)}${eol}${eol}`, 'latin1');
    yield* base64Lines(attachment.content, eol);
    yield raw.subarray(closing);
    return;
  }
  const outer = `----=_Fluxmail_${randomBytes(12).toString('hex')}`;
  const content = headers.filter((header) => header.name.startsWith('content-'));
  const kept = headers.filter((header) => !header.name.startsWith('content-') && header.name !== 'mime-version');
  const top = [
    ...kept.map((header) => header.raw),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
  ].join(eol);
  const inner = content.length
    ? content.map((header) => header.raw).join(eol)
    : 'Content-Type: text/plain; charset=us-ascii';
  yield Buffer.from(`${top}${eol}${eol}--${outer}${eol}${inner}${eol}${eol}`, 'latin1');
  yield raw.subarray(Math.min(bodyStart, raw.byteLength));
  yield Buffer.from(`${eol}--${outer}${eol}${partHeaders(attachment, eol)}${eol}${eol}`, 'latin1');
  yield* base64Lines(attachment.content, eol);
  yield Buffer.from(`${eol}--${outer}--${eol}`, 'latin1');
}
