import { randomBytes } from 'node:crypto';
import { encodeContentDispositionFilename, safeAttachmentFilename, safeMimeType } from './attachments.js';

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

// RFC 2047 encoded words of at most 68 characters, 42 bytes of UTF-8 split between characters, so a folded line stays short.
function encodedWords(value: string): string[] {
  const words: string[] = [];
  let bytes: number[] = [];
  for (const character of value) {
    const encoded = [...Buffer.from(character)];
    if (bytes.length + encoded.length > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(bytes).toString('base64')}?=`);
      bytes = [];
    }
    bytes.push(...encoded);
  }
  if (bytes.length) words.push(`=?UTF-8?B?${Buffer.from(bytes).toString('base64')}?=`);
  return words;
}

// An RFC 2231 filename* value split into continuations of at most 60 characters, never inside a %XX escape.
function filenameContinuations(filename: string): string[] {
  const encoded = `UTF-8''${encodeContentDispositionFilename(filename)}`;
  const pieces: string[] = [];
  for (let at = 0; at < encoded.length;) {
    let end = Math.min(at + 60, encoded.length);
    const escape = encoded.lastIndexOf('%', end - 1);
    if (escape > end - 3 && escape >= at && end < encoded.length) end = escape;
    pieces.push(encoded.slice(at, end));
    at = end;
  }
  return pieces.map((piece, index) => `filename*${index}*=${piece}`);
}

function shortened(filename: string, length: number): string {
  if (filename.length <= length) return filename;
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(filename)?.[0] ?? '';
  return filename.slice(0, length - extension.length) + extension;
}

function partHeaders(attachment: AddedAttachment, eol: string): string {
  const filename = safeAttachmentFilename(attachment.filename);
  const ascii = asciiFilename(filename) === filename;
  // For apps that read neither encoding. It is only an approximation, so a long one keeps its start and extension.
  const fallback = ascii ? filename : shortened(asciiFilename(filename), 60);
  // Mail apps read the RFC 2047 name on Content-Type and the RFC 2231 filename on Content-Disposition. Long names
  // are split so no header line passes the 998-character limit.
  const name = ascii ? fallback : encodedWords(filename).join(`${eol} `);
  const disposition = ascii
    ? [`filename="${fallback}"`]
    : [`filename="${fallback}"`, ...filenameContinuations(filename)];
  return [
    `Content-Type: ${safeMimeType(attachment.mimeType)};${eol} name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment;${eol} ${disposition.join(`;${eol} `)}`,
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
