import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  SEND_CONFIRMATION_HTML,
  SEND_CONFIRMATION_MAX_BODY_CHARS,
  SEND_CONFIRMATION_RESULT_META_KEY,
} from './sendConfirmationView.js';
import { MESSAGE_READER_HTML, MESSAGE_READER_RESULT_META_KEY } from './messageReaderView.js';
import type { Message } from '../types.js';
import type { BodyTruncation } from './results.js';

export { SEND_CONFIRMATION_HTML, SEND_CONFIRMATION_MAX_BODY_CHARS, SEND_CONFIRMATION_RESULT_META_KEY };
export { MESSAGE_READER_HTML, MESSAGE_READER_RESULT_META_KEY };

/** The MCP Apps extension identifier clients advertise under `capabilities.extensions`. */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
/** The MIME type of an MCP Apps HTML view. */
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';

/** Version the URI with the view: hosts may cache a resource by its URI. */
export const SEND_CONFIRMATION_RESOURCE_URI = 'ui://fluxmail/send-confirmation-v1.html';
/** The shared tool whose result the card renders. */
export const SEND_CONFIRMATION_TOOL = 'preview_send';
/** The shared tool the card calls when the user clicks Send. */
export const SEND_CONFIRMATION_SEND_TOOL = 'send_email';

/**
 * Resource metadata for the card. Empty CSP lists declare that the view loads nothing from any origin, the
 * strictest policy MCP Apps allows. The card requests no device permissions.
 */
export const SEND_CONFIRMATION_RESOURCE_META = {
  ui: {
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    prefersBorder: true,
  },
} as const;

/** The card as `resources/list` advertises it. */
export const SEND_CONFIRMATION_RESOURCE = {
  uri: SEND_CONFIRMATION_RESOURCE_URI,
  name: 'send_confirmation',
  title: 'Send email',
  description: 'Shows an email exactly as it will be sent, with a Send button.',
  mimeType: MCP_APPS_MIME_TYPE,
  _meta: SEND_CONFIRMATION_RESOURCE_META,
} as const;

/** The card's `resources/read` contents. */
export function sendConfirmationResourceContents(): Array<{
  uri: string;
  mimeType: string;
  text: string;
  _meta: typeof SEND_CONFIRMATION_RESOURCE_META;
}> {
  return [
    {
      uri: SEND_CONFIRMATION_RESOURCE_URI,
      mimeType: MCP_APPS_MIME_TYPE,
      text: SEND_CONFIRMATION_HTML,
      _meta: SEND_CONFIRMATION_RESOURCE_META,
    },
  ];
}

/**
 * The `_meta` preview_send's tool definition carries to link the card. `ui/resourceUri` is the deprecated flat
 * key, kept for hosts that read only it, as the MCP Apps SDK's registerAppTool does.
 */
export const SEND_CONFIRMATION_TOOL_META = {
  ui: { resourceUri: SEND_CONFIRMATION_RESOURCE_URI },
  'ui/resourceUri': SEND_CONFIRMATION_RESOURCE_URI,
} as const;

/** What the card needs beyond preview_send's structured result. */
export interface SendConfirmationData {
  version: 1;
  /**
   * The key the card sends with, so a double click, retry or re-render delivers once. Issued by
   * issueSendConfirmationKey, it also binds the send to the previewed message and the preview time.
   */
  idempotencyKey: string;
  /** The body as it will be sent, each part cut to SEND_CONFIRMATION_MAX_BODY_CHARS. */
  body: {
    text?: string;
    html?: string;
    textTruncated?: boolean;
    htmlTruncated?: boolean;
    /** Images the HTML references as cid:<Content-ID>, as data: URLs, within the image limits. */
    inlineImages?: Record<string, string>;
    /** How many inline images were left out for their type or size. */
    inlineImagesOmitted?: number;
  };
}

/** Base64 characters of one inline image the card receives, about 384 KB of image data. */
export const SEND_CONFIRMATION_MAX_IMAGE_CHARS = 512 * 1024;
/** Base64 characters of all inline images the card receives, about 1.5 MB of image data. */
export const SEND_CONFIRMATION_MAX_IMAGES_CHARS = 2 * 1024 * 1024;
const CARD_IMAGE_TYPES = new Set(['image/png', 'image/gif', 'image/jpeg', 'image/webp']);

