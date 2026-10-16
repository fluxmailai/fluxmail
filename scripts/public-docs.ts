import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface PublicDocsManifest {
  schemaVersion: 1;
  id: string;
  category: string;
  pages: string[];
}

export interface PublicDocsMeta {
  title: string;
  pages: string[];
  pagesIndex?: string;
  defaultOpen?: boolean;
}

export interface PublicDocsFrontmatter {
  title: string;
  description: string;
  updated: string;
  draft?: boolean;
}

export interface PublicDocPage {
  slug: string;
  filename: string;
}

export const PUBLIC_DOCS_ROOT = path.resolve('docs/public');
export const GENERATED_MARKERS = [
  'configuration',
  'permission-profiles',
  'permission-capabilities',
  'rest-api-endpoints',
  'mcp-tool-reference',
  'cli-command-reference',
] as const;

const SLUG_PATTERN = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|[0-9]+(?:\.[0-9]+){2})$/;
const PAGE_PATH_PATTERN =
  /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|[0-9]+(?:\.[0-9]+){2})(?:\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|[0-9]+(?:\.[0-9]+){2}))*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function parseMeta(value: unknown): PublicDocsMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Meta must be a JSON object.');
  const meta = value as Record<string, unknown>;
  const allowed = new Set(['defaultOpen', 'pages', 'pagesIndex', 'title']);
  const unexpected = Object.keys(meta).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`Meta has unsupported fields: ${unexpected.join(', ')}.`);
  if (typeof meta.title !== 'string' || !meta.title.trim()) throw new Error('Meta title is required.');
  validatePageSlugs(meta.pages, 'Meta');
  if (meta.pagesIndex !== undefined) {
    if (typeof meta.pagesIndex !== 'string' || !SLUG_PATTERN.test(meta.pagesIndex)) {
      throw new Error('Meta pagesIndex contains an unsafe or invalid slug.');
    }
    if ((meta.pages as string[]).includes(meta.pagesIndex)) {
      throw new Error('Meta pagesIndex must not also appear in pages.');
    }
  }
  if (meta.defaultOpen !== undefined && typeof meta.defaultOpen !== 'boolean') {
    throw new Error('Meta defaultOpen must be true or false.');
  }
  return meta as unknown as PublicDocsMeta;
}

export function compatibilityManifest(meta: PublicDocsMeta, pages = meta.pages): PublicDocsManifest {
  return {
    schemaVersion: 1,
    id: 'fluxmail',
    category: meta.title,
    pages: pages.filter((page) => !isPageSeparator(page)),
  };
}

export function isPageSeparator(value: string): boolean {
  return (
    value.startsWith('---') &&
    value.endsWith('---') &&
    value.length > 6 &&
    value.slice(3, -3).trim().length > 0 &&
    !/[\r\n]/.test(value)
  );
}

export function parseManifest(value: unknown): PublicDocsManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Manifest must be a JSON object.');
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  const expected = ['category', 'id', 'pages', 'schemaVersion'];
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error(`Manifest fields must be: ${expected.join(', ')}.`);
  if (manifest.schemaVersion !== 1) throw new Error('Manifest schemaVersion must be 1.');
  if (manifest.id !== 'fluxmail') throw new Error('Manifest id must be fluxmail.');
  if (typeof manifest.category !== 'string' || !manifest.category.trim())
    throw new Error('Manifest category is required.');
  validatePagePaths(manifest.pages, 'Manifest');
  return manifest as unknown as PublicDocsManifest;
}

export function parseFrontmatter(source: string, filename = 'page'): PublicDocsFrontmatter {
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match?.[1]) throw new Error(`${filename} has no frontmatter.`);
  const values: Record<string, string | boolean> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`${filename} has malformed frontmatter.`);
    const key = line.slice(0, separator).trim();
    let value: string | boolean = line.slice(separator + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    }
    values[key] = value;
  }
  const allowed = new Set(['title', 'description', 'updated', 'draft']);
  const unexpected = Object.keys(values).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${filename} has unsupported frontmatter: ${unexpected.join(', ')}.`);
  if (typeof values.title !== 'string' || !values.title.trim()) throw new Error(`${filename} needs a title.`);
  if (typeof values.description !== 'string' || !values.description.trim())
    throw new Error(`${filename} needs a description.`);
  if (typeof values.updated !== 'string' || !isValidDate(values.updated)) {
    throw new Error(`${filename} needs an updated date in YYYY-MM-DD format.`);
  }
  if (values.draft !== undefined && typeof values.draft !== 'boolean')
    throw new Error(`${filename} draft must be true or false.`);
  return values as unknown as PublicDocsFrontmatter;
}

export function replaceGeneratedSection(source: string, marker: string, content: string): string {
  const start = `<!-- BEGIN GENERATED:${marker} -->`;
  const end = `<!-- END GENERATED:${marker} -->`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(source)) throw new Error(`Missing generated section ${marker}.`);
  return source.replace(pattern, `${start}\n${content.trim()}\n${end}`);
}

export function generateClineInstallationGuide(clientGuide: string): string {
  const detailsSections = [
    ...clientGuide.matchAll(/<details>\s*<summary>Cline<\/summary>\s*([\s\S]*?)\s*<\/details>/g),
  ].map((match) => match[1].trim().replace(/^### /gm, '## '));
  const headingSections = [...clientGuide.matchAll(/^### Cline[ \t]*\r?\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/gm)].map(
    (match) => match[1].trim().replace(/^#### /gm, '## '),
  );
  const sections = [...detailsSections, ...headingSections];
  const section = sections[0];
  if (sections.length !== 1 || !section) {
    throw new Error('connect-an-mcp-client.md must contain exactly one nonempty Cline section.');
  }
  return `# Install Fluxmail in Cline\n\n${section}\n`;
}

