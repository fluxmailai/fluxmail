import { Parser } from 'htmlparser2';

// Mail Fluxmail quotes or forwards comes from other people, so its HTML is rebuilt from an allowlist before
// it goes out under the user's name. Tags are balanced, so the original can't close the quote and put text
// outside it, and nothing in it can run, load a document or restyle the rest of the message.

const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'address',
  'b',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'wbr',
]);

const VOID_TAGS = new Set(['br', 'col', 'hr', 'img', 'wbr']);

// Content of these elements is dropped along with the tags.
const DROPPED_WITH_CONTENT = new Set([
  'applet',
  'audio',
  'embed',
  'frame',
  'frameset',
  'head',
  'iframe',
  'math',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'video',
]);

const ALLOWED_ATTRIBUTES = new Set([
  'align',
  'alt',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'color',
  'colspan',
  'dir',
  'face',
  'height',
  'href',
  'lang',
  'rowspan',
  'size',
  'src',
  'style',
  'title',
  'valign',
  'width',
]);

// Style properties that could move quoted content over the user's reply or load something.
const BLOCKED_STYLE = /^(?:position|z-index|transform|top|right|bottom|left|inset|behavior|-moz-binding|content)$/i;

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function safeUrl(tag: string, name: string, value: string): string | undefined {
  const url = value.trim();
  if (name === 'href') return /^(?:https?:|mailto:|#)/i.test(url) ? url : undefined;
  if (tag === 'img') return /^(?:https?:|cid:|data:image\/(?:png|gif|jpe?g|webp);)/i.test(url) ? url : undefined;
  return undefined;
}

function safeStyle(value: string): string | undefined {
  const declarations = value
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const separator = declaration.indexOf(':');
      if (separator < 1) return false;
      const property = declaration.slice(0, separator).trim();
      const content = declaration.slice(separator + 1);
      if (BLOCKED_STYLE.test(property) || /expression\s*\(|url\s*\(|javascript:|@import/i.test(content)) return false;
      // Negative margins can pull quoted content over the reply above it.
      return !(/^margin/i.test(property) && /-\s*\d/.test(content));
    });
  return declarations.length ? declarations.join('; ') : undefined;
}

function attributes(tag: string, attribs: Record<string, string>): string {
  let out = '';
  for (const [name, value] of Object.entries(attribs)) {
    if (!ALLOWED_ATTRIBUTES.has(name)) continue;
    const safe =
      name === 'href' || name === 'src' ? safeUrl(tag, name, value) : name === 'style' ? safeStyle(value) : value;
    if (safe !== undefined) out += ` ${name}="${escapeAttribute(safe)}"`;
  }
  return tag === 'a' && attribs.href !== undefined && out.includes(' href=')
    ? `${out} target="_blank" rel="noopener noreferrer"`
    : out;
}

/** The original's HTML reduced to safe formatting, with every element it opens closed again. */
export function sanitizeQuotedHtml(html: string): string {
  let out = '';
  const open: string[] = [];
  let dropping = 0;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (dropping || DROPPED_WITH_CONTENT.has(name)) {
          if (!VOID_TAGS.has(name)) dropping++;
          return;
        }
        if (!ALLOWED_TAGS.has(name)) return;
        out += `<${name}${attributes(name, attribs)}>`;
        if (!VOID_TAGS.has(name)) open.push(name);
      },
      ontext(text) {
        if (!dropping) out += escapeText(text);
      },
      onclosetag(name) {
        if (dropping) {
          if (!VOID_TAGS.has(name)) dropping--;
          return;
        }
        if (VOID_TAGS.has(name) || !ALLOWED_TAGS.has(name)) return;
        const index = open.lastIndexOf(name);
        if (index === -1) return;
        while (open.length > index) out += `</${open.pop()}>`;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  while (open.length) out += `</${open.pop()}>`;
  return out;
}
