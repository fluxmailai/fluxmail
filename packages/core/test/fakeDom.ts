// A small DOM for testing the mail HTML renderer in Node. It parses with htmlparser2, which core already uses,
// and builds output nodes that serialize to HTML for assertions. Browsers parse some malformed markup
// differently; the test host covers the real browser.
import { parseDocument } from 'htmlparser2';
import type { MailHtmlDomDocument, MailHtmlDomNode, MailHtmlParserConstructor } from '../src/mailHtml/index.js';

interface Parsed {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Parsed[];
}

function styleOf(attribute: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const declaration of (attribute ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    let value = declaration.slice(colon + 1).trim();
    if (/!important$/i.test(value)) value = value.replace(/\s*!important$/i, '');
    if (name) map.set(name === 'text-decoration' ? 'text-decoration-line' : name, value);
  }
  return map;
}

export class FakeNode implements MailHtmlDomNode {
  nodeType: number;
  nodeValue: string | null = null;
  localName = '';
  className = '';
  title = '';
  attributes = new Map<string, string>();
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  styles = new Map<string, string>();
  listeners: Record<string, Array<(event: { key?: string; preventDefault(): void }) => void>> = {};
  style = {
    getPropertyValue: (name: string) => this.styles.get(name) ?? '',
    setProperty: (name: string, value: string) => void this.styles.set(name, value),
  };

  constructor(nodeType: number, name = '') {
    this.nodeType = nodeType;
    this.localName = name;
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): FakeNode | null {
    if (!this.parent) return null;
    return this.parent.children[this.parent.children.indexOf(this) + 1] ?? null;
  }
  get textContent(): string | null {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue;
    return this.children.map((child) => (child.nodeType === 8 ? '' : child.textContent)).join('');
  }
  set textContent(value: string | null) {
    this.children = [];
    if (value) this.appendChild(Object.assign(new FakeNode(3), { nodeValue: value }));
  }
  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || null;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  appendChild(child: MailHtmlDomNode): MailHtmlDomNode {
    const node = child as FakeNode;
    if (node.nodeType === 11) {
      for (const inner of node.children) this.appendChild(inner);
      return child;
    }
    node.parent = this;
    this.children.push(node);
    return child;
  }
  addEventListener(type: string, listener: (event: { key?: string; preventDefault(): void }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type: string, event: { key?: string } = {}): void {
    for (const listener of this.listeners[type] ?? []) listener({ ...event, preventDefault() {} });
  }
  /** Every element below this node, depth first. */
  all(): FakeNode[] {
    return this.children.flatMap((child) => (child.nodeType === 1 ? [child, ...child.all()] : []));
  }
  get html(): string {
    return this.children.map((child) => child.outer).join('');
  }
  get outer(): string {
    if (this.nodeType === 3) return (this.nodeValue ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (this.nodeType !== 1) return this.html;
    const attributes = [
      ...(this.className ? [`class="${this.className}"`] : []),
      ...[...this.attributes].map(([name, value]) => `${name}="${value}"`),
      ...(this.styles.size
        ? [`style="${[...this.styles].map(([name, value]) => `${name}: ${value}`).join('; ')}"`]
        : []),
      ...(this.title ? [`title="${this.title}"`] : []),
    ];
    return `<${this.localName}${attributes.map((attribute) => ' ' + attribute).join('')}>${this.html}</${this.localName}>`;
  }
}

function convert(node: Parsed): FakeNode | undefined {
  if (node.type === 'text') return Object.assign(new FakeNode(3), { nodeValue: node.data ?? '' });
  if (node.type === 'comment') return Object.assign(new FakeNode(8), { nodeValue: node.data ?? '' });
  if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return undefined;
  const element = new FakeNode(1, node.name ?? '');
  for (const [name, value] of Object.entries(node.attribs ?? {})) {
    if (name === 'class') element.className = value;
    else element.attributes.set(name, value);
  }
  element.styles = styleOf(node.attribs?.style);
  for (const child of node.children ?? []) {
    const converted = convert(child);
    if (converted) element.appendChild(converted);
  }
  return element;
}

export const fakeDocument: MailHtmlDomDocument = {
  createElement: (tag) => new FakeNode(1, tag),
  createTextNode: (text) => Object.assign(new FakeNode(3), { nodeValue: text }),
  createDocumentFragment: () => new FakeNode(11),
};

export const FakeParser = class {
  parseFromString(html: string) {
    const body = new FakeNode(1, 'body');
    const head = new FakeNode(1, 'head');
    for (const child of (parseDocument(html) as unknown as Parsed).children ?? []) {
      // Unwrap html and body; the renderer reads body and head like a browser document.
      const unwrap = (node: Parsed): Parsed[] =>
        node.type === 'tag' && (node.name === 'html' || node.name === 'body')
          ? (node.children ?? []).flatMap(unwrap)
          : node.type === 'tag' && node.name === 'head'
            ? []
            : [node];
      for (const node of unwrap(child)) {
        const converted = convert(node);
        if (converted) body.appendChild(converted);
      }
      if (child.type === 'tag' && child.name === 'html') {
        for (const part of child.children ?? []) {
          if (part.type === 'tag' && part.name === 'head') {
            for (const node of part.children ?? []) {
              const converted = convert(node);
              if (converted) head.appendChild(converted);
            }
          }
        }
      }
    }
    return { body, head };
  }
} as unknown as MailHtmlParserConstructor;
