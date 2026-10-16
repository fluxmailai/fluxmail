import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compatibilityManifest,
  generateClineInstallationGuide,
  parseFrontmatter,
  parseManifest,
  parseMeta,
  publicDocPages,
  replaceGeneratedSection,
  validateClineInstallationGuide,
  validateUpgradeGuideLink,
} from './public-docs.js';

const manifest = { schemaVersion: 1, id: 'fluxmail', category: 'Fluxmail MCP', pages: ['quickstart'] };
const meta = { title: 'Fluxmail MCP', pages: ['quickstart'] };

describe('upgrade guide link', () => {
  const slugs = ['upgrade-fluxmail', 'upgrades/0.9.0', 'upgrades/0.14.0', 'upgrades/0.11.0'];

  it('accepts a link to the newest version-specific guide', () => {
    expect(() => validateUpgradeGuideLink('See the [upgrade guides](/docs/upgrades/0.14.0).', slugs)).not.toThrow();
  });

  it('rejects a link to an older guide', () => {
    expect(() => validateUpgradeGuideLink('See the [upgrade guides](/docs/upgrades/0.11.0).', slugs)).toThrow(
      '/docs/upgrades/0.14.0',
    );
  });
});

describe('Cline installation guide', () => {
  const section = '<details>\n<summary>Cline</summary>\n\n### Configure Cline\n\nUse read-only.\n\n</details>';
  const installationGuide = '# Install Fluxmail in Cline\n\n## Configure Cline\n\nUse read-only.\n';
  const headingSection =
    '### Cline\n\n#### Local connection\n\nUse read-only.\n\n#### HTTP connection\n\nUse an API key.\n';

  it.each(['### Hermes\nOther client instructions', '## Test connection\nTest instructions', ''])(
    'extracts both transports from Markdown headings before %s',
    (nextSection) => {
      const guide = `### Cursor\nCursor instructions\n${headingSection}\n${nextSection}`;
      const expected =
        '# Install Fluxmail in Cline\n\n## Local connection\n\nUse read-only.\n\n## HTTP connection\n\nUse an API key.\n';
      expect(generateClineInstallationGuide(guide)).toBe(expected);
      expect(() => validateClineInstallationGuide(guide, expected)).not.toThrow();
    },
  );

  it('extracts Cline instructions without including other clients', () => {
    const guide = `<details><summary>Cursor</summary>Cursor instructions</details>\n${section}\n## Test connection`;
    expect(generateClineInstallationGuide(guide)).toBe(installationGuide);
    expect(() => validateClineInstallationGuide(guide, installationGuide)).not.toThrow();
  });

  it('rejects a companion guide after the Cline instructions change', () => {
    const editedGuide = section.replace('Use read-only.', 'Use read-only.\n\nConfigure Cline CLI.');
    expect(() => validateClineInstallationGuide(editedGuide, installationGuide)).toThrow(
      'Generated documentation is stale: llms-install.md. Run pnpm docs:generate.',
    );
    expect(() =>
      validateClineInstallationGuide(editedGuide, generateClineInstallationGuide(editedGuide)),
    ).not.toThrow();
  });

  it('rejects a missing companion guide', () => {
    expect(() => validateClineInstallationGuide(section, undefined)).toThrow(/llms-install.md.*pnpm docs:generate/);
  });

  it.each([
    '',
    '<details><summary>Cline</summary>\n\n</details>',
    `${section}\n${section}`,
    '### Cline\n\n### Hermes\nOther client instructions',
    `${headingSection}\n${headingSection}`,
    `${section}\n${headingSection}`,
  ])('rejects missing, empty, or duplicate Cline sections', (guide) => {
    expect(() => generateClineInstallationGuide(guide)).toThrow(/exactly one nonempty Cline section/);
  });
});

