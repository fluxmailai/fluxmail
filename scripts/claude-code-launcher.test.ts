import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureRuntime, runNpm } from '../integrations/claude-code/launch.mjs';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'fluxmail launcher test '));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'runtime'));
  const dependencies = { fluxmail: '0.15.0' };
  await writeFile(path.join(root, 'runtime/package.json'), JSON.stringify({ dependencies }));
  await writeFile(
    path.join(root, 'runtime/package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies }, 'node_modules/fluxmail': { version: '0.15.0' } },
    }),
  );
  return { root, dataDirectory: path.join(root, 'plugin data') };
}

async function fakeInstall(args: string[], cwd: string) {
  if (args[0] === 'ci') {
    const directory = path.join(cwd, 'node_modules/fluxmail/dist');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'cli.js'), '');
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Claude Code plugin launcher', () => {
  it('installs from the shipped lock without install scripts and reuses a completed installation', async () => {
    const options = await fixture();
    const install = vi.fn(fakeInstall);
    const entry = await ensureRuntime({ ...options, install });
    expect(install.mock.calls.map(([args]) => args)).toEqual([
      ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund'],
    ]);
    expect(
      await readFile(
        path.join(path.dirname(path.dirname(path.dirname(path.dirname(entry)))), 'package-lock.json'),
        'utf8',
      ),
    ).toBe(await readFile(path.join(options.root, 'runtime/package-lock.json'), 'utf8'));
    expect(await ensureRuntime({ ...options, install })).toBe(entry);
    expect(install).toHaveBeenCalledTimes(1);
    // Package and lock changes must select a new cache directory.
    const lockPath = path.join(options.root, 'runtime/package-lock.json');
    await writeFile(lockPath, `${await readFile(lockPath, 'utf8')}\n`);
    expect(await ensureRuntime({ ...options, install })).not.toBe(entry);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('cleans up a failed installation and retries on the next start', async () => {
    const options = await fixture();
    const install = vi.fn(async (args: string[], cwd: string) => {
      await fakeInstall(args, cwd);
      throw new Error('Installation failed');
    });
    await expect(ensureRuntime({ ...options, install })).rejects.toThrow('Installation failed');
    expect(await readdir(path.join(options.dataDirectory, 'runtimes'))).toEqual([]);
    await expect(ensureRuntime({ ...options, install: fakeInstall })).resolves.toContain('cli.js');
  });

  it('allows concurrent starts without exposing a partial installation', async () => {
    const options = await fixture();
    const entries = await Promise.all([
      ensureRuntime({ ...options, install: fakeInstall }),
      ensureRuntime({ ...options, install: fakeInstall }),
    ]);
    expect(entries[0]).toBe(entries[1]);
    expect(await readdir(path.join(options.dataDirectory, 'runtimes'))).toHaveLength(1);
  });

  it('accepts a Windows rename conflict when another start completed the installation', async () => {
    const options = await fixture();
    const install = async (args: string[], cwd: string) => {
      await ensureRuntime({ ...options, install: fakeInstall });
      await fakeInstall(args, cwd);
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }));
    };
    await expect(ensureRuntime({ ...options, install })).resolves.toContain('cli.js');
    expect(await readdir(path.join(options.dataDirectory, 'runtimes'))).toHaveLength(1);
  });

  it('fails before installation for missing or mismatched locks and missing data directories', async () => {
    const options = await fixture();
    const install = vi.fn(fakeInstall);
    await expect(ensureRuntime({ ...options, dataDirectory: '', install })).rejects.toThrow('CLAUDE_PLUGIN_DATA');
    const lockPath = path.join(options.root, 'runtime/package-lock.json');
    await writeFile(lockPath, (await readFile(lockPath, 'utf8')).replaceAll('0.15.0', '0.14.0'));
    await expect(ensureRuntime({ ...options, install })).rejects.toThrow('does not match');
    await rm(lockPath);
    await expect(ensureRuntime({ ...options, install })).rejects.toThrow('missing its dependency lockfile');
    expect(install).not.toHaveBeenCalled();
  });

  it('keeps npm output off stdout', async () => {
    const { root } = await fixture();
    const launcher = path.resolve('integrations/claude-code/launch.mjs');
    const runner = path.join(root, 'output.mjs');
    await writeFile(
      runner,
      `import { runNpm } from ${JSON.stringify(pathToFileURL(launcher).href)};\nawait runNpm(['--version'], ${JSON.stringify(root)});`,
    );
    const { stdout, stderr } = await execute(process.execPath, [runner]);
    expect(stdout).toBe('');
    expect(stderr.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('reports failed npm commands', async () => {
    const { root } = await fixture();
    await expect(runNpm(['run', 'missing-script'], root)).rejects.toThrow('dependency setup failed');
  });
});
