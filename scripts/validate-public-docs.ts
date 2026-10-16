import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  GENERATED_MARKERS,
  PUBLIC_DOCS_ROOT,
  compatibilityManifest,
  pageFiles,
  parseFrontmatter,
  publicDocPages,
  readPublicDocsMeta,
  readPublicDocsManifest,
  validateClineInstallationGuide,
  validateUpgradeGuideLink,
} from './public-docs.js';

const meta = readPublicDocsMeta();
const agentSetup = readFileSync(path.join(PUBLIC_DOCS_ROOT, 'setup.txt'), 'utf8');
if (!agentSetup.trim()) throw new Error('docs/public/setup.txt must contain agent setup instructions.');
if (/[—–]/u.test(agentSetup))
  throw new Error('setup.txt contains an em dash or en dash. Rewrite it in plain language.');
const pages = publicDocPages(meta);
const manifest = readPublicDocsManifest();
const expectedManifest = compatibilityManifest(
  meta,
  pages.map((page) => page.slug),
);
if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
  throw new Error('Compatibility manifest differs from pages/meta.json. Run pnpm docs:generate.');
}

const RESERVED_MAIL_SLUGS = new Set([
  'what-is-fluxmail',
  'connect-your-gmail',
  'install-fluxmail',
  'home-inbox',
  'priority-and-newsletters',
  'flux-ai',
  'ai-drafting',
  'search',
  'email-actions',
  'tasks-and-reminders',
  'create-a-rule',
  'unified-inbox',
  'shortcuts',
  'insights',
  'privacy-and-security',
]);
const DOC_PATH_SEGMENT = String.raw`(?:[a-z0-9]+(?:-[a-z0-9]+)*|[0-9]+(?:\.[0-9]+){2})`;
const DOC_LINK_PATTERN = new RegExp(String.raw`\]\(/docs/(${DOC_PATH_SEGMENT}(?:/${DOC_PATH_SEGMENT})*)(?:[)#?])`, 'g');

for (const slug of meta.pages) {
  if (RESERVED_MAIL_SLUGS.has(slug)) {
    throw new Error(`MCP documentation slug ${slug} collides with an existing Fluxmail documentation page.`);
  }
}

const expectedFiles = pages.map((page) => page.filename).sort();
const actualFiles = pageFiles();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `Metadata and pages directory differ. Expected ${expectedFiles.join(', ')}, found ${actualFiles.join(', ')}.`,
  );
}

const sources = new Map<string, string>();
for (const { slug, filename: relativeFilename } of pages) {
  const filename = path.join(PUBLIC_DOCS_ROOT, 'pages', relativeFilename);
  const source = readFileSync(filename, 'utf8');
  parseFrontmatter(source, `${slug}.md`);
  if (/[—–]/u.test(source)) throw new Error(`${slug}.md contains an em dash or en dash. Rewrite it in plain language.`);
  sources.set(slug, source);
}

const clientGuide = sources.get('connect-an-mcp-client');
if (!clientGuide) throw new Error('Missing connect-an-mcp-client.md.');
validateClineInstallationGuide(
  clientGuide,
  existsSync('llms-install.md') ? readFileSync('llms-install.md', 'utf8') : undefined,
);

const upgradeGuide = sources.get('upgrade-fluxmail');
if (!upgradeGuide) throw new Error('Missing upgrade-fluxmail.md.');
validateUpgradeGuideLink(upgradeGuide, [...sources.keys()]);

for (const [slug, source] of sources) {
  if (/\]\(\/docs\/mcp(?:\/|[)#?])/.test(source)) {
    throw new Error(`${slug}.md contains a nested /docs/mcp link. Use /docs/.`);
  }
  for (const match of source.matchAll(DOC_LINK_PATTERN)) {
    const target = match[1];
    if (target && !sources.has(target) && !RESERVED_MAIL_SLUGS.has(target)) {
      throw new Error(`${slug}.md links to unknown documentation page /docs/${target}.`);
    }
  }
}

const generatedPages = new Map<string, string[]>([
  ['configuration.md', [GENERATED_MARKERS[0]]],
  ['permissions.md', [GENERATED_MARKERS[1], GENERATED_MARKERS[2]]],
  ['rest-api/index.md', [GENERATED_MARKERS[3]]],
  ['tools/index.md', [GENERATED_MARKERS[4]]],
  ['cli/index.md', [GENERATED_MARKERS[5]]],
]);
for (const [filename, markers] of generatedPages) {
  const source = readFileSync(path.join(PUBLIC_DOCS_ROOT, 'pages', filename), 'utf8');
  for (const marker of markers) {
    if (
      !source.includes(`<!-- BEGIN GENERATED:${marker} -->`) ||
      !source.includes(`<!-- END GENERATED:${marker} -->`)
    ) {
      throw new Error(`${filename} is missing the ${marker} generated section.`);
    }
  }
}

const packageReadmes = readdirSync('packages', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join('packages', entry.name, 'README.md'))
  .filter(existsSync);
const readmes = ['README.md', ...packageReadmes];
for (const readme of readmes) {
  const source = readFileSync(readme, 'utf8');
  if (readme === 'README.md' || readme === path.join('packages', 'server', 'README.md')) {
    for (const required of ['quickstart', 'tools', 'permissions', 'configuration', 'cli']) {
      const link = `https://fluxmail.ai/docs/${required}`;
      if (!source.includes(link)) throw new Error(`${readme} must link to ${link}.`);
    }
  }
  if (/\]\((?:\.\.\/)*docs\/public\//.test(source)) {
    throw new Error(`${readme} must use published documentation URLs instead of repository files.`);
  }
  if (/https:\/\/fluxmail\.ai\/docs\/mcp(?:\/|[)#?])/.test(source)) {
    throw new Error(`${readme} contains a nested published documentation URL. Use /docs/.`);
  }
}

console.log(`Validated ${pages.length} public documentation pages in Fumadocs order.`);
