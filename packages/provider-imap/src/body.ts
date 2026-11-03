import iconv from 'iconv-lite';
import libmime from 'libmime';
import {
  extractSearchContext,
  htmlToReadableText,
  SEARCH_CONTEXT_INPUT_LIMIT,
  type AttachmentMeta,
  type Message,
  type MessageBody,
} from '@fluxmail/core';
import type { ImapFlow, MessageStructureObject } from 'imapflow';

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
  const { meta, content } = await client.download(uid, part, { uid: true });
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
  const { meta, content } = await client.download(uid, part, { uid: true, maxBytes: inputLimit });
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

/**
 * Read previews for several messages with one UID FETCH per text part and
 * encoding, instead of a download per message. Each message's body structure,
 * from the list fetch, gives the part's encoding and charset. Messages without
 * a text part map to undefined. A message whose part couldn't be read, or
 * wasn't read before the deadline, is absent.
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
      entries: { uid: number; node: MessageStructureObject; encoding?: string; html: boolean }[];
    }
  >();
  for (const { uid, structure, parts } of entries) {
    const part = parts.text ?? parts.html;
    if (!part) {
      snippets.set(uid, undefined);
      continue;
    }
    const node = partNode(structure, part);
    if (!node) continue;
    // Like imapflow's download, read a single-part message's body as TEXT.
    const key = part === '1' && !structure.childNodes?.length ? 'text' : part.toLowerCase();
    const encoding = node.encoding?.toLowerCase();
    const maxLength = encodedLimit(encoding);
    const groupKey = `${key}:${maxLength}`;
    const group = groups.get(groupKey) ?? { key, maxLength, entries: [] };
    group.entries.push({ uid, node, encoding, html: !parts.text });
    groups.set(groupKey, group);
  }
  for (const { key, maxLength, entries: grouped } of groups.values()) {
    const perFetch = Math.max(1, Math.floor(SNIPPET_FETCH_BYTES / maxLength));
    for (let start = 0; start < grouped.length; start += perFetch) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) return snippets;
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
          let bytes = decodeTransfer(raw, entry.encoding).subarray(0, SNIPPET_INPUT_LIMIT);
          const parameters = entry.node.parameters;
          // The same format=flowed decoding imapflow's download applies, before the charset.
          if (parameters?.format?.toLowerCase() === 'flowed') {
            const delSp = parameters.delsp?.toLowerCase() === 'yes';
            bytes = Buffer.from(libmime.decodeFlowed(bytes.toString('binary'), delSp), 'binary');
          }
          const charset = parameters?.charset;
          const decoded = iconv.decode(bytes, charset && iconv.encodingExists(charset) ? charset : 'utf-8');
          snippets.set(entry.uid, snippetText(decoded, entry.html));
        }
      } catch {
        // These messages stay absent, so the caller reports their previews as unavailable.
      }
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
  if (parts.text) body.text = await readPart(client, uid, parts.text);
  if (parts.html) body.html = await readPart(client, uid, parts.html);
  return body;
}
