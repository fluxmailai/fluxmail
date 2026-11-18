#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [bundleDirectory, expectedVersion, toolsOutput] = process.argv.slice(2);
if (!bundleDirectory || !expectedVersion) throw new Error('Provide the extracted bundle and expected version.');
const extractedDirectory = path.resolve(bundleDirectory);

const manifest = JSON.parse(await readFile(path.join(extractedDirectory, 'manifest.json')));
assert.equal(manifest.version, expectedVersion);
assert.deepEqual(manifest.compatibility.platforms, ['darwin', 'win32', 'linux']);
assert.equal(manifest.server.mcp_config.args[0], '${__dirname}/' + manifest.server.entry_point);
assert.deepEqual(manifest.server.mcp_config.args.slice(1), ['stdio', '--profile', '${user_config.permission_profile}']);
assert.equal(manifest.user_config.permission_profile.default, 'full');
assert.equal(manifest.user_config.permission_profile.required, false);

const nativePackages = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-arm64': 'linux-arm64-gnu',
  'linux-x64': 'linux-x64-gnu',
  'linuxmusl-arm64': 'linux-arm64-musl',
  'linuxmusl-x64': 'linux-x64-musl',
  'win32-arm64': 'win32-arm64-msvc',
  'win32-x64': 'win32-x64-msvc',
};
for (const [target, argon2Target] of Object.entries(nativePackages)) {
  const sqliteBinary = path.join(extractedDirectory, 'node_modules', 'better-sqlite3', 'prebuilds', `${target}.node`);
  assert.ok((await stat(sqliteBinary)).size > 0, `Missing SQLite binary for ${target}`);
  await stat(path.join(extractedDirectory, 'node_modules', '@node-rs', `argon2-${argon2Target}`, 'package.json'));
}

const entryPoint = path.join(extractedDirectory, manifest.server.entry_point);
const cli = path.join(extractedDirectory, 'dist/cli.js');
const version = spawnSync(process.execPath, [entryPoint, '--version'], {
  encoding: 'utf8',
  env: { ...process.env, FLUXMAIL_TELEMETRY: '0' },
});
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), expectedVersion);

const require = createRequire(path.join(extractedDirectory, 'package.json'));
const Database = require('better-sqlite3');
const sqlite = new Database(':memory:');
try {
  assert.equal(sqlite.prepare('select 1 as result').get().result, 1);
} finally {
  sqlite.close();
}
assert.equal(typeof require('@node-rs/argon2').hash, 'function');

// The bundle's own copy of the shared tool contract and of the self-hosted-only tool scopes says which scope each
// tool needs and which scopes each profile grants. The lists of tools each profile must offer and must not offer
// stay written out below, so a scope change can't widen or narrow a profile without failing this check.
const corePackage = path.join(extractedDirectory, 'node_modules', '@fluxmail', 'core');
const coreManifest = JSON.parse(await readFile(path.join(corePackage, 'package.json')));
const { PERMISSION_PRESETS, SHARED_TOOLS } = await import(
  pathToFileURL(path.join(corePackage, coreManifest.exports['./mcp'].default)).href
);

const { PRODUCT_TOOL_SCOPES } = await import(
  pathToFileURL(path.join(extractedDirectory, 'dist', 'mcp', 'productTools.js')).href
);
const readTools = [
  'send_feedback',
  'list_accounts',
  'get_status',
  'list_folders',
  'list_labels',
  'list_send_as',
  'list_emails',
  'search_emails',
  'list_emails_batch',
  'search_emails_batch',
  'get_email',
  'get_email_body',
  'get_thread',
  'download_attachment',
  'list_scheduled_emails',
];
const sendTools = ['preview_send', 'send_email', 'get_delivery_operation', 'forward_email'];
const writeTools = [
  'create_draft',
  'get_draft',
  'update_draft',
  'delete_draft',
  'cancel_scheduled_email',
  'create_folder',
  'delete_folder',
  'rename_folder',
  'create_label',
  'delete_label',
  'mark_emails_read',
  'mark_emails_unread',
  'star_emails',
  'unstar_emails',
  'archive_emails',
  'move_emails',
  'add_labels',
  'remove_labels',
  'trash_emails',
  'restore_emails',
];
const forbidden = { full: [], 'read-write': sendTools, 'read-only': [...sendTools, ...writeTools] };
const required = {
  full: [...readTools, ...writeTools, ...sendTools],
  'read-write': [...readTools, ...writeTools],
  'read-only': readTools,
};

