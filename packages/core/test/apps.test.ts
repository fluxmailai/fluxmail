import { describe, expect, it } from 'vitest';
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
  MESSAGE_READER_HTML,
  MESSAGE_READER_MAX_HTML_CHARS,
  MESSAGE_READER_MAX_INLINE_IMAGES,
  MESSAGE_READER_RESOURCE,
  MESSAGE_READER_RESOURCE_URI,
  MESSAGE_READER_RESULT_META_KEY,
  MESSAGE_READER_TOOL,
  MESSAGE_READER_TOOL_META,
  messageReaderInlineImages,
  messageReaderResourceContents,
  messageReaderResultMeta,
  selectBody,
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
  sendConfirmationResourceContents,
  sendConfirmationResultMeta,
} from '../src/mcp/index.js';
import { VIEW_KIT_SCRIPT } from '../src/mcp/viewKit.js';
import { createMailHtmlRenderer } from '../src/mailHtml/index.js';

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

describe('message reader app metadata', () => {
  it('links get_email to a versioned ui:// resource that loads nothing remote', () => {
    expect(MESSAGE_READER_RESOURCE_URI).toBe('ui://fluxmail/message-reader-v1.html');
    expect(SHARED_TOOL_NAMES).toContain(MESSAGE_READER_TOOL);
    expect(MESSAGE_READER_TOOL_META).toEqual({
      ui: { resourceUri: MESSAGE_READER_RESOURCE_URI },
      'ui/resourceUri': MESSAGE_READER_RESOURCE_URI,
    });
    expect(messageReaderResourceContents()).toEqual([
      {
        uri: MESSAGE_READER_RESOURCE_URI,
        mimeType: MCP_APPS_MIME_TYPE,
        text: MESSAGE_READER_HTML,
        _meta: MESSAGE_READER_RESOURCE._meta,
      },
    ]);
    expect(MESSAGE_READER_RESOURCE._meta.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(Object.keys(MESSAGE_READER_RESOURCE._meta.ui)).not.toContain('permissions');
  });
});

describe('message reader HTML', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(MESSAGE_READER_HTML)?.[1] ?? '';

  it('is one self-contained, read-only document', () => {
    expect(MESSAGE_READER_HTML.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(MESSAGE_READER_HTML).not.toMatch(/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i);
    expect(MESSAGE_READER_HTML).not.toMatch(/<script[^>]+src|<link|@import|url\(/i);
    expect(MESSAGE_READER_HTML.match(/<script/g)).toHaveLength(1);
    expect(MESSAGE_READER_HTML).not.toMatch(/<button|<form|<input/);
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(MESSAGE_READER_HTML)?.[1];
    expect(csp?.split('; ')).toEqual(
      expect.arrayContaining(["connect-src 'none'", 'img-src data:', "font-src 'none'", "form-action 'none'"]),
    );
  });

  it('has a script that parses, never writes markup and calls no tools', () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(script).not.toContain('tools/call');
    expect(script).toContain(`'${MESSAGE_READER_RESULT_META_KEY}'`);
    expect(script).toContain("'ui/open-link'");
    expect(script).toContain("mode: 'received'");
  });

  it('keeps working when a build tool wraps the renderer in __name calls', () => {
    const source = createMailHtmlRenderer.toString().replace('function has(', '__name(has, "has");\n  function has(');
    const kit = VIEW_KIT_SCRIPT.slice(0, VIEW_KIT_SCRIPT.indexOf('var createMailHtmlRenderer'));
    expect(kit).toContain('var __name = function (target) { return target; };');
    const factory = new Function(`${kit} return (${source});`)() as typeof createMailHtmlRenderer;
    expect(factory({} as never, class {} as never).linkTarget('https://example.com')).toBe('https://example.com/');
  });

  it('shares the renderer and the bridge with the send card', () => {
    for (const html of [MESSAGE_READER_HTML, SEND_CONFIRMATION_HTML]) {
      expect(html).toContain(createMailHtmlRenderer.toString());
      expect(html).toContain(VIEW_KIT_SCRIPT);
    }
  });
});

describe('messageReaderResultMeta', () => {
  const message = { body: { text: 'Hi there', html: '<p>Hi there</p>' } };

  it('repeats no body part the result already carries in full', () => {
    const returned = selectBody(
      {
        ...message,
        id: 'm',
        threadId: 't',
        accountId: 'a',
        to: [],
        subject: '',
        date: '',
        flags: { read: true, starred: false, draft: false },
      },
      'both',
    );
    expect(messageReaderResultMeta({ message, returned })).toEqual({
      [MESSAGE_READER_RESULT_META_KEY]: { version: 1, body: {} },
    });
  });

  it('adds parts the result cut or left out, within the reader limits', () => {
    const html = '<p>' + 'a'.repeat(MESSAGE_READER_MAX_HTML_CHARS) + '</p>';
    const meta = messageReaderResultMeta({
      message: { body: { text: 'Hi', html } },
      returned: {
        body: { text: 'Hi', html: html.slice(0, 10) },
        bodyTruncation: { text: { totalChars: 2 }, html: { totalChars: html.length, nextOffset: 10 } },
      },
    })[MESSAGE_READER_RESULT_META_KEY]!;
    expect(meta.body.text).toBeUndefined();
    expect(meta.body.html).toHaveLength(MESSAGE_READER_MAX_HTML_CHARS);
    expect(meta.body.htmlTruncated).toBe(true);
    const none = messageReaderResultMeta({ message, returned: { body: undefined } })[MESSAGE_READER_RESULT_META_KEY]!;
    expect(none.body).toEqual({ text: 'Hi there', html: '<p>Hi there</p>' });
  });

  it('adds no body parts when the client did not declare MCP Apps support', () => {
    const html = '<p>' + 'a'.repeat(60_000) + '</p>';
    const meta = messageReaderResultMeta({
      message: { body: { text: 'Hi', html } },
      returned: { body: undefined },
      includeBody: false,
    })[MESSAGE_READER_RESULT_META_KEY]!;
    expect(meta).toEqual({ version: 1, body: {} });
  });

  it('picks only referenced inline images of card types within the limits', () => {
    const attachments = [
      { id: '1', filename: 'a.png', mimeType: 'image/png', sizeBytes: 10, contentId: 'a@x' },
      { id: '2', filename: 'b.svg', mimeType: 'image/svg+xml', sizeBytes: 10, contentId: 'b@x' },
      { id: '3', filename: 'c.png', mimeType: 'image/png', sizeBytes: 10, contentId: 'c@x' },
      { id: '4', filename: 'd.jpg', mimeType: 'image/jpeg', sizeBytes: 10_000_000, contentId: 'd@x' },
      { id: '5', filename: 'e.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
    ];
    const html = '<img src="cid:a@x"><img src="cid:b@x"><img src="cid:d@x"><img src="cid:C@X">';
    expect(messageReaderInlineImages({ body: { html }, attachments })).toEqual([
      { id: '1', contentId: 'a@x', mimeType: 'image/png' },
    ]);
    expect(messageReaderInlineImages({ body: { text: 'x' }, attachments })).toEqual([]);
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      filename: `${index}.png`,
      mimeType: 'image/png',
      sizeBytes: 10,
      contentId: `i${index}@x`,
    }));
    const manyHtml = many.map((image) => `<img src="cid:${image.contentId}">`).join('');
    expect(messageReaderInlineImages({ body: { html: manyHtml }, attachments: many })).toHaveLength(
      MESSAGE_READER_MAX_INLINE_IMAGES,
    );
  });
});
