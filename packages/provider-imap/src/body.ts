import iconv from 'iconv-lite';
import libmime from 'libmime';
import {
  EmailError,
  extractSearchContext,
  htmlToReadableText,
  invalidResponseError,
  SEARCH_CONTEXT_INPUT_LIMIT,
  type AttachmentMeta,
  type Message,
  type MessageBody,
  withoutTrailingLineBreaks,
} from '@fluxmail/core';
import type { DownloadObject, ImapFlow, MessageStructureObject } from 'imapflow';
import { mapImapError } from './errors.js';

const changedMidRead = new WeakSet<EmailError>();

function fetchError(message: string): EmailError {
  const error = invalidResponseError(message);
  error.failure = { ...error.failure, provider: 'imap', phase: 'fetch' };
  return error;
}

/**
 * The message was replaced or expunged while Fluxmail read it, as when another
 * mail app autosaves an open draft. Reading the copy that replaced it may work.
 */
export function changedMidReadError(): EmailError {
  const error = fetchError('The message changed on the IMAP server while it was being read');
  changedMidRead.add(error);
  return error;
}

/** Whether a read failed because the message changed while it was being read. */
export function isChangedMidRead(error: unknown): boolean {
  return error instanceof EmailError && changedMidRead.has(error);
}

/** Whether a message is gone from the open folder or marked for expunging. */
export async function isGone(client: ImapFlow, uid: number): Promise<boolean> {
  const current = await client.fetchOne(uid, { flags: true }, { uid: true });
  return !current || Boolean(current.flags?.has('\\Deleted'));
}

/** Download a message part, failing with a typed error when the server returns nothing for it. */
export async function downloadPart(
  client: ImapFlow,
  uid: number,
  part: string,
  options: { uid: true; maxBytes?: number },
): Promise<DownloadObject> {
  let downloaded: Partial<DownloadObject>;
  try {
    downloaded = await client.download(uid, part, options);
  } catch (error) {
    // A message expunged during the download can fail it in more than one way:
    // for part 1, ImapFlow fetches the body structure again and fails with a
    // TypeError when the reply has none, and a server may answer NO, as with
    // the EXPUNGEISSUED response code.
    if (client.mailbox && (await isGone(client, uid).catch(() => false))) throw changedMidReadError();
    throw error;
  }
  // ImapFlow's types promise both fields, but it resolves {} when no folder is
  // open or the server returns no content.
  const { meta, content } = downloaded;
  if (meta && content) return { meta, content };
  if (!client.mailbox) {
    throw mapImapError(Object.assign(new Error('Connection not available'), { code: 'NoConnection' }), 'fetch');
  }
  if (await isGone(client, uid)) throw changedMidReadError();
  throw fetchError(`The IMAP server returned no content for message part ${part}`);
}

export interface BodyParts {
  text?: string;
  html?: string;
  attachments: AttachmentMeta[];
}

export function inspectStructure(structure: MessageStructureObject | undefined): BodyParts {
  const result: BodyParts = { attachments: [] };
  if (!structure) return result;
  const visit = (node: MessageStructureObject) => {
    const part = node.part ?? (node === structure && !node.childNodes?.length ? '1' : undefined);
    const disposition = node.disposition?.toLowerCase();
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    const mimeType = node.type.toLowerCase();
    const attached =
      disposition === 'attachment' ||
      Boolean(filename) ||
      mimeType === 'message/rfc822' ||
      (disposition === 'inline' && mimeType !== 'text/plain' && mimeType !== 'text/html') ||
      (Boolean(node.id) && !mimeType.startsWith('text/'));
    if (attached && part) {
      result.attachments.push({
        id: `part:${part}`,
        filename: filename ?? 'attachment',
        mimeType: node.type || 'application/octet-stream',
        sizeBytes: node.size ?? 0,
        ...(node.id ? { contentId: node.id.replace(/^<|>$/g, '') } : {}),
        disposition: disposition === 'inline' ? 'inline' : 'attachment',
      });
      return;
    }
    if (part) {
      if (mimeType === 'text/plain' && !result.text) result.text = part;
      if (mimeType === 'text/html' && !result.html) result.html = part;
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(structure);
  return result;
}

async function readPart(client: ImapFlow, uid: number, part: string): Promise<string> {
  const { meta, content } = await downloadPart(client, uid, part, { uid: true });
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const charset = meta.charset && iconv.encodingExists(meta.charset) ? meta.charset : 'utf-8';
  return iconv.decode(bytes, charset);
}

const SNIPPET_INPUT_LIMIT = 16 * 1024;
const SNIPPET_OUTPUT_LIMIT = 300;

export interface DownloadedListBody {
  snippet?: string;
  searchContext?: NonNullable<Message['searchContext']>;
}

/** Download the preferred text part once for optional list-result enrichment. */
export async function downloadListBody(
  client: ImapFlow,
  uid: number,
  parts: BodyParts,
  options: { snippet: boolean; searchContextText?: string },
): Promise<DownloadedListBody> {
  const part = parts.text ?? parts.html;
  if (!part) {
    return options.searchContextText ? { searchContext: { status: 'unavailable' } } : {};
  }
  const inputLimit = options.searchContextText ? SEARCH_CONTEXT_INPUT_LIMIT : SNIPPET_INPUT_LIMIT;
  const { meta, content } = await downloadPart(client, uid, part, { uid: true, maxBytes: inputLimit });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of content) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = inputLimit - size;
    if (remaining <= 0) break;
    chunks.push(bytes.subarray(0, remaining));
    size += Math.min(bytes.length, remaining);
    if (size >= inputLimit) break;
  }
  const charset = meta.charset && iconv.encodingExists(meta.charset) ? meta.charset : 'utf-8';
  const decoded = iconv.decode(Buffer.concat(chunks, size), charset);
  const selectedBody = parts.text ? { text: decoded } : { html: decoded };
  const result: DownloadedListBody = {};
  if (options.snippet) {
    const snippet = snippetText(decoded, !parts.text);
    if (snippet) result.snippet = snippet;
  }
  if (options.searchContextText) {
    result.searchContext = extractSearchContext(selectedBody, options.searchContextText, {
      complete: size < inputLimit || meta.expectedSize <= size,
    });
  }
  return result;
}