/** Whether a card shows this image type inline. */
export function isCardImageType(mimeType: string): boolean {
  return CARD_IMAGE_TYPES.has(mimeType.toLowerCase().split(';')[0]!.trim());
}

function inlineImageUrls(images: ReadonlyArray<{ contentId?: string; mimeType: string; content: string }>): {
  urls: Record<string, string>;
  omitted: number;
} {
  const urls: Record<string, string> = {};
  let omitted = 0;
  let total = 0;
  for (const image of images) {
    if (!image.contentId) continue;
    const content = image.content.replace(/\s+/g, '');
    const mimeType = image.mimeType.toLowerCase().split(';')[0]!.trim();
    if (
      !CARD_IMAGE_TYPES.has(mimeType) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(content) ||
      content.length > SEND_CONFIRMATION_MAX_IMAGE_CHARS ||
      total + content.length > SEND_CONFIRMATION_MAX_IMAGES_CHARS
    ) {
      omitted += 1;
      continue;
    }
    total += content.length;
    // The card matches cid: references without angle brackets.
    urls[image.contentId.trim().replace(/^<|>$/g, '')] = `data:${mimeType};base64,${content}`;
  }
  return { urls, omitted };
}

function bounded(
  value: string | undefined,
  limit: number = SEND_CONFIRMATION_MAX_BODY_CHARS,
): { value?: string; truncated?: boolean } {
  if (!value) return {};
  if (value.length <= limit) return { value };
  let end = limit;
  // Don't split a surrogate pair.
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { value: value.slice(0, end), truncated: true };
}

/**
 * The `_meta` to add to a successful preview_send result for hosts that may render the card. Its content and
 * structuredContent stay unchanged; hosts don't add `_meta` to model context.
 */
export function sendConfirmationResultMeta(input: {
  idempotencyKey: string;
  body: { text?: string; html?: string };
  /** Attachments with a Content-ID; the HTML may show them as cid: images. */
  inlineImages?: ReadonlyArray<{ contentId?: string; mimeType: string; content: string }>;
}): Record<string, SendConfirmationData> {
  const text = bounded(input.body.text);
  const html = bounded(input.body.html);
  const images = html.value ? inlineImageUrls(input.inlineImages ?? []) : { urls: {}, omitted: 0 };
  return {
    [SEND_CONFIRMATION_RESULT_META_KEY]: {
      version: 1,
      idempotencyKey: input.idempotencyKey,
      body: {
        ...(text.value !== undefined ? { text: text.value } : {}),
        ...(text.truncated ? { textTruncated: true } : {}),
        ...(html.value !== undefined ? { html: html.value } : {}),
        ...(html.truncated ? { htmlTruncated: true } : {}),
        ...(Object.keys(images.urls).length ? { inlineImages: images.urls } : {}),
        ...(images.omitted ? { inlineImagesOmitted: images.omitted } : {}),
      },
    },
  };
}

/** Version the URI with the view: hosts may cache a resource by its URI. */
export const MESSAGE_READER_RESOURCE_URI = 'ui://fluxmail/message-reader-v1.html';
/** The shared tool whose result the reader renders. */
export const MESSAGE_READER_TOOL = 'get_email';
/** HTML characters the reader receives; formatted newsletters often run past the model's body limit. */
export const MESSAGE_READER_MAX_HTML_CHARS = 200_000;
/** Text characters the reader receives. */
export const MESSAGE_READER_MAX_TEXT_CHARS = 100_000;
/** Inline images the server fetches for one reader card. */
export const MESSAGE_READER_MAX_INLINE_IMAGES = 10;

/**
 * Resource metadata for the reader. Like the send card, it loads nothing from any origin: remote images stay
 * placeholders, because MCP Apps declares allowed origins per resource and a message's image hosts are not known
 * ahead of time.
 */
export const MESSAGE_READER_RESOURCE_META = {
  ui: {
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    prefersBorder: true,
  },
} as const;

/** The reader as `resources/list` advertises it. */
export const MESSAGE_READER_RESOURCE = {
  uri: MESSAGE_READER_RESOURCE_URI,
  name: 'message_reader',
  title: 'Email',
  description: 'Shows an email as it was sent: sender, recipients, date, subject, body and attachments.',
  mimeType: MCP_APPS_MIME_TYPE,
  _meta: MESSAGE_READER_RESOURCE_META,
} as const;

