import { describe, expect, it } from 'vitest';
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
  SEND_CONFIRMATION_HTML,
  SEND_CONFIRMATION_MAX_BODY_CHARS,
  SEND_CONFIRMATION_MAX_IMAGE_CHARS,
  SEND_CONFIRMATION_RESOURCE,
  SEND_CONFIRMATION_RESOURCE_URI,
  SEND_CONFIRMATION_RESULT_META_KEY,
  SEND_CONFIRMATION_SEND_TOOL,
  SEND_CONFIRMATION_TOOL,
  SEND_CONFIRMATION_TOOL_META,
  SHARED_TOOL_NAMES,
  SEND_CONFIRMATION_KEY_TTL_MS,
  clientSupportsMcpApps,
  isSendConfirmationKey,
  issueSendConfirmationKey,
  readSendConfirmationKey,
  sendConfirmationContentHash,
  sendConfirmationMatchHash,
  sendConfirmationResourceContents,
  sendConfirmationResultMeta,
} from '../src/mcp/index.js';

describe('send confirmation app metadata', () => {
  it('links a shared tool to a ui:// MCP Apps resource', () => {
    expect(SEND_CONFIRMATION_RESOURCE_URI).toMatch(/^ui:\/\//);
    expect(MCP_APPS_MIME_TYPE).toBe('text/html;profile=mcp-app');
    expect(MCP_APPS_EXTENSION_ID).toBe('io.modelcontextprotocol/ui');
    expect(SHARED_TOOL_NAMES).toContain(SEND_CONFIRMATION_TOOL);
    expect(SHARED_TOOL_NAMES).toContain(SEND_CONFIRMATION_SEND_TOOL);
    expect(SEND_CONFIRMATION_TOOL_META).toEqual({
      ui: { resourceUri: SEND_CONFIRMATION_RESOURCE_URI },
      'ui/resourceUri': SEND_CONFIRMATION_RESOURCE_URI,
    });
  });

  it('declares that the card loads nothing remote', () => {
    const [contents] = sendConfirmationResourceContents();
    expect(contents).toEqual({
      uri: SEND_CONFIRMATION_RESOURCE_URI,
      mimeType: MCP_APPS_MIME_TYPE,
      text: SEND_CONFIRMATION_HTML,
      _meta: SEND_CONFIRMATION_RESOURCE._meta,
    });
    expect(SEND_CONFIRMATION_RESOURCE._meta.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(Object.keys(SEND_CONFIRMATION_RESOURCE._meta.ui)).not.toContain('permissions');
  });
});

describe('send confirmation HTML', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(SEND_CONFIRMATION_HTML)?.[1] ?? '';

  it('is one self-contained document', () => {
    expect(SEND_CONFIRMATION_HTML.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(SEND_CONFIRMATION_HTML).not.toMatch(/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i);
    expect(SEND_CONFIRMATION_HTML).not.toMatch(/<script[^>]+src|<link|@import|url\(/i);
    expect(SEND_CONFIRMATION_HTML.match(/<script/g)).toHaveLength(1);
  });

  it('restricts what the document may load on top of the host policy', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(SEND_CONFIRMATION_HTML)?.[1];
    expect(csp?.split('; ')).toEqual(
      expect.arrayContaining([
        "connect-src 'none'",
        'img-src data:',
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ]),
    );
  });

  it('offers one action and grows with the body instead of scrolling inside the card', () => {
    expect(SEND_CONFIRMATION_HTML.match(/<button/g)).toHaveLength(1);
    expect(SEND_CONFIRMATION_HTML).toContain('<button id="send"');
    expect(SEND_CONFIRMATION_HTML).not.toMatch(/max-height:\s*\d/);
  });

  it('keeps the Send icon when the label changes, and hides the footer until there is something in it', () => {
    expect(SEND_CONFIRMATION_HTML).toContain('<span id="send-label">Send</span>');
    expect(script).not.toMatch(/send\.textContent/);
    expect(SEND_CONFIRMATION_HTML).toContain('<footer id="actions" hidden>');
  });

  it('always shows the address a person is reached at, with or without a name', () => {
    expect(script).toContain("pill.appendChild(el('span', 'email', email));");
  });

  it('shows the plain-text part as well when it says something the formatted part does not', () => {
    const source = /(function words\(value\)[\s\S]*?)\/\/ Removes the outer margin/.exec(script)?.[1] ?? '';
    const textDiffers = new Function(`${source}; return textDiffers;`)() as (text: string, shown: string) => boolean;
    const shown = 'Hi Priya, The revised quote is attached. Details are on the quote page (quotes/8841).';
    expect(textDiffers('Hi Priya,\n\nThe revised quote is attached.', shown)).toBe(false);
    expect(textDiffers('hi priya - THE REVISED QUOTE is attached', shown)).toBe(false);
    expect(textDiffers('Hi Priya, the revised quote is attached. Wire the money today.', shown)).toBe(true);
    expect(textDiffers('quote quote quote', shown)).toBe(true);
    expect(textDiffers('Grüße aus Köln', 'Grüße aus Berlin')).toBe(true);
    expect(textDiffers('', shown)).toBe(false);
    expect(script).toContain("if (rendered && text && textDiffers(text, rendered.textContent || '')) {");
  });

  it('falls back to the text part when the formatting shows nothing', () => {
    expect(script).toContain(
      "if (rendered && !(rendered.textContent || '').trim() && !rendered.querySelector('img')) rendered = null;",
    );
  });

  it('lists attachments above the body', () => {
    expect(script.indexOf("el('ul', 'attachments')")).toBeLessThan(script.indexOf("el('div', 'body-section')"));
  });

  it('shows the formatted body without a switch to plain text', () => {
    expect(script).not.toMatch(/Plain text|bodyMode/);
  });

  it('shows the outcome of a send in a banner with a short title', () => {
    expect(SEND_CONFIRMATION_HTML).toContain('<div id="outcome" role="status" hidden></div>');
    for (const title of ["title: 'Sent'", "title: 'Not sent'", "title: 'Couldn’t confirm the send'"])
      expect(script).toContain(title);
  });

  it('has a script that parses and never writes markup', () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(script).toContain(`'${SEND_CONFIRMATION_RESULT_META_KEY}'`);
    expect(script).toContain(`name: '${SEND_CONFIRMATION_SEND_TOOL}'`);
  });
});

describe('sendConfirmationResultMeta', () => {
  it('carries the key and the body under the card key', () => {
    expect(sendConfirmationResultMeta({ idempotencyKey: 'ui-1', body: { text: 'Hi', html: '<p>Hi</p>' } })).toEqual({
      [SEND_CONFIRMATION_RESULT_META_KEY]: {
        version: 1,
        idempotencyKey: 'ui-1',
        body: { text: 'Hi', html: '<p>Hi</p>' },
      },
    });
    expect(sendConfirmationResultMeta({ idempotencyKey: 'ui-1', body: {} })).toEqual({
      [SEND_CONFIRMATION_RESULT_META_KEY]: { version: 1, idempotencyKey: 'ui-1', body: {} },
    });
  });

  it('cuts long bodies without splitting a surrogate pair', () => {
    const text = 'a'.repeat(SEND_CONFIRMATION_MAX_BODY_CHARS - 1) + '😀' + 'tail';
    const meta = sendConfirmationResultMeta({ idempotencyKey: 'k', body: { text, html: 'x' } });
    const body = meta[SEND_CONFIRMATION_RESULT_META_KEY]!.body;
    expect(body.textTruncated).toBe(true);
    expect(body.text).toBe('a'.repeat(SEND_CONFIRMATION_MAX_BODY_CHARS - 1));
    expect(body.htmlTruncated).toBeUndefined();
  });
});

describe('inline images', () => {
  const png = Buffer.from('png bytes').toString('base64');
  const meta = (
    inlineImages: Array<{ contentId?: string; mimeType: string; content: string }>,
    html = '<img src="cid:a">',
  ) =>
    sendConfirmationResultMeta({ idempotencyKey: 'k', body: { html }, inlineImages })[
      SEND_CONFIRMATION_RESULT_META_KEY
    ]!.body;

  it('passes raster images with a Content-ID as data: URLs', () => {
    expect(
      meta([
        { contentId: 'a', mimeType: 'image/png', content: png },
        { mimeType: 'image/png', content: png },
      ]),
    ).toEqual({ html: '<img src="cid:a">', inlineImages: { a: `data:image/png;base64,${png}` } });
  });

  it('leaves out other types, bad base64 and images over the limits', () => {
    const big = 'A'.repeat(SEND_CONFIRMATION_MAX_IMAGE_CHARS + 4);
    expect(
      meta([
        { contentId: 'svg', mimeType: 'image/svg+xml', content: png },
        { contentId: 'bad', mimeType: 'image/png', content: 'not base64!' },
        { contentId: 'big', mimeType: 'image/png', content: big },
      ]),
    ).toEqual({ html: '<img src="cid:a">', inlineImagesOmitted: 3 });
    const near = 'A'.repeat(SEND_CONFIRMATION_MAX_IMAGE_CHARS);
    const many = meta(
      Array.from({ length: 5 }, (_, index) => ({ contentId: `i${index}`, mimeType: 'image/jpeg', content: near })),
    );
    expect(Object.keys(many.inlineImages ?? {})).toHaveLength(4);
    expect(many.inlineImagesOmitted).toBe(1);
  });

  it('keys images by their Content-ID without angle brackets', () => {
    expect(meta([{ contentId: '<a>', mimeType: 'image/png', content: png }]).inlineImages).toEqual({
      a: `data:image/png;base64,${png}`,
    });
  });

  it('sends no images for a body without HTML', () => {
    expect(meta([{ contentId: 'a', mimeType: 'image/png', content: png }], '')).toEqual({});
  });
});

describe('clientSupportsMcpApps', () => {
  it('reads the declared extension', () => {
    expect(
      clientSupportsMcpApps({ extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] } } }),
    ).toBe(true);
    expect(clientSupportsMcpApps({})).toBe(false);
    expect(clientSupportsMcpApps({ extensions: { [MCP_APPS_EXTENSION_ID]: {} } })).toBe(false);
    expect(clientSupportsMcpApps({ extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ['text/html'] } } })).toBe(
      false,
    );
  });

  it('reports unknown capabilities as undefined', () => {
    expect(clientSupportsMcpApps(undefined)).toBeUndefined();
    expect(clientSupportsMcpApps(null)).toBeUndefined();
  });
});

