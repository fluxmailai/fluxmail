import type { Message, ModifyAction, Thread } from '../types.js';
import type { ModifyActionName } from './scopes.js';

/** The most body characters one MCP result returns, so one long email can't fill the model's context. */
export const MAX_BODY_CHARS = 50_000;
export const MAX_THREAD_PAGE_TOKEN_CHARS = 1024;
export const DEFAULT_THREAD_PAGE_SIZE = 10;

export type BodyFormat = 'text' | 'html' | 'both' | 'none';
export type BodyTruncation = Record<string, { totalChars: number; nextOffset?: number }>;

/** Keep the requested body parts, cut to a shared character budget, and say where each was cut. */
export function selectBody(
  message: Message,
  format: BodyFormat,
  budget: number = MAX_BODY_CHARS,
): Message & { bodyTruncation?: BodyTruncation } {
  if (!message.body || format === 'none') return { ...message, body: undefined };
  const body: { text?: string; html?: string } = {};
  const bodyTruncation: BodyTruncation = {};
  let remaining = budget;
  for (const key of ['text', 'html'] as const) {
    if (format !== 'both' && format !== key) continue;
    const value = message.body[key];
    if (value === undefined) continue;
    const selected = value.slice(0, remaining);
    body[key] = selected;
    bodyTruncation[key] = {
      totalChars: value.length,
      ...(selected.length < value.length ? { nextOffset: selected.length } : {}),
    };
    remaining -= selected.length;
  }
  return { ...message, body, bodyTruncation };
}

export interface BodyPage {
  format: 'text' | 'html';
  text: string;
  offset: number;
  totalChars: number;
  nextOffset?: number;
}

/** One window of a message body, for reading a long body in parts. */
export function bodyPage(
  message: Message,
  format: 'text' | 'html',
  offset = 0,
  maxChars: number = MAX_BODY_CHARS,
): BodyPage {
  const value = message.body?.[format] ?? '';
  const text = value.slice(offset, offset + maxChars);
  return {
    format,
    text,
    offset,
    totalChars: value.length,
    ...(offset + text.length < value.length ? { nextOffset: offset + text.length } : {}),
  };
}

/**
 * The message offset a thread page token points to, or undefined when the token is malformed or
 * belongs to another thread. A token is the base64url JSON of the thread ID and the offset.
 */
export function threadPageOffset(threadId: string, pageToken: string | undefined): number | undefined {
  if (!pageToken) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as {
      threadId?: unknown;
      offset?: unknown;
    };
    if (parsed.threadId === threadId && Number.isInteger(parsed.offset) && (parsed.offset as number) >= 0)
      return parsed.offset as number;
  } catch {
    // Reported as undefined.
  }
  return undefined;
}

export interface ThreadPage {
  id: string;
  subject: string;
  messages: Array<Message & { bodyTruncation?: BodyTruncation }>;
  nextPageToken?: string;
}

/** One page of a thread's messages. Bodies on the page share one character budget. */
export function threadPage(
  thread: Thread,
  options: { threadId: string; offset: number; pageSize?: number; bodyFormat?: BodyFormat },
): ThreadPage {
  const { threadId, offset } = options;
  let budget = MAX_BODY_CHARS;
  const messages = thread.messages
    .slice(offset, offset + (options.pageSize ?? DEFAULT_THREAD_PAGE_SIZE))
    .map((message) => {
      const selected = selectBody(message, options.bodyFormat ?? 'both', budget);
      budget -= (selected.body?.text?.length ?? 0) + (selected.body?.html?.length ?? 0);
      return selected;
    });
  const nextOffset = offset + messages.length;
  return {
    id: thread.id,
    subject: thread.subject,
    messages,
    ...(nextOffset < thread.messages.length
      ? { nextPageToken: Buffer.from(JSON.stringify({ threadId, offset: nextOffset })).toString('base64url') }
      : {}),
  };
}

/** Folders a move can't target, because archive and trash have their own actions. */
export const PROTECTED_MOVE_DESTINATIONS: ReadonlySet<string> = new Set(['archive', 'trash']);

/**
 * The provider action for a modify action and its arguments, or an error message for the
 * caller when a required argument is missing or the move targets a protected folder.
 */
