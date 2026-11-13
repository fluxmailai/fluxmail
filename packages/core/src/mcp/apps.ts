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
  title: 'Email preview',
  description: 'Shows an email exactly as it will be sent, with Send and Edit buttons.',
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
  /** The key the card sends with, so a double click, retry or re-render delivers once. */
  idempotencyKey: string;
  /** The body as it will be sent, each part cut to SEND_CONFIRMATION_MAX_BODY_CHARS. */
  body: { text?: string; html?: string; textTruncated?: boolean; htmlTruncated?: boolean };
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
}): Record<string, SendConfirmationData> {
  const text = bounded(input.body.text);
  const html = bounded(input.body.html);
  return {
    [SEND_CONFIRMATION_RESULT_META_KEY]: {
      version: 1,
      idempotencyKey: input.idempotencyKey,
      body: {
        ...(text.value !== undefined ? { text: text.value } : {}),
        ...(text.truncated ? { textTruncated: true } : {}),
        ...(html.value !== undefined ? { html: html.value } : {}),
        ...(html.truncated ? { htmlTruncated: true } : {}),
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
