/**
 * The send confirmation card: one self-contained HTML document for MCP Apps hosts. It loads nothing remote,
 * builds every piece of mail content with DOM APIs (never innerHTML), and rebuilds an HTML body from an
 * allowlist after parsing it inertly. The script speaks the MCP Apps postMessage protocol directly, so it needs
 * no SDK bundle.
 *
 * Keep the script free of backticks and template placeholders: it lives inside this module's template literal.
 */

/** The key a preview_send result's `_meta` uses for the card's data. Mirrored in the script below. */
export const SEND_CONFIRMATION_RESULT_META_KEY = 'ai.fluxmail/send-confirmation';

/** Characters of each body part the card receives. */
export const SEND_CONFIRMATION_MAX_BODY_CHARS = 50_000;

const STYLE = `
:root {
  color-scheme: light dark;
  --color-background-primary: light-dark(#ffffff, #1c1c1c);
  --color-background-secondary: light-dark(#f5f5f4, #262626);
  --color-text-primary: light-dark(#1c1917, #f5f5f4);
  --color-text-secondary: light-dark(#57534e, #a8a29e);
  --color-text-danger: light-dark(#b91c1c, #f87171);
  --color-text-success: light-dark(#15803d, #4ade80);
  --color-text-warning: light-dark(#a16207, #facc15);
  --color-text-inverse: light-dark(#ffffff, #1c1917);
  --color-background-inverse: light-dark(#1c1917, #f5f5f4);
  --color-border-primary: light-dark(#d6d3d1, #44403c);
  --color-border-secondary: light-dark(#e7e5e4, #333333);
  --color-ring-primary: light-dark(#2563eb, #60a5fa);
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-text-sm-size: 13px;
  --font-text-md-size: 14px;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
  --border-width-regular: 1px;
}
* { box-sizing: border-box; }
/* Only the body box may scroll sideways; the card itself never shows a horizontal scrollbar. */
html, body { margin: 0; padding: 0; overflow-x: hidden; }
body {
  background: var(--color-background-primary);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-text-md-size);
  line-height: 1.45;
  overflow-wrap: anywhere;
}
main { padding: 14px 16px 0; display: flex; flex-direction: column; gap: 12px; }
h1 { font-size: 15px; font-weight: var(--font-weight-semibold); margin: 0; }
.fields { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.fields dt { color: var(--color-text-secondary); font-size: var(--font-text-sm-size); padding-top: 1px; }
.fields dd { margin: 0; min-width: 0; }
.fields .subject { font-weight: var(--font-weight-semibold); }
.addr { display: inline; }
.addr + .addr::before { content: ", "; color: var(--color-text-secondary); }
.muted { color: var(--color-text-secondary); }
.attachments { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.attachments .size { color: var(--color-text-secondary); font-size: var(--font-text-sm-size); margin-left: 6px; }
.body-box {
  /* The card grows with the body instead of scrolling inside the conversation; only wide tables scroll sideways. */
  overflow-x: auto;
}
.body-section { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
/* The body reads as the email itself: a divider under the header fields, no box. */
.body-section { border-top: var(--border-width-regular) solid var(--color-border-secondary); padding-top: 12px; }
.body-text { white-space: pre-wrap; margin: 0; font-family: inherit; }
/* A plain-text body can be edited in place: click it to get a text box. */
.body-box.editable { cursor: text; border-radius: var(--border-radius-md); margin: -6px -8px; padding: 6px 8px; }
.body-box.editable:hover { background: var(--color-background-secondary); }
.body-box.editable:focus-visible { outline: 2px solid var(--color-ring-primary); outline-offset: 0; }
.body-box.editing { background: var(--color-background-secondary); outline: 2px solid var(--color-ring-primary); }
/* The text box sits exactly where the text was, so nothing moves when editing starts. */
.body-editor {
  display: block; box-sizing: border-box; width: 100%; margin: 0; padding: 0; border: 0;
  font: inherit; line-height: inherit; color: inherit; background: transparent; resize: none; overflow: hidden;
}
.body-editor:focus { outline: none; }
.body-html img { max-width: 100%; height: auto; }
.body-html table { border-collapse: collapse; max-width: 100%; }
.body-html td, .body-html th { padding: 2px 4px; vertical-align: top; }
.body-html blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--color-border-primary); color: var(--color-text-secondary); }
.body-html pre, .body-html code { font-family: var(--font-mono); white-space: pre-wrap; }
.body-html .link { text-decoration: underline; }
.body-html .href { color: var(--color-text-secondary); font-size: var(--font-text-sm-size); }
/* Formatted mail keeps the sender's colors, so it renders on a light page. In a light host the page blends in. */
.body-box.paper { background: #ffffff; color: #1c1917; color-scheme: light; border-radius: var(--border-radius-md); padding: 10px 12px; }
.paper .placeholder, .paper .body-html .href { color: #57534e; }
.paper .body-html blockquote { color: #57534e; border-left-color: #d6d3d1; }
.placeholder { color: var(--color-text-secondary); font-style: italic; }
.conditional { border-left: 3px dashed var(--color-border-primary); padding-left: 8px; margin: 6px 0; }
.toggle { display: flex; gap: 4px; }
.toggle button { font-size: var(--font-text-sm-size); padding: 2px 8px; }
.toggle button[aria-pressed="true"] { background: var(--color-background-secondary); }
.note { font-size: var(--font-text-sm-size); color: var(--color-text-secondary); margin: 0; }
/* Send stays in view when the host caps the card's height and the card scrolls. */
footer {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px;
  position: sticky; bottom: 0; background: var(--color-background-primary);
  padding: 8px 0 calc(14px + var(--safe-area-bottom, 0px));
}
footer .status { margin-right: auto; font-size: var(--font-text-sm-size); }
.status.error, .error-text { color: var(--color-text-danger); }
.status.success { color: var(--color-text-success); }
.status.warning { color: var(--color-text-warning); }
button {
  font: inherit;
  color: var(--color-text-primary);
  background: var(--color-background-primary);
  border: var(--border-width-regular) solid var(--color-border-primary);
  border-radius: var(--border-radius-md);
  padding: 6px 14px;
  cursor: pointer;
}
button.primary {
  background: var(--color-background-inverse);
  color: var(--color-text-inverse);
  border-color: var(--color-background-inverse);
  font-weight: var(--font-weight-medium);
}
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible { outline: 2px solid var(--color-ring-primary); outline-offset: 2px; }
[hidden] { display: none !important; }
@media (max-width: 360px) {
  .fields { grid-template-columns: 1fr; gap: 0; }
  .fields dd { margin-bottom: 6px; }
  footer button { flex: 1; }
}
`;

