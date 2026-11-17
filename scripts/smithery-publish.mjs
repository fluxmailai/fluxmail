#!/usr/bin/env node

// Prepares a stable release's MCP bundle for Smithery: it waits for the MCP bundle run of the release commit,
// downloads the archive that run built and verified, and writes its path as the `bundle` step output. The
// workflow publishes it with the pinned Smithery CLI in a separate step that alone holds the API key.
import { execFile } from 'node:child_process';
import { access, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { npmLatestVersion } from './claude-code-plugin.mjs';

const execute = promisify(execFile);
export const smitheryServer = 'fluxmail/fluxmail';

export function bundleName(version) {
  return `fluxmail-${version}-smithery.mcpb`;
}

const parts = (version) => version.split('.').map(Number);
function compare(left, right) {
  const [a, b] = [parts(left), parts(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether to publish the release, skip it because npm's latest is newer, or wait because npm hasn't caught up with
 * the release yet.
 */
export function publishDecision(version, latest) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { action: 'skip', reason: `${version} is not a stable version.` };
  const order = compare(version, latest);
  if (order === 0) return { action: 'publish' };
  if (order < 0) {
    return { action: 'skip', reason: `npm's latest version is ${latest}, so Smithery keeps the newer bundle.` };
  }
  return { action: 'wait' };
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
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${version} is not a stable version.`);
  const tagged = await gh(['api', `repos/${repository}/commits/v${version}`, '--jq', '.sha']);
  if (tagged !== sha) throw new Error(`v${version} points to ${tagged}, not ${sha}.`);

  // npm's latest tag can lag behind a release for a few minutes.
  for (let attempt = 1; ; attempt += 1) {
    const latest = await npmLatestVersion();
    const decision = publishDecision(version, latest);
    if (decision.action === 'skip') {
      console.log(`Not publishing to Smithery: ${decision.reason}`);
      await output('bundle', '');
      return;
    }
    if (decision.action === 'publish') break;
    if (attempt === 20) throw new Error(`npm still reports ${latest} as the latest version, not ${version}.`);
    console.log(`Waiting for npm's latest version to reach ${version} (now ${latest}).`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
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