function snippetText(decoded: string, html: boolean): string | undefined {
  const text = (html ? htmlToReadableText(decoded) : decoded).replace(/\s+/gu, ' ').trim();
  return text ? [...text].slice(0, SNIPPET_OUTPUT_LIMIT).join('') : undefined;
}

function partNode(structure: MessageStructureObject, part: string): MessageStructureObject | undefined {
  if (!structure.childNodes?.length) return part === '1' ? structure : undefined;
  for (const child of structure.childNodes) {
    if (child.part === part) return child;
    const found = partNode(child, part);
    if (found) return found;
  }
  return undefined;
}

// A truncated part can end inside an escape or a soft line break; those bytes are dropped.
function decodeQuotedPrintable(raw: Buffer): Buffer {
  const text = raw
    .toString('latin1')
    .replace(/=\r?\n/g, '')
    .replace(/=(?:[\da-fA-F]|\r)?$/, '');
  const bytes = Buffer.alloc(text.length);
  let size = 0;
  for (let index = 0; index < text.length; index++) {
    const escape = text.slice(index + 1, index + 3);
    if (text[index] === '=' && /^[\da-fA-F]{2}$/.test(escape)) {
      bytes[size++] = Number.parseInt(escape, 16);
      index += 2;
    } else {
      bytes[size++] = text.charCodeAt(index) & 0xff;
    }
  }
  return bytes.subarray(0, size);
}

function decodeTransfer(raw: Buffer, encoding: string | undefined): Buffer {
  if (encoding === 'base64') {
    const text = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(text.slice(0, text.length - (text.length % 4)), 'base64');
  }
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(raw);
  return raw;
}

// Encoded bytes to request for SNIPPET_INPUT_LIMIT decoded bytes. Base64 adds a
// third plus line breaks; quoted-printable can triple every byte.
function encodedLimit(encoding: string | undefined): number {
  if (encoding === 'base64') return Math.ceil((SNIPPET_INPUT_LIMIT * 4) / 3 / 76) * 78;
  if (encoding === 'quoted-printable') return SNIPPET_INPUT_LIMIT * 3;
  return SNIPPET_INPUT_LIMIT;
}

/** Most encoded bytes one batched preview fetch requests. */
const SNIPPET_FETCH_BYTES = 1024 * 1024;

export interface ListBodyEntry {
  uid: number;
  structure: MessageStructureObject;
  parts: BodyParts;
}

// imapflow's download decodes these with its own Japanese decoder; iconv-lite doesn't support them.
const JAPANESE_CHARSET = /^jis|^iso-?2022-?jp|^euc-?jp/i;

// Servers report a part without a charset as us-ascii. Decode it as UTF-8, a
// superset of ASCII, as the download does for a part whose headers name none.
function previewCharset(charset: string | undefined): string {
  const normalized = charset?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!charset || normalized === 'ascii' || normalized === 'usascii' || !iconv.encodingExists(charset)) return 'utf-8';
  return charset;
}