function allowedInProfile(name, profile) {
  const scopes = PERMISSION_PRESETS[profile];
  assert.ok(scopes, `Unknown profile ${profile}`);
  const shared = SHARED_TOOLS.find((tool) => tool.name === name);
  assert.ok(shared || PRODUCT_TOOL_SCOPES[name], `${name} has no scope in the contract or in productTools.ts.`);
  const needs = shared ? [shared.scope, shared.alsoRequires] : [PRODUCT_TOOL_SCOPES[name]];
  return needs.every((scope) => !scope || scopes.includes(scope));
}

for (const tool of manifest.tools) assert.ok(allowedInProfile(tool.name, 'full'), `${tool.name} is not in Full`);

const dataDirectory = await mkdtemp(path.join(tmpdir(), 'fluxmail-mcpb-check-'));
try {
  const setup = spawnSync(process.execPath, ['scripts/setup-mcpb-check.mjs', cli, dataDirectory], {
    encoding: 'utf8',
    env: { ...process.env, FLUXMAIL_TELEMETRY: '0' },
  });
  assert.equal(setup.status, 0, setup.stderr);
  process.stdout.write(setup.stdout);
  const tools = await checkConfiguration(dataDirectory, {});
  for (const profile of ['full', 'read-write', 'read-only']) {
    await checkConfiguration(dataDirectory, { permission_profile: profile });
  }
  if (toolsOutput) await writeFile(toolsOutput, `${JSON.stringify(tools, null, 2)}\n`);
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}

console.log('Extracted MCPB passed CLI, native dependency, and MCP tool checks.');

async function checkConfiguration(dataDirectory, userConfig) {
  const profile = userConfig.permission_profile ?? manifest.user_config.permission_profile.default;
  const args = manifest.server.mcp_config.args.map((arg) =>
    arg.replace('${__dirname}', extractedDirectory).replace('${user_config.permission_profile}', profile),
  );
  assert.equal(path.normalize(args[0]), entryPoint);
  assert.deepEqual(args.slice(1), ['stdio', '--profile', profile]);
  return checkTools(args, dataDirectory, profile);
}

function checkTools(args, dataDirectory, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, FLUXMAIL_DATA_DIR: dataDirectory, FLUXMAIL_TELEMETRY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let completed = false;
    let failure;
    let toolList;
    const timeout = setTimeout(() => finish(new Error(`MCP handshake timed out: ${stderr}`)), 30_000);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`MCP wrote invalid JSON: ${line}`));
          return;
        }
        if (message.id === 1) {
          if (message.error) return finish(new Error(`MCP initialization failed: ${JSON.stringify(message.error)}`));
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        }
        if (message.id === 2) {
          if (message.error) return finish(new Error(`MCP tools/list failed: ${JSON.stringify(message.error)}`));
          try {
            const expectedTools = manifest.tools.filter((tool) => allowedInProfile(tool.name, profile));
            assert.equal(message.result.tools.length, expectedTools.length);
            assert.deepEqual(
              new Set(message.result.tools.map((tool) => tool.name)),
              new Set(expectedTools.map((tool) => tool.name)),
            );
            const names = message.result.tools.map((tool) => tool.name);
            assert.ok(!names.includes('delete_emails'));
            assert.ok(!names.includes('modify_emails'));
            for (const name of forbidden[profile]) assert.ok(!names.includes(name), `${profile} lists ${name}`);
            for (const name of required[profile]) assert.ok(names.includes(name), `${profile} doesn't list ${name}`);
            if (profile === 'full') {
              for (const tool of message.result.tools) {
                const declared = manifest.tools.find((item) => item.name === tool.name);
                if (declared.inputSchema) assert.deepEqual(declared.inputSchema, tool.inputSchema);
              }
            }
            finish(undefined, message.result.tools);
          } catch (error) {
            finish(error);
          }
        }
      }
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (!completed) finish(new Error(`MCP process exited with status ${code}: ${stderr}`));
      if (failure) reject(failure);
      else resolve(toolList);
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcpb-check', version: '1' } },
    });

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    function finish(error, tools) {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      failure = error;
      toolList = tools;
      child.kill();
    }
  });
}