/** The reader's `resources/read` contents. */
export function messageReaderResourceContents(): Array<{
  uri: string;
  mimeType: string;
  text: string;
  _meta: typeof MESSAGE_READER_RESOURCE_META;
}> {
  return [
    {
      uri: MESSAGE_READER_RESOURCE_URI,
      mimeType: MCP_APPS_MIME_TYPE,
      text: MESSAGE_READER_HTML,
      _meta: MESSAGE_READER_RESOURCE_META,
    },
  ];
}

/** The `_meta` get_email's tool definition carries to link the reader. */
export const MESSAGE_READER_TOOL_META = {
  ui: { resourceUri: MESSAGE_READER_RESOURCE_URI },
  'ui/resourceUri': MESSAGE_READER_RESOURCE_URI,
} as const;

/** What the reader needs beyond get_email's structured result. */
export interface MessageReaderData {
  version: 1;
  /**
   * Body parts the model-facing result cut or left out, each cut to MESSAGE_READER_MAX_HTML_CHARS or
   * MESSAGE_READER_MAX_TEXT_CHARS. A part the result already holds in full is not repeated here.
   */
  body: {
    text?: string;
    html?: string;
    textTruncated?: boolean;
    htmlTruncated?: boolean;
    /** Images the HTML references as cid:<Content-ID>, as data: URLs, within the image limits. */
    inlineImages?: Record<string, string>;
    /** How many inline images were left out for their type or size. */
    inlineImagesOmitted?: number;
  };
}

/**
 * The inline image attachments a reader card can show for a message: images the HTML references by cid:, of a
 * type the card renders and small enough to send, at most MESSAGE_READER_MAX_INLINE_IMAGES. Fetch their content
 * and pass it to messageReaderResultMeta.
 */
export function messageReaderInlineImages(message: Pick<Message, 'body' | 'attachments'>): Array<{
  id: string;
  contentId: string;
  mimeType: string;
}> {
  const html = message.body?.html ?? '';
  if (!html) return [];
  const referenced = (contentId: string) => {
    const lower = html.toLowerCase();
    const id = contentId.trim().replace(/^<|>$/g, '').toLowerCase();
    return lower.includes(`cid:${id}`) || lower.includes(`cid:${encodeURIComponent(id).toLowerCase()}`);
  };
  // Base64 grows content by a third.
  const maxBytes = Math.floor((SEND_CONFIRMATION_MAX_IMAGE_CHARS * 3) / 4);
  let total = 0;
  const picked: Array<{ id: string; contentId: string; mimeType: string }> = [];
  for (const attachment of message.attachments ?? []) {
    if (picked.length >= MESSAGE_READER_MAX_INLINE_IMAGES) break;
    if (!attachment.contentId || !isCardImageType(attachment.mimeType) || !referenced(attachment.contentId)) continue;
    if (attachment.sizeBytes > maxBytes || total + attachment.sizeBytes > (SEND_CONFIRMATION_MAX_IMAGES_CHARS * 3) / 4)
      continue;
    total += attachment.sizeBytes;
    picked.push({ id: attachment.id, contentId: attachment.contentId, mimeType: attachment.mimeType });
  }
  return picked;
}

/**
 * The `_meta` to add to a successful get_email result for hosts that may render the reader. `message` is the
 * message as read; `returned` is what the result gives the model. Only body parts the result cut or left out
 * ride in `_meta`, so the card never repeats what the result already carries. Content and structuredContent
 * stay unchanged; hosts don't add `_meta` to model context.
 */
export function messageReaderResultMeta(input: {
  message: Pick<Message, 'body'>;
  returned: { body?: { text?: string; html?: string }; bodyTruncation?: BodyTruncation };
  /** Fetched inline images, from messageReaderInlineImages. */
  inlineImages?: ReadonlyArray<{ contentId?: string; mimeType: string; content: string }>;
}): Record<string, MessageReaderData> {
  const complete = (part: 'text' | 'html') =>
    input.returned.body?.[part] !== undefined && input.returned.bodyTruncation?.[part]?.nextOffset === undefined;
  const text = complete('text') ? {} : bounded(input.message.body?.text, MESSAGE_READER_MAX_TEXT_CHARS);
  const html = complete('html') ? {} : bounded(input.message.body?.html, MESSAGE_READER_MAX_HTML_CHARS);
  const images = input.message.body?.html ? inlineImageUrls(input.inlineImages ?? []) : { urls: {}, omitted: 0 };
  return {
    [MESSAGE_READER_RESULT_META_KEY]: {
      version: 1,
      body: {
        ...(text.value !== undefined ? { text: text.value } : {}),
        ...(text.truncated ? { textTruncated: true } : {}),
        ...(html.value !== undefined ? { html: html.value } : {}),
        ...(html.truncated ? { htmlTruncated: true } : {}),
        ...(Object.keys(images.urls).length ? { inlineImages: images.urls } : {}),
        ...(images.omitted ? { inlineImagesOmitted: images.omitted } : {}),
      },
    },
  };
}