function decodePreview(raw: Buffer, node: MessageStructureObject, encoding: string | undefined, html: boolean) {
  let bytes = decodeTransfer(raw, encoding).subarray(0, SNIPPET_INPUT_LIMIT);
  const parameters = node.parameters;
  // The same format=flowed decoding imapflow's download applies, before the charset.
  if (parameters?.format?.toLowerCase() === 'flowed') {
    const delSp = parameters.delsp?.toLowerCase() === 'yes';
    bytes = Buffer.from(libmime.decodeFlowed(bytes.toString('binary'), delSp), 'binary');
  }
  return snippetText(iconv.decode(bytes, previewCharset(parameters?.charset)), html);
}

/**
 * Read previews for several messages with one UID FETCH per text part and
 * encoding, instead of a download per message. Each message's body structure,
 * from the list fetch, gives the part's encoding and charset. Japanese
 * charsets, and messages in a fetch the server rejected, fall back to a
 * download each. Messages without a text part map to undefined. A message
 * whose part couldn't be read, or wasn't read before the deadline, is absent.
 */
export async function downloadSnippets(
  client: ImapFlow,
  entries: ListBodyEntry[],
  deadlineAt?: number,
): Promise<Map<number, string | undefined>> {
  const snippets = new Map<number, string | undefined>();
  const groups = new Map<
    string,
    {
      key: string;
      maxLength: number;
      entries: { uid: number; parts: BodyParts; node: MessageStructureObject; encoding?: string }[];
    }
  >();
  const downloads: { uid: number; parts: BodyParts }[] = [];
  const pastDeadline = () => deadlineAt !== undefined && Date.now() >= deadlineAt;
  for (const { uid, structure, parts } of entries) {
    const part = parts.text ?? parts.html;
    if (!part) {
      snippets.set(uid, undefined);
      continue;
    }
    const node = partNode(structure, part);
    if (!node) continue;
    if (JAPANESE_CHARSET.test(node.parameters?.charset ?? '')) {
      downloads.push({ uid, parts });
      continue;
    }
    // Like imapflow's download, read a single-part message's body as TEXT.
    const key = part === '1' && !structure.childNodes?.length ? 'text' : part.toLowerCase();
    const encoding = node.encoding?.toLowerCase();
    const maxLength = encodedLimit(encoding);
    const groupKey = `${key}:${maxLength}`;
    const group = groups.get(groupKey) ?? { key, maxLength, entries: [] };
    group.entries.push({ uid, parts, node, encoding });
    groups.set(groupKey, group);
  }
  for (const { key, maxLength, entries: grouped } of groups.values()) {
    const perFetch = Math.max(1, Math.floor(SNIPPET_FETCH_BYTES / maxLength));
    for (let start = 0; start < grouped.length; start += perFetch) {
      if (pastDeadline()) return snippets;
      const batch = grouped.slice(start, start + perFetch);
      const nodes = new Map(batch.map((entry) => [entry.uid, entry]));
      try {
        for await (const message of client.fetch(
          batch.map((entry) => entry.uid).join(','),
          { uid: true, bodyParts: [{ key, start: 0, maxLength }] },
          { uid: true },
        )) {
          const entry = nodes.get(message.uid);
          const raw = message.bodyParts?.get(key);
          if (!entry || !raw) continue;
          snippets.set(entry.uid, decodePreview(raw, entry.node, entry.encoding, !entry.parts.text));
        }
      } catch {
        // One message can make a server reject the whole fetch, so read the rest one at a time.
        for (const { uid, parts } of batch) if (!snippets.has(uid)) downloads.push({ uid, parts });
      }
    }
  }
  for (const { uid, parts } of downloads) {
    if (pastDeadline()) break;
    try {
      snippets.set(uid, (await downloadListBody(client, uid, parts, { snippet: true })).snippet);
    } catch {
      // The caller reports this preview as unavailable.
    }
  }
  return snippets;
}

/** Download only the preferred text part and return a bounded one-line preview. */
export async function downloadSnippet(client: ImapFlow, uid: number, parts: BodyParts): Promise<string | undefined> {
  return (await downloadListBody(client, uid, parts, { snippet: true })).snippet;
}

export async function downloadBody(client: ImapFlow, uid: number, parts: BodyParts): Promise<MessageBody> {
  const body: MessageBody = {};
  if (parts.text) body.text = withoutTrailingLineBreaks(await readPart(client, uid, parts.text));
  if (parts.html) body.html = await readPart(client, uid, parts.html);
  return body;
}