const SCRIPT = `
(function () {
  'use strict';
  var META_KEY = 'ai.fluxmail/send-confirmation';
  var PROTOCOL_VERSION = '2026-01-26';
  var MAX_NODES = 20000;
  var MAX_DEPTH = 64;
  var nextId = 1;
  var pending = {};
  var state = {
    input: null, preview: null, card: null, phase: 'waiting', bodyMode: 'html',
    editing: false, draftText: '', editError: '', sendAfterPreview: false
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function str(value) { return typeof value === 'string' ? value : ''; }

  function post(message) { window.parent.postMessage(message, '*'); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: '2.0', id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function respond(id, result) { post({ jsonrpc: '2.0', id: id, result: result }); }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!isObject(message) || message.jsonrpc !== '2.0') return;
    if (message.method === undefined && (typeof message.id === 'number') && pending[message.id]) {
      var waiter = pending[message.id];
      delete pending[message.id];
      if (message.error) waiter.reject(message.error);
      else waiter.resolve(message.result);
      return;
    }
    var params = isObject(message.params) ? message.params : {};
    switch (message.method) {
      case 'ui/notifications/tool-input':
        state.input = isObject(params.arguments) ? params.arguments : null;
        render();
        break;
      case 'ui/notifications/tool-result':
        receiveResult(params);
        break;
      case 'ui/notifications/tool-cancelled':
        if (!state.preview) { state.phase = 'cancelled'; render(); }
        break;
      case 'ui/notifications/host-context-changed':
        applyHostContext(params);
        break;
      case 'ui/resource-teardown':
        if (message.id !== undefined) respond(message.id, {});
        break;
      case 'ping':
        if (message.id !== undefined) respond(message.id, {});
        break;
      default:
        if (message.id !== undefined && message.method !== undefined) {
          post({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        }
    }
  });

  function applyHostContext(context) {
    if (!isObject(context)) return;
    var root = document.documentElement;
    if (context.theme === 'light' || context.theme === 'dark') {
      root.setAttribute('data-theme', context.theme);
      root.style.colorScheme = context.theme;
    }
    var styles = isObject(context.styles) ? context.styles : {};
    var variables = isObject(styles.variables) ? styles.variables : {};
    Object.keys(variables).forEach(function (name) {
      var value = variables[name];
      if (/^--[a-z0-9-]+$/.test(name) && typeof value === 'string') root.style.setProperty(name, value);
    });
    // Keep Send clear of the device's bottom inset on mobile hosts.
    var insets = isObject(context.safeAreaInsets) ? context.safeAreaInsets : null;
    if (insets && typeof insets.bottom === 'number' && insets.bottom >= 0 && insets.bottom <= 200) {
      root.style.setProperty('--safe-area-bottom', insets.bottom + 'px');
    }
    var dims = isObject(context.containerDimensions) ? context.containerDimensions : null;
    if (dims) {
      if (typeof dims.maxHeight === 'number') {
        root.style.maxHeight = dims.maxHeight + 'px';
        root.style.overflowY = 'auto';
        root.style.overflowX = 'hidden';
      }
      if (typeof dims.height === 'number') {
        root.style.height = '100vh';
        root.style.overflowY = 'auto';
        root.style.overflowX = 'hidden';
      }
      if (typeof dims.maxWidth === 'number') root.style.maxWidth = dims.maxWidth + 'px';
    }
  }

  // Takes a preview_send result: the preview fields, and the body and send key in _meta.
  function applyPreview(result) {
    var structured = isObject(result.structuredContent) ? result.structuredContent : {};
    var data = isObject(structured.data) ? structured.data : null;
    var meta = isObject(result._meta) ? result._meta[META_KEY] : null;
    state.preview = data;
    state.card = isObject(meta) && meta.version === 1 && typeof meta.idempotencyKey === 'string' ? meta : null;
    state.bodyMode = state.card && state.card.body && str(state.card.body.html) ? 'html' : 'text';
  }
  function receiveResult(result) {
    if (result.isError) { state.phase = 'preview-error'; render(); return; }
    applyPreview(result);
    if (state.phase === 'waiting' || state.phase === 'cancelled') state.phase = 'ready';
    render();
  }

  // The body can be edited when it is the plain text the assistant wrote: not HTML and not a saved draft.
  function canEdit() {
    var input = state.input;
    return !!(input && state.card && typeof input.bodyText === 'string' && !str(input.bodyHtml) && !input.draftId &&
      (state.phase === 'ready' || state.phase === 'retry'));
  }
  function startEdit() {
    if (!canEdit() || state.editing) return;
    state.editing = true;
    state.editError = '';
    state.draftText = state.input.bodyText;
    render();
    var editor = $('editor');
    if (editor) { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); }
  }
  function cancelEdit() {
    state.editing = false;
    state.sendAfterPreview = false;
    render();
  }
  function finishEdit() {
    if (!state.editing) return;
    state.editing = false;
    if (state.draftText === state.input.bodyText) {
      state.sendAfterPreview = false;
      render();
      return;
    }
    previewEdited(state.draftText);
  }
  // Previews the edited email again, so the card shows what will be sent and gets a send key for that content.
  function previewEdited(text) {
    var args = {};
    Object.keys(state.input).forEach(function (key) { args[key] = state.input[key]; });
    args.bodyText = text;
    state.phase = 'previewing';
    render();
    request('tools/call', { name: 'preview_send', arguments: args }).then(function (result) {
      result = isObject(result) ? result : {};
      var meta = isObject(result._meta) ? result._meta[META_KEY] : null;
      if (result.isError || !isObject(meta)) {
        var error = toolError(result);
        state.phase = 'ready';
        state.editing = true;
        state.sendAfterPreview = false;
        state.editError = 'Fluxmail could not update the preview' + (error.message ? ': ' + error.message : '.');
        render();
        return;
      }
      state.input = args;
      applyPreview(result);
      state.phase = 'ready';
      state.editError = '';
      render();
      request('ui/update-model-context', {
        content: [{ type: 'text', text: 'The user edited the email body in the Fluxmail preview card. It now reads:\\n\\n' + text }]
      }).catch(function () {});
      if (state.sendAfterPreview) { state.sendAfterPreview = false; onSend(); }
    }, function (error) {
      state.phase = 'ready';
      state.editing = true;
      state.sendAfterPreview = false;
      state.editError = 'Fluxmail could not update the preview' + (isObject(error) && str(error.message) ? ': ' + error.message : '.');
      render();
    });
  }
  function editorFor() {
    var editor = document.createElement('textarea');
    editor.id = 'editor';
    editor.className = 'body-editor';
    editor.setAttribute('aria-label', 'Message body');
    editor.value = state.draftText;
    function fit() { editor.style.height = 'auto'; editor.style.height = editor.scrollHeight + 'px'; }
    editor.addEventListener('input', function () { state.draftText = editor.value; fit(); });
    editor.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finishEdit(); }
    });
    editor.addEventListener('blur', finishEdit);
    requestAnimationFrame(fit);
    return editor;
  }

  function addressText(address) {
    if (!isObject(address)) return '';
    var email = str(address.email);
    var name = str(address.name);
    return name && name !== email ? name + ' <' + email + '>' : email;
  }
  function addresses(list) {
    var dd = el('dd');
    (Array.isArray(list) ? list : []).forEach(function (address) { dd.appendChild(el('span', 'addr', addressText(address))); });
    return dd;
  }
  function sizeLabel(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  var KEEP = ' a abbr b bdi bdo big blockquote br caption cite code col colgroup dd del dfn div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong sub sup table tbody td tfoot th thead tr tt u ul var ';
  // Elements whose content no mail app shows.
  var SKIP = ' base head link meta script style template title ';
  // Elements shown as a placeholder because the card does not embed them.
  var EMBEDDED = ' applet audio canvas embed frame frameset iframe math object svg video ';
  // Containers mail apps lay out as blocks; the card shows them as plain blocks.
  var BLOCKS = ' address article aside center details dialog fieldset figcaption figure footer form header hgroup legend main nav noscript section summary ';
  var SAFE_IMAGE = /^data:image\\/(png|gif|jpe?g|webp);base64,[a-z0-9+\\/=\\s]+$/i;
  var CONDITIONAL = /^\\s*\\[if[^\\]]*\\]>([\\s\\S]*)<!\\[endif\\]\\s*$/i;

  function clipped(url) { return url.length > 200 ? url.slice(0, 200) + '...' : url; }
  function sanitizedHtml(html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var out = document.createDocumentFragment();
    var budget = { nodes: 0 };
    copyChildren(parsed.body, out, 0, budget);
    // Conditional comments before <body> still reach Outlook.
    copyConditionals(parsed.head, out, budget);
    if (budget.nodes > MAX_NODES) out.appendChild(el('p', 'placeholder', 'The rest of the formatted body is too long to show here.'));
    return out;
  }
  function copyConditionals(from, to, budget) {
    for (var child = from.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 8) copyComment(child, to, 0, budget);
    }
  }
  function copyComment(node, to, depth, budget) {
    var match = CONDITIONAL.exec(node.nodeValue || '');
    if (!match || !match[1].trim()) return;
    var box = el('div', 'conditional');
    box.appendChild(el('div', 'placeholder', 'Shown only in some mail apps:'));
    var inner = new DOMParser().parseFromString(match[1], 'text/html');
    copyChildren(inner.body, box, depth + 1, budget);
    to.appendChild(box);
  }
  function copyChildren(from, to, depth, budget) {
    for (var child = from.firstChild; child; child = child.nextSibling) {
      if (++budget.nodes > MAX_NODES) return;
      if (child.nodeType === 3) { to.appendChild(document.createTextNode(child.nodeValue || '')); continue; }
      if (child.nodeType === 8) { copyComment(child, to, depth, budget); continue; }
      if (child.nodeType !== 1) continue;
      var tag = child.localName.toLowerCase();
      if (SKIP.indexOf(' ' + tag + ' ') >= 0) continue;
      if (depth >= MAX_DEPTH) { to.appendChild(document.createTextNode(child.textContent || '')); continue; }
      if (EMBEDDED.indexOf(' ' + tag + ' ') >= 0) {
        to.appendChild(el('span', 'placeholder', '[Embedded ' + tag + ' not shown]'));
        if (tag === 'object' || tag === 'video' || tag === 'audio' || tag === 'applet') copyChildren(child, to, depth + 1, budget);
        continue;
      }
      if (tag === 'img') { to.appendChild(imageFor(child)); continue; }
      if (tag === 'input') {
        var value = child.getAttribute('value') || child.getAttribute('placeholder') || '';
        to.appendChild(el('span', 'placeholder', '[Field' + (value ? ': ' + value.slice(0, 200) : '') + ']'));
        continue;
      }
      if (tag === 'a') {
        var link = el('span', 'link');
        copyChildren(child, link, depth + 1, budget);
        to.appendChild(link);
        var href = (child.getAttribute('href') || '').trim();
        if (href && href !== (link.textContent || '').trim() && !/^(javascript|data|vbscript):/i.test(href)) {
          to.appendChild(el('span', 'href', ' (' + clipped(href) + ')'));
        }
        continue;
      }
      var name = BLOCKS.indexOf(' ' + tag + ' ') >= 0 ? 'div'
        : KEEP.indexOf(' ' + tag + ' ') < 0 ? 'span'
        : tag === 'font' || tag === 'big' || tag === 'tt' ? 'span' : tag;
      var copy = document.createElement(name);
      if (tag === 'td' || tag === 'th') {
        ['colspan', 'rowspan'].forEach(function (attribute) {
          var span = parseInt(child.getAttribute(attribute) || '', 10);
          if (span > 1 && span <= 100) copy.setAttribute(attribute, String(span));
        });
      }
      applyStyles(child, copy, tag);
      copyChildren(child, copy, depth + 1, budget);
      to.appendChild(copy);
    }
  }

  // Text styling mail apps show, from a fixed list of properties with checked values. Layout, positioning,
  // visibility and anything that loads a resource are left out.
  var STYLE_PROPERTIES = ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration-line', 'text-align', 'font-size'];
  var FONT_SIZES = [0, 10, 13, 16, 18, 24, 32, 32];
  function styleValue(property, value) {
    value = String(value || '').trim().toLowerCase();
    if (!value || value.length > 64 || /[^a-z0-9#%(),.\\s-]/.test(value) || /url|expression|var|attr|image/.test(value)) return '';
    if (property === 'font-size') {
      var size = /^(\\d+(?:\\.\\d+)?)(px|pt)$/.exec(value);
      if (size) return Math.min(32, Math.max(10, parseFloat(size[1]) * (size[2] === 'pt' ? 4 / 3 : 1))) + 'px';
      return /^(x-small|small|medium|large|x-large)$/.test(value) ? value : '';
    }
    if (property === 'text-align') return /^(left|right|center|justify|start|end)$/.test(value) ? value : '';
    if (property === 'font-weight') return /^(normal|bold|bolder|lighter|[1-9]00)$/.test(value) ? value : '';
    if (property === 'font-style') return /^(normal|italic|oblique)$/.test(value) ? value : '';
    if (property === 'text-decoration-line') return /^(none|((underline|line-through|overline)\\s*)+)$/.test(value) ? value : '';
    return /^(#[0-9a-f]{3,8}|rgba?\\([0-9.,%\\s]+\\)|hsla?\\([0-9.,%\\sdeg]+\\)|[a-z]+)$/.test(value) ? value : '';
  }
  function setStyle(copy, property, value) {
    var safe = styleValue(property, value);
    if (safe) copy.style.setProperty(property, safe);
  }
  function applyStyles(node, copy, tag) {
    if (tag === 'font') {
      setStyle(copy, 'color', node.getAttribute('color'));
      var size = parseInt(node.getAttribute('size') || '', 10);
      if (size >= 1 && size <= 7) copy.style.setProperty('font-size', FONT_SIZES[size] + 'px');
    }
    if (node.hasAttribute('bgcolor')) setStyle(copy, 'background-color', node.getAttribute('bgcolor'));
    if (node.hasAttribute('align') && tag !== 'img' && tag !== 'table') setStyle(copy, 'text-align', node.getAttribute('align'));
    var declared = node.style;
    if (!declared) return;
    STYLE_PROPERTIES.forEach(function (property) { setStyle(copy, property, declared.getPropertyValue(property)); });
  }

  function inlineImage(src) {
    var images = state.card && isObject(state.card.body) && isObject(state.card.body.inlineImages) ? state.card.body.inlineImages : {};
    var id = src.slice(4).trim().replace(/^<|>$/g, '');
    try { id = decodeURIComponent(id); } catch (error) {}
    var url = Object.prototype.hasOwnProperty.call(images, id) ? images[id] : '';
    return typeof url === 'string' && SAFE_IMAGE.test(url) ? url : '';
  }
  function imageFor(node) {
    var src = (node.getAttribute('src') || '').trim();
    var alt = (node.getAttribute('alt') || '').slice(0, 200);
    if (/^cid:/i.test(src)) src = inlineImage(src) || src;
    if (SAFE_IMAGE.test(src)) {
      var img = document.createElement('img');
      img.alt = alt;
      img.src = src;
      return img;
    }
    var label = /^cid:/i.test(src) ? 'Inline image' : /^https?:/i.test(src) ? 'Image from ' + clipped(src) : 'Image';
    return el('span', 'placeholder', '[' + label + (alt ? ': ' + alt : '') + ']');
  }

  function renderBody(container) {
    var body = state.card && isObject(state.card.body) ? state.card.body : {};
    var text = str(body.text);
    var html = str(body.html);
    var section = el('div', 'body-section');
    container.appendChild(section);
    container = section;
    if (text && html) {
      var toggle = el('div', 'toggle');
      [['html', 'Formatted'], ['text', 'Plain text']].forEach(function (option) {
        var button = el('button', '', option[1]);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(state.bodyMode === option[0]));
        button.addEventListener('click', function () { state.bodyMode = option[0]; render(); });
        toggle.appendChild(button);
      });
      container.appendChild(toggle);
    }
    var box = el('div', 'body-box');
    box.setAttribute('aria-label', 'Message body');
    if (html && (state.bodyMode === 'html' || !text)) {
      box.className = 'body-box paper';
      var rendered = el('div', 'body-html');
      try { rendered.appendChild(sanitizedHtml(html)); } catch (error) { rendered = el('pre', 'body-text', text || ''); }
      box.appendChild(rendered);
    } else if (state.editing) {
      box.className = 'body-box editable editing';
      box.appendChild(editorFor());
    } else if (text) {
      box.appendChild(el('pre', 'body-text', text));
      if (canEdit()) {
        box.className = 'body-box editable';
        box.tabIndex = 0;
        box.setAttribute('role', 'button');
        box.setAttribute('aria-label', 'Message body. Click to edit.');
        box.title = 'Click to edit';
        box.addEventListener('click', startEdit);
        box.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startEdit(); }
        });
      }
    } else {
      box.appendChild(el('span', 'placeholder', 'No message body'));
    }
    container.appendChild(box);
    if (state.editing && state.input && state.input.replyToMessageId && state.input.quoteOriginal !== false) {
      container.appendChild(el('p', 'note', 'The original message is quoted below your text when sent.'));
    }
    if (state.editError) container.appendChild(el('p', 'note error-text', state.editError));
    var truncated = (html && state.bodyMode === 'html' ? body.htmlTruncated : body.textTruncated) === true;
    if (truncated) container.appendChild(el('p', 'note', 'This shows only the start of the body. Fluxmail sends all of it.'));
  }

  function render() {
    var content = $('content');
    var status = $('status');
    var send = $('send');
    clear(content);
    if (state.phase === 'waiting') { content.appendChild(el('p', 'muted', 'Preparing the preview...')); }
    else if (state.phase === 'cancelled') { content.appendChild(el('p', 'muted', 'The preview was canceled.')); }
    else if (state.phase === 'preview-error') { content.appendChild(el('p', 'muted', 'Fluxmail could not prepare this email. Ask the assistant to fix it.')); }
    if (state.preview) {
      var preview = state.preview;
      var fields = el('dl', 'fields');
      function row(label, value) { fields.appendChild(el('dt', '', label)); fields.appendChild(value); }
      row('From', el('dd', '', str(preview.from)));
      row('To', addresses(preview.to));
      if (Array.isArray(preview.cc) && preview.cc.length) row('Cc', addresses(preview.cc));
      if (Array.isArray(preview.bcc) && preview.bcc.length) row('Bcc', addresses(preview.bcc));
      var subject = str(preview.subject);
      row('Subject', el('dd', subject ? 'subject' : 'placeholder', subject || 'No subject'));
      var attachments = Array.isArray(preview.attachments) ? preview.attachments : [];
      if (attachments.length) {
        var list = el('ul', 'attachments');
        attachments.forEach(function (attachment) {
          var item = el('li', '', isObject(attachment) ? str(attachment.filename) : '');
          var size = isObject(attachment) ? sizeLabel(attachment.sizeBytes) : '';
          if (size) item.appendChild(el('span', 'size', size));
          list.appendChild(item);
        });
        var cell = el('dd');
        cell.appendChild(list);
        row('Attachments', cell);
      }
      content.appendChild(fields);
      if (state.card) renderBody(content);
      else content.appendChild(el('p', 'note', 'The body is not available in this view. Ask the assistant to show it.'));
    }
    var canSend = !!(state.preview && state.card && state.input);
    var done = state.phase === 'sent' || state.phase === 'unsendable';
    send.hidden = !state.preview || done;
    send.disabled = !canSend || state.phase === 'sending' || state.phase === 'previewing';
    send.textContent = state.phase === 'sending' ? 'Sending...' : state.phase === 'previewing' ? 'Updating...' : 'Send';
    status.className = 'status';
    status.textContent = '';
    if (state.phase === 'sent') { status.className = 'status success'; status.textContent = state.statusText || 'Sent.'; }
    else if (state.phase === 'unsendable' || state.phase === 'retry') { status.className = 'status error'; status.textContent = state.statusText || ''; }
    else if (state.preview && !canSend) { status.textContent = 'Ask the assistant to send this email.'; }
  }

  function sendArguments() {
    var args = {};
    Object.keys(state.input).forEach(function (key) { args[key] = state.input[key]; });
    if (state.preview && typeof state.preview.accountId === 'string') args.accountId = state.preview.accountId;
    args.idempotencyKey = state.card.idempotencyKey;
    return args;
  }

  // Tell the model what happened, so it neither sends again nor claims a send that failed.
  function report(contextText, messageText) {
    request('ui/update-model-context', { content: [{ type: 'text', text: contextText }] }).catch(function () {
      request('ui/message', { role: 'user', content: [{ type: 'text', text: messageText }] }).catch(function () {});
    });
  }

  // A thrown tool error has no structured result; its text holds { error, message }.
  function toolError(result) {
    var data = isObject(result.structuredContent) && isObject(result.structuredContent.data) ? result.structuredContent.data : null;
    if (data && isObject(data.error)) return { code: str(data.error.code), message: str(data.error.message) };
    var first = Array.isArray(result.content) ? result.content[0] : null;
    try {
      var parsed = JSON.parse(isObject(first) ? str(first.text) : '');
      if (isObject(parsed)) return { code: str(parsed.error), message: str(parsed.message) };
    } catch (error) {}
    return { code: '', message: '' };
  }

  function onSend() {
    if (state.phase !== 'ready' && state.phase !== 'retry') return;
    if (!state.input || !state.card) return;
    state.phase = 'sending';
    render();
    request('tools/call', { name: 'send_email', arguments: sendArguments() }).then(function (result) {
      result = isObject(result) ? result : {};
      var data = isObject(result.structuredContent) && isObject(result.structuredContent.data) ? result.structuredContent.data : {};
      var status = str(data.status);
      var operation = str(data.operationId);
      if (!result.isError && (status === 'succeeded' || status === 'sending')) {
        state.phase = 'sent';
        state.statusText = status === 'sending' ? 'Sending. Fluxmail is finishing this delivery.' : 'Sent.';
        render();
        report(
          'The user sent this email with the Fluxmail preview card (delivery operation ' + operation + ', status ' + status + '). Do not send it again.',
          'I sent the email from the preview. Do not send it again.'
        );
        return;
      }
      state.phase = 'unsendable';
      if (status === 'uncertain') {
        state.statusText = 'Fluxmail could not confirm the send. Check your Sent folder before trying again.';
        report(
          'The user clicked Send on the Fluxmail preview card, but delivery operation ' + operation + ' has an uncertain outcome. ' +
            'The email may have been sent. Do not send it again unless the user confirms it is not in their Sent folder.',
          'I clicked Send on the email preview, but Fluxmail could not confirm whether it was sent. Do not send it again until I check my Sent folder.'
        );
      } else {
        var error = toolError(result);
        state.statusText = 'Fluxmail did not send this email.' + (error.message ? ' ' + error.message : '');
        report(
          'The user clicked Send on the Fluxmail preview card and the email was not sent' + (error.message ? ': ' + error.message : '.'),
          'I clicked Send on the email preview and it was not sent' + (error.message ? ': ' + error.message : '.')
        );
      }
      render();
    }, function (error) {
      // The host did not run the call. Sending again reuses the key, so a send that did go out is not repeated.
      state.phase = 'retry';
      state.statusText = 'The send did not go through' + (isObject(error) && str(error.message) ? ': ' + error.message : '.') + ' You can try again.';
      render();
    });
  }

  function watchSize() {
    var scheduled = false, lastWidth = 0, lastHeight = 0;
    function measure() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        var root = document.documentElement;
        var previous = root.style.height;
        root.style.height = 'max-content';
        var height = Math.ceil(root.getBoundingClientRect().height);
        root.style.height = previous;
        var width = Math.ceil(window.innerWidth);
        if (width !== lastWidth || height !== lastHeight) {
          lastWidth = width;
          lastHeight = height;
          notify('ui/notifications/size-changed', { width: width, height: height });
        }
      });
    }
    measure();
    if (typeof ResizeObserver === 'function') {
      var observer = new ResizeObserver(measure);
      observer.observe(document.documentElement);
      observer.observe(document.body);
    }
  }

  // Pressing Send while editing ends the edit first; the send goes out once the edited email is previewed.
  $('send').addEventListener('mousedown', function () { if (state.editing) state.sendAfterPreview = true; });
  $('send').addEventListener('click', onSend);
  render();
  request('ui/initialize', {
    appInfo: { name: 'Fluxmail send confirmation', version: '1' },
    appCapabilities: { availableDisplayModes: ['inline'] },
    protocolVersion: PROTOCOL_VERSION
  }).then(function (result) {
    if (isObject(result)) applyHostContext(result.hostContext);
    notify('ui/notifications/initialized', {});
    watchSize();
  }, function () {
    notify('ui/notifications/initialized', {});
    watchSize();
  });
})();
`;

/**
 * The view's own Content Security Policy, applied on top of the host's. It never relaxes the host's policy,
 * and it leaves script-src and style-src to the host so host-injected bootstrap code keeps working.
 */
const DOCUMENT_CSP = [
  "connect-src 'none'",
  'img-src data:',
  "media-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const SEND_CONFIRMATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<meta name="referrer" content="no-referrer">
<title>Send email</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Send email</h1>
<div id="content" aria-live="polite"></div>
<footer>
<span id="status" class="status" role="status"></span>
<button id="send" type="button" class="primary" hidden disabled>Send</button>
</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
