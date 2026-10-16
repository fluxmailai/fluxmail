import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { withFileLock } from '../src/storage/fileLock.js';

const runFile = promisify(execFile);
const fileLockModuleUrl = new URL('../src/storage/fileLock.ts', import.meta.url).href;

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe('file lock', () => {
  it('does not remove a replacement lock owned by another operation', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-file-lock-'));
    const lockPath = path.join(directory, 'operation.lock');
    const replacement = {
      token: 'replacement-owner',
      pid: process.pid,
      hostname: hostname(),
      createdAt: Date.now(),
    };

    withFileLock(lockPath, { timeoutMs: 1_000, staleMs: 30_000, description: 'the test operation' }, () => {
      rmSync(lockPath);
      writeFileSync(lockPath, JSON.stringify(replacement), { mode: 0o600 });
    });

    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
    rmSync(lockPath);
  });

  it('serializes processes that recover the same abandoned lock', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-file-lock-'));
    const lockPath = path.join(directory, 'operation.lock');
    const criticalSectionPath = path.join(directory, 'critical-section');
    writeFileSync(
      lockPath,
      JSON.stringify({ token: 'abandoned-owner', pid: 99_999_999, hostname: hostname(), createdAt: 0 }),
      { mode: 0o600 },
    );
    const script = `
      import { mkdirSync, rmdirSync } from 'node:fs';
      import { withFileLock } from ${JSON.stringify(fileLockModuleUrl)};
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      withFileLock(
        process.argv[1],
        { timeoutMs: 5_000, staleMs: 30_000, description: 'the test operation' },
        () => {
          mkdirSync(process.argv[2]);
          Atomics.wait(waitArray, 0, 0, 50);
          rmdirSync(process.argv[2]);
        },
      );
    `;

    await Promise.all(
      Array.from({ length: 12 }, () =>
        runFile(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          lockPath,
          criticalSectionPath,
        ]),
      ),
    );

    expect(readdirSync(directory)).toEqual([]);
  });

  it('keeps a long-running lock fresh for waiters on another host', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-file-lock-'));
    const lockPath = path.join(directory, 'operation.lock');
    const criticalSectionPath = path.join(directory, 'critical-section');
    const readyPath = path.join(directory, 'ready');
    const ownerScript = `
      import { mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
      import { withFileLock } from ${JSON.stringify(fileLockModuleUrl)};
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      withFileLock(
        process.argv[1],
        { timeoutMs: 5_000, staleMs: 500, description: 'the test operation' },
        () => {
          mkdirSync(process.argv[2]);
          writeFileSync(process.argv[3], 'ready');
          Atomics.wait(waitArray, 0, 0, 1_500);
          rmdirSync(process.argv[2]);
        },
      );
    `;
    const contenderScript = `
      import { mkdirSync, rmdirSync } from 'node:fs';
      import { withFileLock } from ${JSON.stringify(fileLockModuleUrl)};
      withFileLock(
        process.argv[1],
        { timeoutMs: 5_000, staleMs: 500, description: 'the test operation' },
        () => {
          mkdirSync(process.argv[2]);
          rmdirSync(process.argv[2]);
        },
      );
    `;

    const owner = runFile(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      ownerScript,
      lockPath,
      criticalSectionPath,
      readyPath,
    ]);
    await waitForFile(readyPath);
    const lockOwner = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    // Replace the file atomically so the owner's heartbeat never reads a partly written lock and stops.
    const remoteOwnerPath = `${lockPath}.remote`;
    writeFileSync(remoteOwnerPath, JSON.stringify({ ...lockOwner, hostname: 'another-host' }), { mode: 0o600 });
    renameSync(remoteOwnerPath, lockPath);

    await Promise.all([
      owner,
      runFile(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        contenderScript,
        lockPath,
        criticalSectionPath,
      ]),
    ]);

    expect(readdirSync(directory)).toEqual(['ready']);
  }, 15_000);
});
