/**
 * The send confirmation card: one self-contained HTML document for MCP Apps hosts, built from the shared view
 * kit. It loads nothing remote, builds every piece of mail content with DOM APIs (never innerHTML), and renders
 * an HTML body with the shared mail HTML renderer in draft mode.
 *
 * Keep the script free of backticks and template placeholders: it lives inside this module's template literal.
 */

import { VIEW_KIT_SCRIPT, viewDocument } from './viewKit.js';

/** The key a preview_send result's `_meta` uses for the card's data. Mirrored in the script below. */
export const SEND_CONFIRMATION_RESULT_META_KEY = 'ai.fluxmail/send-confirmation';

/** Characters of each body part the card receives. */
export const SEND_CONFIRMATION_MAX_BODY_CHARS = 50_000;

const STYLE = `
/* Send stays in view when the host caps the card's height and the card scrolls. */
footer {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px;
  position: sticky; bottom: 0; background: var(--color-background-primary);
  padding: 8px 0 calc(14px + var(--safe-area-bottom, 0px));
}
footer .status { margin-right: auto; font-size: var(--font-text-sm-size); }
@media (max-width: 360px) {
  footer button { flex: 1; }
}
`;

const SCRIPT = `
(function () {
  'use strict';
${VIEW_KIT_SCRIPT}
  var META_KEY = 'ai.fluxmail/send-confirmation';
  var state = { input: null, preview: null, card: null, phase: 'waiting', bodyMode: 'html' };

  function receiveResult(result) {
    if (result.isError) { state.phase = 'preview-error'; render(); return; }
    var structured = isObject(result.structuredContent) ? result.structuredContent : {};
    var data = isObject(structured.data) ? structured.data : null;
    var meta = isObject(result._meta) ? result._meta[META_KEY] : null;
    state.preview = data;
    state.card = isObject(meta) && meta.version === 1 && typeof meta.idempotencyKey === 'string' ? meta : null;
    state.bodyMode = state.card && state.card.body && str(state.card.body.html) ? 'html' : 'text';
    if (state.phase === 'waiting' || state.phase === 'cancelled') state.phase = 'ready';
    render();
  }

  var renderer = createMailHtmlRenderer(document, DOMParser);
  function sanitizedHtml(html) {
    var images = state.card && isObject(state.card.body) && isObject(state.card.body.inlineImages) ? state.card.body.inlineImages : {};
    return renderer.render(html, { mode: 'draft', inlineImages: images }).fragment;
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
    } else if (text) {
      box.appendChild(el('pre', 'body-text', text));
    } else {
      box.appendChild(el('span', 'placeholder', 'No message body'));
    }
    container.appendChild(box);
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
    send.disabled = !canSend || state.phase === 'sending';
    send.textContent = state.phase === 'sending' ? 'Sending...' : 'Send';
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

  $('send').addEventListener('click', onSend);
  render();
  connectView('Fluxmail send confirmation', {
    onToolInput: function (args) { state.input = args; render(); },
    onToolResult: receiveResult,
    onToolCancelled: function () { if (!state.preview) { state.phase = 'cancelled'; render(); } }
  });
})();
`;

export const SEND_CONFIRMATION_HTML = viewDocument({
  title: 'Send email',
  style: STYLE,
  body: `<main>
<h1>Send email</h1>
<div id="content" aria-live="polite"></div>
<footer>
<span id="status" class="status" role="status"></span>
<button id="send" type="button" class="primary" hidden disabled>Send</button>
</footer>
</main>`,
  script: SCRIPT,
});
