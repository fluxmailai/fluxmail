/**
 * The message reader card: shows one email as it was sent, for MCP Apps hosts, built from the shared view kit.
 * It is read-only. Mail content is untrusted: the HTML body renders through the shared mail HTML renderer in
 * received mode, so remote images stay placeholders, tracking images and hidden passages are left out, and
 * links open only through the host after the user activates them.
 *
 * Keep the script free of backticks and template placeholders other than the kit: it lives inside this
 * module's template literal.
 */

import { VIEW_KIT_SCRIPT, viewDocument } from './viewKit.js';

/** The key a get_email result's `_meta` uses for the card's data. Mirrored in the script below. */
export const MESSAGE_READER_RESULT_META_KEY = 'ai.fluxmail/message-reader';

const STYLE = `
.fields .date { color: var(--color-text-secondary); }
.notes { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.notes button, .more button { font-size: var(--font-text-sm-size); padding: 2px 8px; }
/* A long email starts folded so a run of reads doesn't flood the conversation; it unfolds in place, never scrolls. */
.body-box.folded { max-height: 420px; overflow: hidden; position: relative; }
.body-box.folded::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 56px;
  background: linear-gradient(transparent, var(--fold-color, var(--color-background-primary)));
}
.body-box.paper.folded { --fold-color: #ffffff; }
.more { display: flex; justify-content: center; }
#status { min-height: 0; padding-bottom: calc(14px + var(--safe-area-bottom, 0px)); }
#status:empty { padding-bottom: calc(8px + var(--safe-area-bottom, 0px)); }
`;

