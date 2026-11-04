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
// Formatting properties a quote may keep. Anything that could move the quote over the reply, such as
// position, transform or a negative margin, is left out.
const ALLOWED_STYLE = new Set([
  'background-color',
  'border-collapse',
  'border-radius',
  'border-spacing',
  'color',
  'direction',
  'display',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'height',
  'letter-spacing',
  'line-height',
  'list-style-type',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-width',
  'min-width',
  'overflow-wrap',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'table-layout',
  'text-align',
  'text-decoration',
  'text-transform',
  'vertical-align',
  'white-space',
  'width',
  'word-break',
  'word-wrap',
]);
const BORDER_STYLE = /^border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width))?$/;
// Color functions are the only CSS functions kept, so calc(), var() and url() can't hide a value.
const ALLOWED_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

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

function safeDeclaration(declaration: string): string | undefined {
  const separator = declaration.indexOf(':');
  if (separator < 1) return undefined;
  const property = declaration.slice(0, separator).trim().toLowerCase();
  const value = declaration
    .slice(separator + 1)
    .replace(/!\s*important\s*$/i, '')
    .trim();
  if (!value || (!ALLOWED_STYLE.has(property) && !BORDER_STYLE.test(property))) return undefined;
  // Escapes and comments could spell a different property or value than the one checked here.
  if (/[\\]|\/\*/.test(value) || !/^[\w\s#%.,'"/()+-]*$/.test(value)) return undefined;
  for (const [, name] of value.matchAll(/([\w-]+)\s*\(/g)) {
    if (!ALLOWED_FUNCTIONS.has(name!.toLowerCase())) return undefined;
  }
  // A negative margin can pull the quote over the reply above it.
  if (property.startsWith('margin') && value.includes('-')) return undefined;
  return `${property}:${value}`;
}

function safeStyle(value: string): string | undefined {
  const declarations = value
    .split(';')
    .map((declaration) => safeDeclaration(declaration))
    .filter((declaration) => declaration !== undefined);
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
