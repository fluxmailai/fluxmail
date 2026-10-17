#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadReleaseVersion, repositoryRoot } from './release-config.mjs';

const execute = promisify(execFile);
const bundleDirectory = 'integrations/claude-code';
const sourceBranch = 'claude-code-plugin';

export async function syncClaudePlugin(root = repositoryRoot) {
  const { version } = await loadReleaseVersion(root);
  const manifestPath = path.join(root, bundleDirectory, '.claude-plugin/plugin.json');
  const manifestSource = await readFile(manifestPath, 'utf8');
  JSON.parse(manifestSource);
  await writeFile(manifestPath, manifestSource.replace(/("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(version)}`));
  const packagePath = path.join(root, bundleDirectory, 'runtime/package.json');
  const packageSource = await readFile(packagePath, 'utf8');
  const runtime = JSON.parse(packageSource);
  await writeFile(
    packagePath,
    packageSource.replace(JSON.stringify(runtime.dependencies.fluxmail), JSON.stringify(version)),
  );
}

export async function checkClaudePlugin(root = repositoryRoot) {
  const { version } = await loadReleaseVersion(root);
  const bundle = path.join(root, bundleDirectory);
  const manifest = JSON.parse(await readFile(path.join(bundle, '.claude-plugin/plugin.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`Claude Code plugin must use Fluxmail version ${version}.`);
  if (manifest.icon !== './icon.png') throw new Error('Claude Code plugin icon must be ./icon.png.');
  const icon = await readFile(path.join(bundle, 'icon.png'));
  if (!icon.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error('Claude Code plugin icon must be a PNG.');
  }
  const config = JSON.parse(await readFile(path.join(bundle, '.mcp.json'), 'utf8'));
  const server = config.mcpServers?.fluxmail;
  if (
    server?.command !== 'node' ||
    JSON.stringify(server.args) !==
      JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/launch.mjs', 'stdio', '--profile', 'read-only'])
  ) {
    throw new Error(`Claude Code plugin must run its local launcher with read-only permissions.`);
  }
  const runtime = JSON.parse(await readFile(path.join(bundle, 'runtime/package.json'), 'utf8'));
  if (JSON.stringify(runtime.dependencies) !== JSON.stringify({ fluxmail: version })) {
    throw new Error(`Claude Code plugin must depend on fluxmail@${version}.`);
  }
  await readFile(path.join(bundle, 'launch.mjs'));
  return version;
}

export function validatePluginLock(lock, runtime) {
  if (
    lock.lockfileVersion !== 3 ||
    JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(runtime.dependencies) ||
    lock.packages?.['node_modules/fluxmail']?.version !== runtime.dependencies.fluxmail
  ) {
    throw new Error('Claude Code plugin lockfile must match its runtime package.');
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version ?? '') ||
      entry.link ||
      !entry.resolved?.startsWith('https://registry.npmjs.org/') ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')
    ) {
      throw new Error(
        `Claude Code plugin dependency ${name} must have an exact npm version, registry URL, and SHA-512 integrity.`,
      );
    }
  }
}

async function readOptionalFile(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function resolvePluginLock(directory) {
  await execute(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ],
    {
      cwd: directory,
      timeout: 120_000,
    },
  );
}

export async function buildClaudePlugin({
  root = repositoryRoot,
  destination = path.join(root, '.context/claude-code-plugin'),
  previousLock,
  resolveLock = resolvePluginLock,
} = {}) {
  const version = await checkClaudePlugin(root);
  // Copy only the maintained bundle files, never locally installed dependencies.
  await mkdir(destination, { recursive: true });
  for (const file of [
    '.claude-plugin/plugin.json',
    '.mcp.json',
    'icon.png',
    'LICENSE.md',
    'README.md',
    'launch.mjs',
    'runtime/package.json',
  ]) {
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await cp(path.join(root, bundleDirectory, file), path.join(destination, file));
  }
  const runtimeDirectory = path.join(destination, 'runtime');
  const runtime = JSON.parse(await readFile(path.join(runtimeDirectory, 'package.json'), 'utf8'));
  const lockPath = path.join(runtimeDirectory, 'package-lock.json');
  // Preserve an already published resolution on retries and wrapper-only updates.
  // A new Fluxmail version gets a fresh lock after its packages reach npm.
  const lockSource = previousLock ?? (await readOptionalFile(lockPath));
  const reusable =
    lockSource && JSON.parse(lockSource).packages?.['node_modules/fluxmail']?.version === runtime.dependencies.fluxmail;
  if (reusable) await writeFile(lockPath, lockSource);
  else {
    await rm(lockPath, { force: true });
    await resolveLock(runtimeDirectory);
  }
  validatePluginLock(JSON.parse(await readFile(lockPath, 'utf8')), runtime);

  const files = await readdir(destination, { recursive: true, withFileTypes: true });
  const regularFiles = files.filter((file) => file.isFile());
  if (regularFiles.length > 512) throw new Error('Claude Code plugin must contain no more than 512 files.');
  for (const file of regularFiles) {
    if ((await stat(path.join(file.parentPath, file.name))).size >= 256 * 1024) {
      throw new Error(`Claude Code plugin file ${file.name} must be smaller than 256 KiB.`);
    }
  }
  return { version, destination };
}

async function npmLatestVersion() {
  const response = await fetch('https://registry.npmjs.org/fluxmail/latest', {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cannot read stable Fluxmail version from npm: HTTP ${response.status}.`);
  const { version } = await response.json();
  if (typeof version !== 'string') throw new Error('npm latest metadata must include a Fluxmail version.');
  return version;
}

export async function publishClaudePlugin({
  root = repositoryRoot,
  latestVersion = npmLatestVersion,
  skipStale = false,
  resolveLock = resolvePluginLock,
} = {}) {
  const version = await checkClaudePlugin(root);
  const latest = await latestVersion();
  if (version.includes('-') || version !== latest) {
    if (skipStale) return { status: 'skipped', version, latest };
    throw new Error(`Plugin source version ${version} must match stable npm latest ${latest}.`);
  }

  const git = async (args, cwd = root) => (await execute('git', args, { cwd })).stdout.trim();
  const sourceSha = await git(['rev-parse', 'HEAD']);
  const temporary = await mkdtemp(path.join(tmpdir(), 'fluxmail-claude-plugin-'));
  const worktree = path.join(temporary, 'source');
  let added = false;
  try {
    await git(['fetch', 'origin', `${sourceBranch}:refs/remotes/origin/${sourceBranch}`]);
    await git(['worktree', 'add', '--detach', worktree, `refs/remotes/origin/${sourceBranch}`]);
    added = true;
    const previousLock = await readOptionalFile(path.join(worktree, 'runtime/package-lock.json'));
    await git(['rm', '-r', '--ignore-unmatch', '--', '.'], worktree);
    await buildClaudePlugin({ root, destination: worktree, previousLock, resolveLock });
    await git(['add', '--all'], worktree);
    const changes = await git(['diff', '--cached', '--name-only'], worktree);
    if (!changes) return { status: 'unchanged', version, sha: await git(['rev-parse', 'HEAD'], worktree) };
    await git(
      [
        '-c',
        'user.name=Fluxmail release',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit',
        '-m',
        `Update Claude Code plugin for Fluxmail ${version}`,
        '-m',
        `Source: ${sourceSha}`,
      ],
      worktree,
    );
    await git(['push', 'origin', `HEAD:refs/heads/${sourceBranch}`], worktree);
    return { status: 'published', version, sha: await git(['rev-parse', 'HEAD'], worktree) };
  } finally {
    if (added) await git(['worktree', 'remove', '--force', worktree]);
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(args) {
  const [command, ...options] = args;
  if (options.some((option) => command !== 'publish' || option !== '--skip-stale')) {
    throw new Error('Usage: claude-code-plugin.mjs check|sync|build|publish [--skip-stale]');
  }
  if (command === 'sync') await syncClaudePlugin();
  else if (command === 'build') console.log(JSON.stringify(await buildClaudePlugin()));
  else if (command === 'check') console.log(`Claude Code plugin matches Fluxmail ${await checkClaudePlugin()}.`);
  else if (command === 'publish')
    console.log(JSON.stringify(await publishClaudePlugin({ skipStale: options.includes('--skip-stale') })));
  else throw new Error('Usage: claude-code-plugin.mjs check|sync|build|publish [--skip-stale]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
