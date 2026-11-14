import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  SEND_CONFIRMATION_HTML,
  SEND_CONFIRMATION_MAX_BODY_CHARS,
  SEND_CONFIRMATION_RESULT_META_KEY,
} from './sendConfirmationView.js';

export { SEND_CONFIRMATION_HTML, SEND_CONFIRMATION_MAX_BODY_CHARS, SEND_CONFIRMATION_RESULT_META_KEY };

/** The MCP Apps extension identifier clients advertise under `capabilities.extensions`. */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
/** The MIME type of an MCP Apps HTML view. */
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';

/** Version the URI with the view: hosts may cache a resource by its URI. */
export const SEND_CONFIRMATION_RESOURCE_URI = 'ui://fluxmail/send-confirmation-v2.html';
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

function bounded(value: string | undefined): { value?: string; truncated?: boolean } {
  if (!value) return {};
  if (value.length <= SEND_CONFIRMATION_MAX_BODY_CHARS) return { value };
  let end = SEND_CONFIRMATION_MAX_BODY_CHARS;
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

/**
 * A keyed digest of who an email goes to and its subject, stored with each delivery. A card is refused only when
 * a later send from the same mailbox has the same digest, so the assistant sending the previewed email in its own
 * words still blocks the card and an unrelated email doesn't. To, Cc and Bcc count as one set, and the subject
 * ignores case and spacing.
 */
export function sendConfirmationMatchHash(
  secret: Uint8Array,
  message: Pick<SendConfirmationMessage, 'to' | 'cc' | 'bcc' | 'subject'>,
): string {
  const recipients = [
    ...new Set([...message.to, ...message.cc, ...message.bcc].map((address) => address.email.trim().toLowerCase())),
  ].sort();
  const subject = message.subject.trim().replace(/\s+/g, ' ').toLowerCase();
  return base64url(
    createHmac('sha256', secret)
      .update(`fluxmail send confirmation match\0${JSON.stringify([recipients, subject])}`)
      .digest()
      .subarray(0, 16),
  );
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
