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
    // The connection ID lets mapImapError report why the connection closed.
    const closed = Object.assign(new Error('Connection not available'), { code: 'NoConnection', cid: client.id });
    throw mapImapError(closed, 'fetch');
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

/**
 * Whether the server answered BODY[part.MIME] for a single part with a
 * multipart header, or with no Content-Type at all. GreenMail returns the
 * parent's header for a part nested in a multipart part, such as text/html in
 * multipart/alternative in multipart/related. A single part's own header never
 * names a multipart type, and a multipart header carries no transfer encoding,
 * so imapflow's download then applies no transfer encoding, format or charset.
 */
export function misreportedPartHeader(
  meta: Pick<DownloadObject['meta'], 'contentType' | 'encoding'>,
  node: MessageStructureObject | undefined,
): boolean {
  if (!node || node.childNodes?.length || CONTAINER_TYPE.test(node.type)) return false;
  // The download decoded a transfer encoding the header named.
  if (meta.encoding === 'base64' || meta.encoding === 'quoted-printable') return false;
  return !meta.contentType || CONTAINER_TYPE.test(meta.contentType);
}

// Types whose parts are nested parts, so never the header of a single part.
const CONTAINER_TYPE = /^(?:multipart\/|message\/rfc822$)/i;

/** Apply a part's transfer encoding from its body structure, for a download that skipped it. */
export function decodePartTransfer(raw: Buffer, node: MessageStructureObject, complete: boolean): Buffer {
  return decodeTransfer(raw, node.encoding?.toLowerCase(), complete);
}

/**
 * Most encoded bytes a part of at most maxBytes decoded bytes can take. Base64
 * adds a third plus line breaks; quoted-printable can triple every byte, plus
 * soft line breaks.
 */
export function encodedLimit(encoding: string | undefined, maxBytes: number): number {
  if (encoding === 'base64') return Math.ceil((maxBytes * 4) / 3 / 76) * 78;
  if (encoding === 'quoted-printable') return Math.ceil((maxBytes * 3) / 75) * 78;
  return maxBytes;
}

async function readPart(client: ImapFlow, uid: number, part: string, node?: MessageStructureObject): Promise<string> {
  const { meta, content } = await downloadPart(client, uid, part, { uid: true });
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return decodeText(Buffer.concat(chunks), meta, node, true);
}

function decodeText(
  bytes: Buffer,
  meta: DownloadObject['meta'],
  node: MessageStructureObject | undefined,
  complete: boolean,
): string {
  if (node && misreportedPartHeader(meta, node)) {
    return decodeFormatAndCharset(decodePartTransfer(bytes, node, complete), node);
  }
  const charset = meta.charset && iconv.encodingExists(meta.charset) ? meta.charset : 'utf-8';
  return iconv.decode(bytes, charset);
}

// The format=flowed and charset decoding imapflow's download applies, from the body structure.
function decodeFormatAndCharset(bytes: Buffer, node: MessageStructureObject): string {
  const parameters = node.parameters;
  if (parameters?.format?.toLowerCase() === 'flowed') {
    const delSp = parameters.delsp?.toLowerCase() === 'yes';
    bytes = Buffer.from(libmime.decodeFlowed(bytes.toString('binary'), delSp), 'binary');
  }
  return iconv.decode(bytes, previewCharset(parameters?.charset));
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
  options: { snippet: boolean; searchContextText?: string; structure?: MessageStructureObject },
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
  const complete = size < inputLimit || meta.expectedSize <= size;
  const node = options.structure && partNode(options.structure, part);
  const decoded = decodeText(Buffer.concat(chunks, size), meta, node, complete);
  const selectedBody = parts.text ? { text: decoded } : { html: decoded };
  const result: DownloadedListBody = {};
  if (options.snippet) {
    const snippet = snippetText(decoded, !parts.text);
    if (snippet) result.snippet = snippet;
  }
  if (options.searchContextText) {
    result.searchContext = extractSearchContext(selectedBody, options.searchContextText, {
      complete,
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

// A soft line break may have trailing whitespace, and a complete part may end
// in one with no line break. A truncated part can also end inside an escape;
// those bytes are dropped. A complete part keeps a trailing `=X` as text.
function decodeQuotedPrintable(raw: Buffer, complete: boolean): Buffer {
  let text = raw
    .toString('latin1')
    .replace(/=[ \t]*\r?\n/g, '')
    .replace(complete ? /=[ \t]*\r?$/ : /=(?:[\da-fA-F]|\r)?$/, '');
  const bytes = Buffer.alloc(text.length);
  let size = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x3d && isHex(text.charCodeAt(index + 1)) && isHex(text.charCodeAt(index + 2))) {
      bytes[size++] = Number.parseInt(text.slice(index + 1, index + 3), 16);
      index += 2;
    } else {
      bytes[size++] = code & 0xff;
    }
  }
  return bytes.subarray(0, size);
}

function isHex(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

// A truncated base64 part drops its last partial group; a complete one keeps
// it, as unpadded base64 still decodes.
function decodeTransfer(raw: Buffer, encoding: string | undefined, complete: boolean): Buffer {
  if (encoding === 'base64') {
    const text = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(complete ? text : text.slice(0, text.length - (text.length % 4)), 'base64');
  }
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(raw, complete);
  return raw;
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
  const bytes = decodeTransfer(raw, encoding, false).subarray(0, SNIPPET_INPUT_LIMIT);
  return snippetText(decodeFormatAndCharset(bytes, node), html);
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
      entries: {
        uid: number;
        structure: MessageStructureObject;
        parts: BodyParts;
        node: MessageStructureObject;
        encoding?: string;
      }[];
    }
  >();
  const downloads: { uid: number; structure: MessageStructureObject; parts: BodyParts }[] = [];
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
      downloads.push({ uid, structure, parts });
      continue;
    }
    // Like imapflow's download, read a single-part message's body as TEXT.
    const key = part === '1' && !structure.childNodes?.length ? 'text' : part.toLowerCase();
    const encoding = node.encoding?.toLowerCase();
    const maxLength = encodedLimit(encoding, SNIPPET_INPUT_LIMIT);
    const groupKey = `${key}:${maxLength}`;
    const group = groups.get(groupKey) ?? { key, maxLength, entries: [] };
    group.entries.push({ uid, structure, parts, node, encoding });
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
        for (const { uid, structure, parts } of batch)
          if (!snippets.has(uid)) downloads.push({ uid, structure, parts });
      }
    }
  }
  for (const { uid, structure, parts } of downloads) {
    if (pastDeadline()) break;
    try {
      snippets.set(uid, (await downloadListBody(client, uid, parts, { snippet: true, structure })).snippet);
    } catch {
      // The caller reports this preview as unavailable.
    }
  }
  return snippets;
}

export async function downloadBody(
  client: ImapFlow,
  uid: number,
  parts: BodyParts,
  structure?: MessageStructureObject,
): Promise<MessageBody> {
  const body: MessageBody = {};
  const node = (part: string) => structure && partNode(structure, part);
  if (parts.text) body.text = withoutTrailingLineBreaks(await readPart(client, uid, parts.text, node(parts.text)));
  if (parts.html) body.html = await readPart(client, uid, parts.html, node(parts.html));
  return body;
}