describe('public docs bundle validation', () => {
  it('parses Fumadocs metadata without changing page order', () => {
    expect(parseMeta(meta).pages).toEqual(['quickstart']);
    expect(parseMeta({ ...meta, pages: ['---Getting started---', 'quickstart'] }).pages).toEqual([
      '---Getting started---',
      'quickstart',
    ]);
    expect(parseMeta({ title: 'REST API', pagesIndex: 'index', defaultOpen: false, pages: ['list-accounts'] })).toEqual(
      { title: 'REST API', pagesIndex: 'index', defaultOpen: false, pages: ['list-accounts'] },
    );
    expect(parseMeta({ title: 'Upgrade guides', pages: ['0.5.0'] }).pages).toEqual(['0.5.0']);
  });

  it('derives the compatibility manifest from Fumadocs metadata', () => {
    expect(compatibilityManifest(parseMeta({ ...meta, pages: ['---Getting started---', 'quickstart'] }))).toEqual({
      schemaVersion: 1,
      id: 'fluxmail',
      category: 'Fluxmail MCP',
      pages: ['quickstart'],
    });
  });

  it('parses a valid manifest without changing its order', () => {
    expect(parseManifest(manifest).pages).toEqual(['quickstart']);
    expect(parseManifest({ ...manifest, pages: ['rest-api', 'rest-api/list-accounts'] }).pages).toEqual([
      'rest-api',
      'rest-api/list-accounts',
    ]);
    expect(parseManifest({ ...manifest, pages: ['upgrades/0.5.0'] }).pages).toEqual(['upgrades/0.5.0']);
  });

  it('rejects unsafe paths and duplicate slugs', () => {
    expect(() => parseMeta({ ...meta, pages: ['../secret'] })).toThrow(/unsafe|invalid/);
    expect(() => parseMeta({ ...meta, pages: ['---   ---'] })).toThrow(/unsafe|invalid/);
    expect(() => parseMeta({ ...meta, pages: ['quickstart', 'quickstart'] })).toThrow(/duplicate/);
    expect(() => parseMeta({ ...meta, pagesIndex: 'quickstart' })).toThrow(/must not also appear/);
    expect(() => parseManifest({ ...manifest, pages: ['../secret'] })).toThrow(/unsafe|invalid/);
    expect(() => parseManifest({ ...manifest, pages: ['quickstart', 'quickstart'] })).toThrow(/duplicate/);
  });

  it('requires the public frontmatter contract', () => {
    expect(
      parseFrontmatter("---\ntitle: 'Test'\ndescription: 'A page'\nupdated: '2026-07-14'\ndraft: false\n---\n"),
    ).toMatchObject({
      title: 'Test',
      draft: false,
    });
    expect(() => parseFrontmatter("---\ntitle: 'Test'\ndescription: 'A page'\nupdated: '2026-02-30'\n---\n")).toThrow(
      /updated date/,
    );
    expect(() => parseFrontmatter("---\ntitle: 'Test'\ncategory: 'Wrong owner'\n---\n")).toThrow();
  });

  it('updates only a marked generated section', () => {
    expect(
      replaceGeneratedSection(
        'before\n<!-- BEGIN GENERATED:test -->\nold\n<!-- END GENERATED:test -->\nafter',
        'test',
        'new',
      ),
    ).toBe('before\n<!-- BEGIN GENERATED:test -->\nnew\n<!-- END GENERATED:test -->\nafter');
  });

  it('resolves folder indexes and nested pages in navigation order', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fluxmail-public-docs-'));
    try {
      const pages = path.join(root, 'pages');
      const restApi = path.join(pages, 'rest-api');
      mkdirSync(restApi, { recursive: true });
      writeFileSync(path.join(pages, 'overview.md'), 'overview');
      writeFileSync(path.join(restApi, 'index.md'), 'index');
      writeFileSync(path.join(restApi, 'list-accounts.md'), 'accounts');
      writeFileSync(
        path.join(restApi, 'meta.json'),
        JSON.stringify({
          title: 'REST API',
          pagesIndex: 'index',
          defaultOpen: false,
          pages: ['list-accounts'],
        }),
      );

      expect(
        publicDocPages(
          { title: 'Fluxmail MCP', pages: ['---Getting started---', 'overview', '---Reference---', 'rest-api'] },
          root,
        ),
      ).toEqual([
        { slug: 'overview', filename: 'overview.md' },
        { slug: 'rest-api', filename: 'rest-api/index.md' },
        { slug: 'rest-api/list-accounts', filename: 'rest-api/list-accounts.md' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