export function validateClineInstallationGuide(clientGuide: string, installationGuide: string | undefined): void {
  if (installationGuide !== generateClineInstallationGuide(clientGuide)) {
    throw new Error('Generated documentation is stale: llms-install.md. Run pnpm docs:generate.');
  }
}

function compareVersionParts(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** The upgrade overview must point readers at the newest version-specific guide. */
export function validateUpgradeGuideLink(upgradeGuide: string, slugs: readonly string[]): void {
  const versions = slugs.flatMap((slug) => {
    const match = /^upgrades\/(\d+)\.(\d+)\.(\d+)$/.exec(slug);
    return match ? [{ slug, parts: match.slice(1).map(Number) }] : [];
  });
  const newest = versions.sort((left, right) => compareVersionParts(right.parts, left.parts))[0];
  if (newest && !new RegExp(`\\]\\(/docs/${escapeRegExp(newest.slug)}[)#]`).test(upgradeGuide)) {
    throw new Error(`upgrade-fluxmail.md must link to the newest upgrade guide, /docs/${newest.slug}.`);
  }
}

export function readPublicDocsManifest(root = PUBLIC_DOCS_ROOT): PublicDocsManifest {
  return parseManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as unknown);
}

export function readPublicDocsMeta(root = PUBLIC_DOCS_ROOT): PublicDocsMeta {
  return parseMeta(JSON.parse(readFileSync(path.join(root, 'pages', 'meta.json'), 'utf8')) as unknown);
}

export function pageFiles(root = PUBLIC_DOCS_ROOT): string[] {
  const pagesRoot = path.join(root, 'pages');
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.relative(pagesRoot, absolute));
    }
  }
  visit(pagesRoot);
  return files.sort();
}

export function publicDocPages(meta: PublicDocsMeta, root = PUBLIC_DOCS_ROOT): PublicDocPage[] {
  const pagesRoot = path.join(root, 'pages');

  function visit(entries: string[], directory: string, prefix: string): PublicDocPage[] {
    return entries.flatMap((entry) => {
      if (isPageSeparator(entry)) return [];
      const markdown = path.join(directory, `${entry}.md`);
      const folder = path.join(directory, entry);
      const hasMarkdown = existsSync(markdown);
      const hasFolder = existsSync(folder);
      if (hasMarkdown && hasFolder) throw new Error(`Documentation entry ${entry} is both a page and a folder.`);
      if (hasMarkdown) {
        const slug = entry === 'index' ? prefix : [prefix, entry].filter(Boolean).join('/');
        if (!slug) throw new Error('The root documentation index must have a named route.');
        return [{ slug, filename: path.relative(pagesRoot, markdown) }];
      }
      if (!hasFolder) throw new Error(`Documentation entry ${entry} has no Markdown page or folder.`);
      const nestedMetaFile = path.join(folder, 'meta.json');
      if (!existsSync(nestedMetaFile)) throw new Error(`Documentation folder ${entry} has no meta.json.`);
      const nestedMeta = parseMeta(JSON.parse(readFileSync(nestedMetaFile, 'utf8')) as unknown);
      const nestedPages = nestedMeta.pagesIndex ? [nestedMeta.pagesIndex, ...nestedMeta.pages] : nestedMeta.pages;
      return visit(nestedPages, folder, [prefix, entry].filter(Boolean).join('/'));
    });
  }

  return visit(meta.pages, pagesRoot, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePageSlugs(value: unknown, owner: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${owner} pages must be a non-empty array.`);
  if (!value.every((slug) => typeof slug === 'string' && (SLUG_PATTERN.test(slug) || isPageSeparator(slug)))) {
    throw new Error(`${owner} pages contain an unsafe or invalid slug.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${owner} pages contain duplicate slugs.`);
}

function validatePagePaths(value: unknown, owner: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${owner} pages must be a non-empty array.`);
  if (!value.every((slug) => typeof slug === 'string' && PAGE_PATH_PATTERN.test(slug))) {
    throw new Error(`${owner} pages contain an unsafe or invalid path.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${owner} pages contain duplicate paths.`);
}