/**
 * Whether a client renders MCP Apps HTML views, from the capabilities it declared. Returns undefined when the
 * capabilities are unknown, such as a stateless HTTP request from a client that declared them only at
 * initialization. Advertise the card unless this returns false: hosts without the extension ignore `_meta`.
 */
export function clientSupportsMcpApps(capabilities: unknown): boolean | undefined {
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const extensions = (capabilities as { extensions?: unknown }).extensions;
  const ui =
    extensions && typeof extensions === 'object'
      ? (extensions as Record<string, unknown>)[MCP_APPS_EXTENSION_ID]
      : undefined;
  const mimeTypes = ui && typeof ui === 'object' ? (ui as { mimeTypes?: unknown }).mimeTypes : undefined;
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APPS_MIME_TYPE);
}

/** What a send confirmation key binds: the message the user saw. */
export interface SendConfirmationMessage {
  from: string;
  to: ReadonlyArray<{ email: string; name?: string }>;
  cc: ReadonlyArray<{ email: string; name?: string }>;
  bcc: ReadonlyArray<{ email: string; name?: string }>;
  subject: string;
  attachments: ReadonlyArray<{ filename: string; mimeType: string; sizeBytes: number }>;
  body: { text?: string; html?: string };
}

const KEY_PREFIX = 'fxui1.';
/** How long a card can send after its preview. */
export const SEND_CONFIRMATION_KEY_TTL_MS = 24 * 60 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** A short digest of the resolved message, compared again when the card sends. */
export function sendConfirmationContentHash(message: SendConfirmationMessage): string {
  const addresses = (list: SendConfirmationMessage['to']) =>
    list.map((address) => [address.email.toLowerCase(), address.name ?? '']);
  const canonical = JSON.stringify([
    message.from.toLowerCase(),
    addresses(message.to),
    addresses(message.cc),
    addresses(message.bcc),
    message.subject,
    message.attachments.map((attachment) => [attachment.filename, attachment.mimeType, attachment.sizeBytes]),
    message.body.text ?? '',
    message.body.html ?? '',
  ]);
  return base64url(createHash('sha256').update(canonical).digest().subarray(0, 16));
}

function keyMac(secret: Uint8Array, payload: string): string {
  return base64url(
    createHmac('sha256', secret).update(`fluxmail send confirmation\0${payload}`).digest().subarray(0, 16),
  );
}

/**
 * The idempotency key a card sends with. It is signed with a server secret and carries the preview time and
 * the content hash, so the server can refuse a card whose message changed or that another send overtook.
 */
export function issueSendConfirmationKey(secret: Uint8Array, contentHash: string, issuedAt = Date.now()): string {
  const payload = `${issuedAt.toString(36)}.${contentHash}`;
  return `${KEY_PREFIX}${payload}.${keyMac(secret, payload)}`;
}

/** Whether an idempotency key has the card prefix, so the server must check it before sending. */
export function isSendConfirmationKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX);
}

/**
 * Reads a send confirmation key. Returns undefined for any other idempotency key, and `invalid` for a key with
 * the card prefix that this server did not sign or that expired.
 */
export function readSendConfirmationKey(
  secret: Uint8Array,
  key: string,
  now = Date.now(),
): { issuedAt: number; contentHash: string } | 'invalid' | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const parts = key.slice(KEY_PREFIX.length).split('.');
  if (parts.length !== 3) return 'invalid';
  const [time, contentHash, mac] = parts as [string, string, string];
  const expected = Buffer.from(keyMac(secret, `${time}.${contentHash}`));
  const received = Buffer.from(mac);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return 'invalid';
  const issuedAt = parseInt(time, 36);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > SEND_CONFIRMATION_KEY_TTL_MS)
    return 'invalid';
  return { issuedAt, contentHash };
}