export function toModifyAction(
  action: ModifyActionName,
  args: { folder?: string; labels?: string[] },
): { action: ModifyAction } | { error: string } {
  if (action === 'move') {
    if (!args.folder) return { error: 'Moving messages requires "folder"' };
    if (PROTECTED_MOVE_DESTINATIONS.has(args.folder.trim().toLowerCase()))
      return { error: 'Archive or trash these messages instead of moving them to this folder.' };
    return { action: { move: args.folder } };
  }
  if (action === 'addLabels' || action === 'removeLabels') {
    if (!args.labels?.length) return { error: `${action} requires "labels"` };
    return { action: action === 'addLabels' ? { addLabels: args.labels } : { removeLabels: args.labels } };
  }
  return { action };
}

const TEXT_TYPES = /^(text\/[\w.+-]+|application\/(json|xml|csv|yaml|x-yaml|javascript|[\w.-]+\+(json|xml)))$/;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

export function mediaType(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}

function decodeText(content: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

export type AttachmentResourceContents =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };

/**
 * Some clients, including claude.ai, only pass a blob to the model through
 * file storage, so UTF-8 text attachments go out as text.
 */
export function attachmentContents(uri: string, mimeType: string, content: Buffer): AttachmentResourceContents {
  const text = TEXT_TYPES.test(mediaType(mimeType)) ? decodeText(content) : undefined;
  return text === undefined ? { uri, mimeType, blob: content.toString('base64') } : { uri, mimeType, text };
}

export type InlineAttachmentContent =
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: AttachmentResourceContents };

export function inlineContent(uri: string, mimeType: string, content: Buffer): InlineAttachmentContent {
  if (IMAGE_TYPES.test(mediaType(mimeType))) return { type: 'image', data: content.toString('base64'), mimeType };
  return { type: 'resource', resource: attachmentContents(uri, mimeType, content) };
}

/** The URI of an attachment resource. The filename is display-only; lookups use the IDs. */
export function attachmentUri(accountId: string, messageId: string, attachmentId: string, filename: string): string {
  // encodeURIComponent throws on an unpaired surrogate, so replace it.
  const wellFormed = filename.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '\ufffd',
  );
  return ['fluxmail://attachment', ...[accountId, messageId, attachmentId, wellFormed].map(encodeURIComponent)].join(
    '/',
  );
}

export const ATTACHMENT_URI_TEMPLATE = 'fluxmail://attachment/{accountId}/{messageId}/{attachmentId}/{filename}';

/** Limits on PDF text extraction. At most `workers` extractions run at once in a process, across extractors. */
export const PDF_TEXT_LIMITS = { maxPages: 200, maxChars: 80_000, heapMb: 128, timeoutMs: 15_000, workers: 2 };

/** A PDF page or ascending page range such as 201-400. Check the order with parsePageRange. */
export const PDF_PAGE_RANGE_PATTERN = /^[1-9]\d{0,5}(-[1-9]\d{0,5})?$/;
export const PDF_PAGE_RANGE_MESSAGE = 'Use a page or an ascending range such as 201-400.';

/** The first and last page of a range, or undefined when it is malformed or descending. */
export function parsePageRange(pages: string): { first: number; last: number } | undefined {
  if (!PDF_PAGE_RANGE_PATTERN.test(pages)) return undefined;
  const [first, last = first] = pages.split('-').map(Number) as [number, number?];
  return last >= first ? { first, last } : undefined;
}

export interface PdfText {
  text: string;
  firstPage: number;
  lastPage: number;
  totalPages: number;
  cut: boolean;
}

/** The text block describing an extraction, or none when extraction failed. */
export function pdfTextContent(filename: string, pdf: PdfText | undefined): Array<{ type: 'text'; text: string }> {
  if (!pdf) return [];
  const { firstPage, lastPage, totalPages } = pdf;
  if (lastPage < firstPage) {
    return [{ type: 'text', text: `${filename} has ${totalPages} ${totalPages === 1 ? 'page' : 'pages'}.` }];
  }
  const whole = firstPage === 1 && lastPage === totalPages && !pdf.cut;
  const pages = firstPage === lastPage ? `page ${firstPage}` : `pages ${firstPage}-${lastPage}`;
  const cut = pdf.cut ? `, cut at ${PDF_TEXT_LIMITS.maxChars.toLocaleString('en-US')} characters` : '';
  const scope = whole ? '' : ` (${pages} of ${totalPages}${cut})`;
  return [
    {
      type: 'text',
      text: pdf.text
        ? `Text extracted from ${filename}${scope}:\n\n${pdf.text}`
        : `No text found in ${filename}${scope}.`,
    },
  ];
}
