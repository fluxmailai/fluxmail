import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudePlugin,
  checkClaudePlugin,
  publishClaudePlugin,
  syncClaudePlugin,
  validatePluginLock,
} from './claude-code-plugin.mjs';
import { repositoryRoot } from './release-config.mjs';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const git = async (root: string, ...args: string[]) => (await execute('git', args, { cwd: root })).stdout.trim();

async function fixture(version = '0.11.2') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'fluxmail-plugin-test-'));
  temporaryDirectories.push(temporary);
  const root = path.join(temporary, 'checkout');
  await mkdir(path.join(root, 'packages/server'), { recursive: true });
  await mkdir(path.join(root, 'integrations'), { recursive: true });
  await cp(path.join(repositoryRoot, 'integrations/claude-code'), path.join(root, 'integrations/claude-code'), {
    recursive: true,
  });
  await writeFile(
    path.join(root, 'packages/server/package.json'),
    JSON.stringify({
      name: 'fluxmail',
      version,
      repository: { url: 'git+https://github.com/fluxmailai/fluxmail.git', directory: 'packages/server' },
    }),
  );
  await syncClaudePlugin(root);
  return { root, temporary };
}

async function fixtureLock(directory: string) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const version = manifest.dependencies.fluxmail;
  await writeFile(
    path.join(directory, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { fluxmail: version } },
        'node_modules/fluxmail': {
          version,
          resolved: `https://registry.npmjs.org/fluxmail/-/fluxmail-${version}.tgz`,
          integrity: 'sha512-dGVzdA==',
        },
      },
    }),
  );
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Claude Code plugin release automation', () => {
  it('updates both the manifest and runtime dependency when the Fluxmail version changes', async () => {
    const { root } = await fixture();
    const packagePath = path.join(root, 'packages/server/package.json');
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    await writeFile(packagePath, JSON.stringify({ ...manifest, version: '0.12.0' }));
    await expect(checkClaudePlugin(root)).rejects.toThrow('must use Fluxmail version 0.12.0');
    const manifestPath = path.join(root, 'integrations/claude-code/.claude-plugin/plugin.json');
    const manifestSource = await readFile(manifestPath, 'utf8');
    await syncClaudePlugin(root);
    await expect(checkClaudePlugin(root)).resolves.toBe('0.12.0');
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestSource.replace('0.11.2', '0.12.0'));
    const config = JSON.parse(await readFile(path.join(root, 'integrations/claude-code/.mcp.json'), 'utf8'));
    expect(config.mcpServers.fluxmail.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/launch.mjs',
      'stdio',
      '--profile',
      'read-only',
    ]);
    expect(config.mcpServers.fluxmail.env?.FLUXMAIL_TELEMETRY).toBeUndefined();
    expect(config.mcpServers.fluxmail.env?.DO_NOT_TRACK).toBeUndefined();
  });

  it.each(['latest', '^0.11.2', '0.11.1'])(
    'rejects an unreviewed or stale launcher package: %s',
    async (packageName) => {
      const { root } = await fixture();
      const packagePath = path.join(root, 'integrations/claude-code/runtime/package.json');
      const config = await readFile(packagePath, 'utf8');
      await writeFile(packagePath, config.replace('0.11.2', packageName));
      await expect(checkClaudePlugin(root)).rejects.toThrow('must depend on fluxmail@0.11.2');
    },
  );

  it('rejects registry launchers and writable default profiles', async () => {
    const { root } = await fixture();
    const file = path.join(root, 'integrations/claude-code/.mcp.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.mcpServers.fluxmail.command = 'npx';
    await writeFile(file, JSON.stringify(config));
    await expect(checkClaudePlugin(root)).rejects.toThrow('local launcher');
    config.mcpServers.fluxmail.command = 'node';
    config.mcpServers.fluxmail.args[3] = 'full';
    await writeFile(file, JSON.stringify(config));
    await expect(checkClaudePlugin(root)).rejects.toThrow('read-only');
  });

  it('builds a locked bundle and reuses its resolution until the release changes', async () => {
    const { root, temporary } = await fixture();
    const destination = path.join(temporary, 'bundle');
    await buildClaudePlugin({ root, destination, resolveLock: fixtureLock });
    const lockPath = path.join(destination, 'runtime/package-lock.json');
    const before = await readFile(lockPath, 'utf8');
    await buildClaudePlugin({
      root,
      destination,
      resolveLock: async () => {
        throw new Error('Must reuse the lock');
      },
    });
    expect(await readFile(lockPath, 'utf8')).toBe(before);
    await writeFile(lockPath, before.replaceAll('0.11.2', '0.11.1'));
    await buildClaudePlugin({ root, destination, resolveLock: fixtureLock });
    expect(await readFile(lockPath, 'utf8')).toBe(before);
  });

  it.each([
    { version: '^1.0.0' },
    { resolved: 'file:../local' },
    { resolved: 'https://untrusted.example/package.tgz' },
    { integrity: undefined },
    { link: true },
  ])('rejects dependencies without a fixed registry artifact: %j', async (invalid) => {
    const { root, temporary } = await fixture();
    const destination = path.join(temporary, 'bundle');
    await buildClaudePlugin({ root, destination, resolveLock: fixtureLock });
    const lock = JSON.parse(await readFile(path.join(destination, 'runtime/package-lock.json'), 'utf8'));
    lock.packages['node_modules/transitive'] = { ...lock.packages['node_modules/fluxmail'], ...invalid };
    expect(() => validatePluginLock(lock, { dependencies: { fluxmail: '0.11.2' } })).toThrow('exact npm version');
  });

  it('rejects a damaged published lock instead of silently changing dependencies', async () => {
    const { root, temporary } = await fixture();
    const destination = path.join(temporary, 'bundle');
    await buildClaudePlugin({ root, destination, resolveLock: fixtureLock });
    const lockPath = path.join(destination, 'runtime/package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    delete lock.packages['node_modules/fluxmail'].integrity;
    await expect(
      buildClaudePlugin({
        root,
        destination,
        previousLock: JSON.stringify(lock),
        resolveLock: async () => {
          throw new Error('Must not resolve new dependencies');
        },
      }),
    ).rejects.toThrow('SHA-512 integrity');
  });

  it('rejects a bundle file beyond the review size limit', async () => {
    const { root, temporary } = await fixture();
    await writeFile(path.join(root, 'integrations/claude-code/launch.mjs'), ' '.repeat(256 * 1024));
    await expect(
      buildClaudePlugin({ root, destination: path.join(temporary, 'bundle'), resolveLock: fixtureLock }),
    ).rejects.toThrow('smaller than 256 KiB');
  });

  it('fails the bundle build when dependency resolution fails', async () => {
    const { root, temporary } = await fixture();
    await expect(
      buildClaudePlugin({
        root,
        destination: path.join(temporary, 'bundle'),
        resolveLock: async () => {
          throw new Error('Registry unavailable');
        },
      }),
    ).rejects.toThrow('Registry unavailable');
  });

  it('rejects missing local icons', async () => {
    const { root } = await fixture();
    const bundle = path.join(root, 'integrations/claude-code');
    await rm(path.join(bundle, 'icon.png'));
    await expect(checkClaudePlugin(root)).rejects.toThrow();
  });

  it('skips historical retries and rejects prerelease or unreleased manual refreshes before Git writes', async () => {
    const { root } = await fixture();
    await expect(
      publishClaudePlugin({ root, latestVersion: async () => '0.12.0', skipStale: true }),
    ).resolves.toMatchObject({ status: 'skipped' });
    await expect(publishClaudePlugin({ root, latestVersion: async () => '0.12.0' })).rejects.toThrow(
      'must match stable npm latest',
    );
    const prerelease = await fixture('0.12.0-beta.1');
    await syncClaudePlugin(prerelease.root);
    await expect(
      publishClaudePlugin({ root: prerelease.root, latestVersion: async () => '0.12.0-beta.1' }),
    ).rejects.toThrow('must match stable npm latest');
  });

  it('publishes an ordinary commit, removes stale bundle files, and makes retries idempotent without changing the checkout', async () => {
    const { root, temporary } = await fixture();
    const remote = path.join(temporary, 'remote.git');
    await execute('git', ['init', '--bare', remote]);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Plugin test');
    await git(root, 'config', 'user.email', 'plugin-test@example.com');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'Source');
    const sourceSha = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'checkout', '--orphan', 'claude-code-plugin');
    await git(root, 'rm', '-r', '-f', '.');
    await writeFile(path.join(root, 'obsolete.txt'), 'Old bundle');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'Previous bundle');
    const previousSha = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'push', 'origin', 'claude-code-plugin');
    await git(root, 'checkout', 'main');

    const options = { root, latestVersion: async () => '0.11.2', resolveLock: fixtureLock };
    const result = await publishClaudePlugin(options);
    expect(result.status).toBe('published');
    expect(await git(root, 'show', `${result.sha}^:obsolete.txt`)).toBe('Old bundle');
    expect(await git(root, 'rev-parse', `${result.sha}^`)).toBe(previousSha);
    expect(await git(root, 'ls-tree', '--name-only', result.sha)).not.toContain('obsolete.txt');
    expect(JSON.parse(await git(root, 'show', `${result.sha}:.claude-plugin/plugin.json`)).version).toBe('0.11.2');
    expect(
      JSON.parse(await git(root, 'show', `${result.sha}:runtime/package-lock.json`)).packages['node_modules/fluxmail']
        .version,
    ).toBe('0.11.2');
    expect(JSON.parse(await git(root, 'show', `${result.sha}:.mcp.json`)).mcpServers.fluxmail.command).toBe('node');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(sourceSha);
    expect(await git(root, 'status', '--porcelain')).toBe('');
    expect(
      await publishClaudePlugin({
        ...options,
        resolveLock: async () => {
          throw new Error('Retry must reuse the published lock');
        },
      }),
    ).toEqual({ status: 'unchanged', version: '0.11.2', sha: result.sha });
    expect((await git(root, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
  });
});
