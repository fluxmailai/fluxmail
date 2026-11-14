/**
 * What every Fluxmail MCP Apps view shares: the base styles, the MCP Apps postMessage bridge, host theming and
 * sizing, address and size formatting, and the mail HTML renderer. Each view is one self-contained HTML document
 * built from these pieces plus its own markup and script, so it loads nothing remote and needs no SDK bundle.
 *
 * Keep VIEW_KIT_SCRIPT free of backticks and template placeholders: it lives inside this module's template literal.
 */

import { MAIL_HTML_STYLE, createMailHtmlRenderer } from '../mailHtml/renderer.js';

/** The MCP Apps protocol version the views speak. */
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';

export const VIEW_BASE_STYLE = `
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
/* Formatted mail keeps the sender's colors, so it renders on a light page. In a light host the page blends in. */
${MAIL_HTML_STYLE}
.toggle { display: flex; gap: 4px; }
.toggle button { font-size: var(--font-text-sm-size); padding: 2px 8px; }
.toggle button[aria-pressed="true"] { background: var(--color-background-secondary); }
.note { font-size: var(--font-text-sm-size); color: var(--color-text-secondary); margin: 0; }
.status.error { color: var(--color-text-danger); }
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
}
`;

/**
 * Script statements a view's IIFE starts with. They define $, el, clear, isObject, str, request, notify,
 * addressText, addresses, sizeLabel, createMailHtmlRenderer and connectView(appName, handlers), which answers
 * host requests, applies the host context, initializes and reports the view's size.
 */
export const VIEW_KIT_SCRIPT = `
  // Some build tools wrap functions in a __name helper (esbuild's keepNames); the inlined renderer then needs it.
  var __name = function (target) { return target; };
  var createMailHtmlRenderer = ${createMailHtmlRenderer.toString()};
  var PROTOCOL_VERSION = '${MCP_APPS_PROTOCOL_VERSION}';
  var nextId = 1;
  var pending = {};

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
    // Keep sticky controls clear of the device's bottom inset on mobile hosts.
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

  // handlers: onToolInput(arguments), onToolResult(result), onToolCancelled(), onHostContext(context).
  function connectView(appName, handlers) {
    function call(name, value) { if (typeof handlers[name] === 'function') handlers[name](value); }
    function hostContext(context) {
      applyHostContext(context);
      if (isObject(context)) call('onHostContext', context);
    }
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
          call('onToolInput', isObject(params.arguments) ? params.arguments : null);
          break;
        case 'ui/notifications/tool-result':
          call('onToolResult', params);
          break;
        case 'ui/notifications/tool-cancelled':
          call('onToolCancelled');
          break;
        case 'ui/notifications/host-context-changed':
          hostContext(params);
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
    request('ui/initialize', {
      appInfo: { name: appName, version: '1' },
      appCapabilities: { availableDisplayModes: ['inline'] },
      protocolVersion: PROTOCOL_VERSION
    }).then(function (result) {
      if (isObject(result)) hostContext(result.hostContext);
      notify('ui/notifications/initialized', {});
      watchSize();
    }, function () {
      notify('ui/notifications/initialized', {});
      watchSize();
    });
  }
`;

/**
 * Each view's own Content Security Policy, applied on top of the host's. It never relaxes the host's policy,
 * and it leaves script-src and style-src to the host so host-injected bootstrap code keeps working.
 */
export const VIEW_DOCUMENT_CSP = [
  "connect-src 'none'",
  'img-src data:',
  "media-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** One self-contained view document. */
export function viewDocument(view: { title: string; style: string; body: string; script: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${VIEW_DOCUMENT_CSP}">
<meta name="referrer" content="no-referrer">
<title>${view.title}</title>
<style>${VIEW_BASE_STYLE}${view.style}</style>
</head>
<body>
${view.body}
<script>${view.script}</script>
</body>
</html>
`;
}
