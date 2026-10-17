import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));

export function runNpm(args, cwd) {
  return new Promise((resolve, reject) => {
    // All arguments are fixed by this launcher. npm.cmd needs a shell on Windows.
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd,
      shell: process.platform === 'win32',
      // npm output must never reach the MCP protocol stream on stdout.
      stdio: ['ignore', 2, 2],
    });
    const signals = ['SIGINT', 'SIGTERM'];
    const forward = (signal) => child.kill(signal);
    for (const signal of signals) process.on(signal, forward);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      for (const name of signals) process.off(name, forward);
      if (code === 0) resolve();
      else
        reject(
          new Error(`Fluxmail plugin dependency setup failed (${signal ?? code}). Restart the MCP server to retry.`),
        );
    });
  });
}

export async function ensureRuntime({
  root = pluginRoot,
  dataDirectory = process.env.CLAUDE_PLUGIN_DATA,
  install = runNpm,
} = {}) {
  if (!dataDirectory || !path.isAbsolute(dataDirectory)) {
    throw new Error('Claude Code must provide CLAUDE_PLUGIN_DATA. Update Claude Code and restart the plugin.');
  }
  const packageSource = await readFile(path.join(root, 'runtime/package.json'), 'utf8');
  let lockSource;
  try {
    lockSource = await readFile(path.join(root, 'runtime/package-lock.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('The Fluxmail plugin is missing its dependency lockfile. Reinstall the plugin.');
  }
  const manifest = JSON.parse(packageSource);
  const lock = JSON.parse(lockSource);
  if (
    lock.lockfileVersion !== 3 ||
    JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(manifest.dependencies) ||
    lock.packages?.['node_modules/fluxmail']?.version !== manifest.dependencies.fluxmail
  ) {
    throw new Error('The Fluxmail plugin dependency lockfile does not match its package. Reinstall the plugin.');
  }

  const digest = createHash('sha256')
    .update(packageSource)
    .update(lockSource)
    .update(`${process.platform}-${process.arch}-${process.versions.modules}`)
    .digest('hex');
  const cache = path.join(dataDirectory, 'runtimes');
  const destination = path.join(cache, digest);
  const entry = path.join(destination, 'node_modules/fluxmail/dist/cli.js');
  const ready = async () => {
    try {
      await access(path.join(destination, '.ready'));
      await access(entry);
      return true;
    } catch {
      return false;
    }
  };
  if (await ready()) return entry;

  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(cache, '.install-'));
  try {
    await writeFile(path.join(staging, 'package.json'), packageSource);
    await writeFile(path.join(staging, 'package-lock.json'), lockSource);
    console.error('Installing the locked Fluxmail plugin dependencies. The first start may take a few minutes.');
    // better-sqlite3 and Argon2 ship prebuilt Node-API binaries, so no install script needs to run.
    await install(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], staging);
    await access(path.join(staging, 'node_modules/fluxmail/dist/cli.js'));
    await writeFile(path.join(staging, '.ready'), '');
    try {
      await rename(staging, destination);
    } catch (error) {
      // Another MCP process may have finished the same installation first. Windows reports EPERM.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !(await ready())) throw error;
    }
    return entry;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const entry = await ensureRuntime();
  process.argv = [process.execPath, entry, ...process.argv.slice(2)];
  await import(pathToFileURL(entry).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