const SCRIPT = `
(function () {
  'use strict';
${VIEW_KIT_SCRIPT}
  var META_KEY = 'ai.fluxmail/message-reader';
  var FOLD_HEIGHT = 480;
  var state = {
    message: null, card: null, phase: 'waiting', bodyMode: 'html', showHidden: false, unfolded: false,
    locale: '', timeZone: '', status: ''
  };
  var renderer = createMailHtmlRenderer(document, DOMParser);

  function receiveResult(result) {
    if (result.isError) { state.phase = 'error'; render(); return; }
    var structured = isObject(result.structuredContent) ? result.structuredContent : {};
    var data = isObject(structured.data) ? structured.data : null;
    var meta = isObject(result._meta) ? result._meta[META_KEY] : null;
    state.message = data;
    state.card = isObject(meta) && meta.version === 1 && isObject(meta.body) ? meta : null;
    state.phase = data ? 'ready' : 'error';
    state.bodyMode = body().html ? 'html' : 'text';
    state.unfolded = false;
    state.showHidden = false;
    render();
  }

  // The body as sent: the card's copy when the model's result cut or left out a part, else the model's copy.
  function body() {
    var message = state.message || {};
    var returned = isObject(message.body) ? message.body : {};
    var cuts = isObject(message.bodyTruncation) ? message.bodyTruncation : {};
    var extra = state.card ? state.card.body : {};
    function part(name) {
      if (str(extra[name])) return { value: extra[name], truncated: extra[name + 'Truncated'] === true };
      var cut = isObject(cuts[name]) && typeof cuts[name].nextOffset === 'number';
      return { value: str(returned[name]), truncated: cut };
    }
    var html = part('html');
    var text = part('text');
    return {
      html: html.value, htmlTruncated: html.truncated, text: text.value, textTruncated: text.truncated,
      inlineImages: isObject(extra.inlineImages) ? extra.inlineImages : {}
    };
  }

  function dateText(value) {
    var date = new Date(str(value));
    if (isNaN(date.getTime())) return str(value);
    var options = { dateStyle: 'medium', timeStyle: 'short' };
    if (state.timeZone) options.timeZone = state.timeZone;
    try { return date.toLocaleString(state.locale || undefined, options); } catch (error) {}
    try { return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (error) {}
    return date.toISOString();
  }

  function openLink(url) {
    state.status = '';
    renderStatus();
    request('ui/open-link', { url: url }).catch(function (error) {
      state.status = 'The link did not open' + (isObject(error) && str(error.message) ? ': ' + error.message : '.') + ' Its address is ' + url;
      renderStatus();
    });
  }

  function renderStatus() {
    var status = $('status');
    status.textContent = state.status;
    status.className = state.status ? 'note status error' : 'note';
  }

  function button(label, onClick, pressed) {
    var node = el('button', '', label);
    node.type = 'button';
    if (pressed !== undefined) node.setAttribute('aria-pressed', String(pressed));
    node.addEventListener('click', onClick);
    return node;
  }

  function renderBody(container) {
    var parts = body();
    var section = el('div', 'body-section');
    container.appendChild(section);
    if (parts.text && parts.html) {
      var toggle = el('div', 'toggle');
      [['html', 'Formatted'], ['text', 'Plain text']].forEach(function (option) {
        toggle.appendChild(button(option[1], function () { state.bodyMode = option[0]; render(); }, state.bodyMode === option[0]));
      });
      section.appendChild(toggle);
    }
    var box = el('div', 'body-box');
    box.setAttribute('aria-label', 'Message body');
    var outcome = null;
    var showHtml = parts.html && (state.bodyMode === 'html' || !parts.text);
    if (showHtml) {
      box.className = 'body-box paper';
      var rendered = el('div', 'body-html');
      try {
        outcome = renderer.render(parts.html, {
          mode: 'received', inlineImages: parts.inlineImages, showHidden: state.showHidden, onLink: openLink
        });
        rendered.appendChild(outcome.fragment);
      } catch (error) {
        outcome = null;
        rendered = el('pre', 'body-text', parts.text || 'This formatted email could not be shown.');
      }
      box.appendChild(rendered);
    } else if (parts.text) {
      box.appendChild(el('pre', 'body-text', parts.text));
    } else {
      box.appendChild(el('span', 'placeholder', 'No message body'));
    }

    var notes = el('div', 'notes');
    if (outcome) {
      var blocked = [];
      if (outcome.trackers) blocked.push(outcome.trackers === 1 ? '1 tracking image' : outcome.trackers + ' tracking images');
      if (outcome.remoteImages) blocked.push(outcome.remoteImages === 1 ? '1 remote image' : outcome.remoteImages + ' remote images');
      if (blocked.length) notes.appendChild(el('p', 'note', 'Not loaded: ' + blocked.join(' and ') + '.'));
      if (outcome.hidden) {
        notes.appendChild(el('p', 'note', outcome.hidden === 1
          ? 'This email has 1 passage that mail apps hide.'
          : 'This email has ' + outcome.hidden + ' passages that mail apps hide.'));
        notes.appendChild(button(state.showHidden ? 'Hide it again' : 'Show hidden text', function () {
          state.showHidden = !state.showHidden;
          render();
        }));
      }
    }
    if (notes.firstChild) section.appendChild(notes);
    section.appendChild(box);
    var truncated = showHtml ? parts.htmlTruncated : parts.textTruncated;
    if (truncated) section.appendChild(el('p', 'note', 'This shows only the start of the email. Ask the assistant for the rest.'));

    if (!state.unfolded) {
      var more = el('div', 'more');
      more.hidden = true;
      more.appendChild(button('Show the whole email', function () { state.unfolded = true; render(); }));
      section.appendChild(more);
      requestAnimationFrame(function () {
        if (box.scrollHeight > FOLD_HEIGHT) {
          box.className += ' folded';
          more.hidden = false;
        }
      });
    }
  }

  function attachmentRows(list, html) {
    return (Array.isArray(list) ? list : []).filter(function (attachment) {
      if (!isObject(attachment)) return false;
      // Images the body shows in place aren't listed again.
      var id = str(attachment.contentId);
      return !(id && attachment.disposition !== 'attachment' && html.indexOf('cid:' + id) >= 0);
    });
  }

  function render() {
    var content = $('content');
    var title = $('title');
    clear(content);
    title.textContent = 'Email';
    title.className = '';
    if (state.phase === 'waiting') content.appendChild(el('p', 'muted', 'Opening the email...'));
    else if (state.phase === 'cancelled') content.appendChild(el('p', 'muted', 'The email was not opened.'));
    else if (state.phase === 'error') content.appendChild(el('p', 'muted', 'Fluxmail could not open this email.'));
    if (state.phase !== 'ready' || !state.message) { renderStatus(); return; }
    var message = state.message;
    var subject = str(message.subject);
    title.textContent = subject || 'No subject';
    title.className = subject ? '' : 'placeholder';
    var fields = el('dl', 'fields');
    function row(label, value) { fields.appendChild(el('dt', '', label)); fields.appendChild(value); }
    row('From', el('dd', '', addressText(message.from)));
    if (Array.isArray(message.replyTo) && message.replyTo.length) row('Reply to', addresses(message.replyTo));
    row('To', addresses(message.to));
    if (Array.isArray(message.cc) && message.cc.length) row('Cc', addresses(message.cc));
    if (Array.isArray(message.bcc) && message.bcc.length) row('Bcc', addresses(message.bcc));
    if (str(message.date)) row('Date', el('dd', 'date', dateText(message.date)));
    var attachments = attachmentRows(message.attachments, body().html);
    if (attachments.length) {
      var list = el('ul', 'attachments');
      attachments.forEach(function (attachment) {
        var item = el('li', '', str(attachment.filename) || 'Unnamed attachment');
        var size = sizeLabel(attachment.sizeBytes);
        if (size) item.appendChild(el('span', 'size', size));
        list.appendChild(item);
      });
      var cell = el('dd');
      cell.appendChild(list);
      row('Attachments', cell);
    }
    content.appendChild(fields);
    renderBody(content);
    renderStatus();
  }

  render();
  connectView('Fluxmail message reader', {
    onToolResult: receiveResult,
    onToolCancelled: function () { if (!state.message) { state.phase = 'cancelled'; render(); } },
    onHostContext: function (context) {
      var changed = false;
      if (typeof context.locale === 'string' && context.locale !== state.locale) { state.locale = context.locale; changed = true; }
      if (typeof context.timeZone === 'string' && context.timeZone !== state.timeZone) { state.timeZone = context.timeZone; changed = true; }
      if (changed && state.message) render();
    }
  });
})();
`;

export const MESSAGE_READER_HTML = viewDocument({
  title: 'Email',
  style: STYLE,
  body: `<main>
<h1 id="title">Email</h1>
<div id="content" aria-live="polite"></div>
<p id="status" class="note" role="status"></p>
</main>`,
  script: SCRIPT,
});
