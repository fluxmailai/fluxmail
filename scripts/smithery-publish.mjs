#!/usr/bin/env node

// Prepares a stable release's MCP bundle for Smithery: it waits for the MCP bundle run of the release commit,
// downloads the archive that run built and verified, and writes its path as the `bundle` step output. The
// workflow publishes it with the pinned Smithery CLI in a separate step that alone holds the API key.
import { execFile } from 'node:child_process';
import { access, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const smitheryServer = 'fluxmail/fluxmail';

export function bundleName(version) {
  return `fluxmail-${version}-smithery.mcpb`;
}

/** Why this release shouldn't be published, or undefined when it should. */
export function skipReason(version, latest) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return `${version} is not a stable version.`;
  if (version !== latest)
    return `${version} is not npm's latest version (${latest}), so Smithery keeps the newer bundle.`;
  return undefined;
}

/** Whether the MCP bundle run is done, and throws when it can't provide the bundle. */
export function runReady(run, sha) {
  if (!run) throw new Error(`No MCP bundle run was found for ${sha}.`);
  if (run.headSha !== sha) throw new Error(`The MCP bundle run ${run.url} is for ${run.headSha}, not ${sha}.`);
  if (run.status !== 'completed') return false;
  if (run.conclusion !== 'success') throw new Error(`The MCP bundle run ${run.url} ended with ${run.conclusion}.`);
  return true;
}

async function gh(args) {
  return (await execute('gh', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

async function npmLatest() {
  const response = await fetch('https://registry.npmjs.org/fluxmail/latest', { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cannot read the latest Fluxmail version from npm: HTTP ${response.status}.`);
  return (await response.json()).version;
}

async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const {
    RELEASE_VERSION: version,
    RELEASE_SHA: sha,
    GITHUB_REPOSITORY: repository,
    RUNNER_TEMP: temporary,
    SMITHERY_CONFIGURED: configured,
  } = process.env;
  if (!version || !sha || !repository || !temporary) {
    throw new Error('Set RELEASE_VERSION, RELEASE_SHA, GITHUB_REPOSITORY and RUNNER_TEMP.');
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${sha} is not a full commit SHA.`);
  if (configured !== 'true') throw new Error('Add the SMITHERY_API_KEY secret to the release environment.');
  const reason = skipReason(version, await npmLatest());
  if (reason) {
    console.log(`Not publishing to Smithery: ${reason}`);
    await output('bundle', '');
    return;
  }

  const deadline = Date.now() + 45 * 60_000;
  let run;
  for (;;) {
    [run] = JSON.parse(
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
        'databaseId,headSha,status,conclusion,url',
        '--limit',
        '1',
      ]),
    );
    if (runReady(run, sha)) break;
    if (Date.now() > deadline) throw new Error(`The MCP bundle run ${run.url} didn't finish in 45 minutes.`);
    console.log(`Waiting for ${run.url} (${run.status}).`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  const directory = path.join(temporary, 'mcpb');
  await gh([
    'run',
    'download',
    String(run.databaseId),
    '--repo',
    repository,
    '--name',
    'fluxmail-mcpb',
    '--dir',
    directory,
  ]);
  const bundle = path.join(directory, bundleName(version));
  await access(bundle);
  console.log(`Publishing ${bundleName(version)} from ${run.url} to ${smitheryServer}.`);
  await output('bundle', bundle);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
