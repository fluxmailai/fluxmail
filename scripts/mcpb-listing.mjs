#!/usr/bin/env node

// After a stable release, opens or updates the issue that asks a maintainer to publish the new MCP bundle to
// Smithery. The bundle contains the server itself, so every stable release needs one. Smithery publishing needs an
// interactive sign-in, so the release workflow can't do it.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { repositoryRoot } from './release-config.mjs';

const execute = promisify(execFile);
export const issueTitle = 'Smithery: publish the latest MCP bundle';
const templatePath = 'mcpb/manifest.template.json';

const stable = /^v(\d+)\.(\d+)\.(\d+)$/;
const parts = (tag) => tag.match(stable).slice(1).map(Number);
const compare = (left, right) => {
  const [a, b] = [parts(left), parts(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};

/** The newest stable tag older than `version`, or undefined for the first release. */
export function previousStableTag(tags, version) {
  const current = `v${version}`;
  return tags
    .filter((tag) => stable.test(tag) && compare(tag, current) < 0)
    .sort(compare)
    .at(-1);
}

/** Compares two MCPB tool lists. A renamed tool shows up as one removed and one added tool. */
export function compareTools(before, after) {
  const old = new Map(before.map((tool) => [tool.name, tool]));
  const next = new Map(after.map((tool) => [tool.name, tool]));
  return {
    added: after.filter((tool) => !old.has(tool.name)).map((tool) => tool.name),
    removed: before.filter((tool) => !next.has(tool.name)).map((tool) => tool.name),
    changed: after
      .filter((tool) => old.has(tool.name) && old.get(tool.name).description !== tool.description)
      .map((tool) => tool.name),
  };
}

const code = (names) => names.map((name) => `\`${name}\``).join(', ');

// The issue records the release Smithery last got, so a release that nobody published to Smithery keeps its
// tool changes in the list when a later release updates the issue.
const sinceMarker = /<!-- smithery-since: (v\d+\.\d+\.\d+) -->/;

/** The tag recorded in an earlier version of the issue body, if any. */
export function recordedSince(body) {
  return body?.match(sinceMarker)?.[1];
}

export function issueBody({ version, previous, changes, toolCount, runUrl }) {
  const { added, removed, changed } = changes;
  const lines = [
    `Fluxmail ${version} is on npm. Publish its MCP bundle to the [Smithery listing](https://smithery.ai/servers/fluxmail/fluxmail).`,
    '',
  ];
  if (!previous) lines.push('This is the first stable release with a bundle.');
  else if (added.length + removed.length + changed.length === 0)
    lines.push(`The tool list is the same as in ${previous}. The bundle still carries this release's other changes.`);
  else {
    lines.push(`Tool changes since ${previous}:`, '');
    if (added.length) lines.push(`- New: ${code(added)}`);
    if (changed.length) lines.push(`- New listing text: ${code(changed)}`);
    if (removed.length) lines.push(`- Removed: ${code(removed)}`);
  }
  lines.push(
    '',
    '### To do',
    '',
    runUrl
      ? `- [ ] Download the \`fluxmail-mcpb\` artifact from the [MCP bundle run](${runUrl}) for the release commit once its first job has passed. If the run has no artifact, build the bundle from the release commit with \`pnpm mcpb:build\`.`
      : `- [ ] Build the bundle from the release commit with \`pnpm mcpb:build\`. No MCP bundle run for the release commit was found.`,
    '- [ ] Sign in with `smithery auth login`.',
    `- [ ] Run \`smithery mcp publish fluxmail-${version}-smithery.mcpb -n fluxmail/fluxmail\`.`,
    `- [ ] Check that the listing shows version ${version} and ${toolCount} tools.`,
    '- [ ] Close this issue.',
  );
  if (previous) lines.push('', `<!-- smithery-since: ${previous} -->`);
  return `${lines.join('\n')}\n`;
}

async function gh(args, input) {
  const child = execute('gh', args, { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 });
  if (input !== undefined) child.child.stdin.end(input);
  return (await child).stdout.trim();
}

async function git(args) {
  return (await execute('git', args, { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

// Only an issue this workflow opened is reused: anyone can open an issue with the same title.
const botAuthor = 'app/github-actions';

async function main() {
  const { RELEASE_VERSION: version, RELEASE_SHA: sha, GITHUB_REPOSITORY: repository } = process.env;
  if (!version || !sha || !repository) throw new Error('Set RELEASE_VERSION, RELEASE_SHA and GITHUB_REPOSITORY.');
  const tools = JSON.parse(await readFile(path.join(repositoryRoot, templatePath), 'utf8')).tools;
  const tags = (await git(['tag', '--list', 'v*'])).split('\n').filter(Boolean);
  // Search results lag behind new issues, so list them and match the title and author.
  const open = JSON.parse(
    await gh([
      'issue',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--author',
      botAuthor,
      '--limit',
      '1000',
      '--json',
      'number,title,author,body',
    ]),
  ).find((issue) => issue.title === issueTitle && issue.author?.login === botAuthor);
  const recorded = recordedSince(open?.body);
  const previous = recorded && tags.includes(recorded) ? recorded : previousStableTag(tags, version);
  const before = previous ? JSON.parse(await git(['show', `${previous}:${templatePath}`])).tools : [];
  // The newest push run for the release commit, in any state. Its first job uploads the bundle.
  const runs = JSON.parse(
    await gh([
      'run',
      'list',
      '--repo',
      repository,
      '--workflow',
      'mcpb.yml',
      '--commit',
      sha,
      '--event',
      'push',
      '--json',
      'url',
      '--limit',
      '1',
    ]),
  );
  const body = issueBody({
    version,
    previous,
    changes: compareTools(before, tools),
    toolCount: tools.length,
    runUrl: runs[0]?.url,
  });
  if (!open) {
    const url = await gh(['issue', 'create', '--repo', repository, '--title', issueTitle, '--body-file', '-'], body);
    console.log(`Opened ${url}.`);
  } else if (open.body.trim() === body.trim()) {
    console.log(`Issue #${open.number} is already up to date.`);
  } else {
    await gh(['issue', 'edit', String(open.number), '--repo', repository, '--body-file', '-'], body);
    await gh([
      'issue',
      'comment',
      String(open.number),
      '--repo',
      repository,
      '--body',
      `Updated for Fluxmail ${version}.`,
    ]);
    console.log(`Updated issue #${open.number} for Fluxmail ${version}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