describe('send confirmation keys', () => {
  const secret = Buffer.alloc(32, 7);
  const message = {
    from: 'me@example.com',
    to: [{ email: 'ann@example.com', name: 'Ann' }],
    cc: [],
    bcc: [],
    subject: 'Hi',
    attachments: [{ filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 2 }],
    body: { text: 'Hello' },
  };

  it('binds the message and the preview time and round-trips', () => {
    const hash = sendConfirmationContentHash(message);
    const key = issueSendConfirmationKey(secret, hash, 1_000_000);
    expect(key).toMatch(/^fxui1\.[0-9a-z]+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(key.length).toBeLessThanOrEqual(255);
    expect(readSendConfirmationKey(secret, key, 1_000_000 + 1000)).toEqual({ issuedAt: 1_000_000, contentHash: hash });
  });

  it('changes the hash when anything the user saw changes', () => {
    const hash = sendConfirmationContentHash(message);
    for (const changed of [
      { ...message, to: [{ email: 'bob@example.com' }] },
      { ...message, bcc: [{ email: 'spy@example.com' }] },
      { ...message, subject: 'Hi!' },
      { ...message, body: { text: 'Hello', html: '<p>Hello</p>' } },
      { ...message, attachments: [] },
    ])
      expect(sendConfirmationContentHash(changed)).not.toBe(hash);
  });

  it('matches deliveries by recipients and subject, whatever the body or the field a recipient is in', () => {
    const match = sendConfirmationMatchHash(secret, message);
    expect(match).toMatch(/^[A-Za-z0-9_-]{22}$/);
    for (const same of [
      { ...message, body: { text: 'Reworded' }, attachments: [] },
      { ...message, to: [], cc: [{ email: ' ANN@example.com ' }] },
      { ...message, to: [...message.to, ...message.to], subject: '  hi ' },
    ])
      expect(sendConfirmationMatchHash(secret, same)).toBe(match);
    for (const other of [
      { ...message, to: [{ email: 'bob@example.com' }] },
      { ...message, bcc: [{ email: 'bob@example.com' }] },
      { ...message, subject: 'Hi again' },
    ])
      expect(sendConfirmationMatchHash(secret, other)).not.toBe(match);
    expect(sendConfirmationMatchHash(Buffer.alloc(32, 8), message)).not.toBe(match);
  });

  it('ignores other keys and refuses forged, foreign or expired card keys', () => {
    const key = issueSendConfirmationKey(secret, 'hash', 1_000_000);
    expect(readSendConfirmationKey(secret, 'model-key', 1_000_000)).toBeUndefined();
    expect(isSendConfirmationKey('model-key')).toBe(false);
    expect(isSendConfirmationKey(key)).toBe(true);
    expect(readSendConfirmationKey(Buffer.alloc(32, 8), key, 1_000_000)).toBe('invalid');
    expect(readSendConfirmationKey(secret, key.replace('.hash.', '.hasH.'), 1_000_000)).toBe('invalid');
    expect(readSendConfirmationKey(secret, 'fxui1.garbage', 1_000_000)).toBe('invalid');
    expect(readSendConfirmationKey(secret, key, 1_000_000 + SEND_CONFIRMATION_KEY_TTL_MS + 1)).toBe('invalid');
  });
});
