import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import { getMcpConfigForManifest } from '@anthropic-ai/mcpb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupInitialAdmin } from '../src/auth.js';
import { saveLocalInstance, saveRemoteInstance, saveSessionToken, useInstance } from '../src/cliInstances.js';
import { createContext } from '../src/context.js';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const runFile = promisify(execFile);
const bundleManifest = JSON.parse(
  readFileSync(new URL('../../../mcpb/manifest.template.json', import.meta.url), 'utf8'),
);

describe('CLI stdio process integration', { timeout: 15_000 }, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function environment(): NodeJS.ProcessEnv {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-stdio-e2e-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'bd'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    return { ...process.env, NO_UPDATE_NOTIFIER: '1' };
  }

  it('exits when the client stops reading its output, even with stdin still open', async () => {
    const env = environment();
    const context = createContext();
    try {
      const setup = await setupInitialAdmin(context.db, {
        name: 'Stdio Owner',
        email: 'stdio-owner@example.com',
        password: 'River42!',
      });
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);
      useInstance('local');
    } finally {
      await context.registry.close();
      (context.db as unknown as { $client: { close(): void } }).$client.close();
    }

    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, 'stdio'], { env, stdio: 'pipe' });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
          if (stderr.includes('Fluxmail MCP server running on stdio')) resolve();
        });
        child.once('exit', () => reject(new Error(`stdio exited during startup: ${stderr}`)));
      });
      // The client goes away without ending stdin: the server's reply fails with EPIPE and closes the transport.
      child.stdout.destroy();
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gone', version: '1' } },
        })}\n`,
      );
      const outcome = await Promise.race([
        exited.then(() => 'exited'),
        new Promise((resolve) => setTimeout(() => resolve('still running'), 8_000)),
      ]);
      expect(outcome).toBe('exited');
    } finally {
      child.kill();
    }
  });

  it.each([
    { name: 'local', profileArgs: ['--profile', 'read-only'], era: 'legacy' },
    { name: 'local', profileArgs: ['--profile', 'read-only'], era: 'modern' },
    { name: 'personal', profileArgs: [], era: 'modern' },
  ])(
    'completes an MCP handshake with $era protocol and local profile $name and a remote active',
    async ({ name, profileArgs, era }) => {
      const env = environment();
      const context = createContext();
      try {
        const setup = await setupInitialAdmin(context.db, {
          name: 'Stdio Owner',
          email: 'stdio-owner@example.com',
          password: 'River42!',
        });
        saveLocalInstance(name);
        saveSessionToken(name, setup.session.token);
        saveRemoteInstance('work', 'https://private.example.com');
        saveSessionToken('work', 'fms_private_remote_session');
        useInstance('work');
      } finally {
        await context.registry.close();
        (context.db as unknown as { $client: { close(): void } }).$client.close();
      }

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', cliPath, 'stdio', ...profileArgs],
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      const client = new Client(
        { name: 'stdio-startup-test', version: '1.0.0' },
        { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } },
      );
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === 'list_accounts')).toBe(true);
        // Without a profile the connection gets the full default, including send.
        expect(tools.tools.some((tool) => tool.name === 'send_email')).toBe(!profileArgs.length);
        expect(tools.tools.some((tool) => tool.name === 'delete_emails')).toBe(false);
        const result = await client.callTool({ name: 'list_accounts', arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ data: [] });
        const unknown = await client.callTool({ name: 'list_emails', arguments: { from: 'ann@example.com' } });
        expect(unknown.isError).toBe(true);
        expect(JSON.parse((unknown.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
          error: 'invalid_request',
          message: expect.stringContaining('"from"'),
        });
        expect(stderr).toContain('Fluxmail MCP server running on stdio');
        expect(
          stderr.includes(
            'No permission profile selected, so this connection uses the "full" profile (mail.read, mail.drafts, mail.organize, mail.trash, mail.send).',
          ),
        ).toBe(!profileArgs.length);
        expect(stderr).not.toContain('fms_private_remote_session');
      } finally {
        await client.close();
        await transport.close();
      }
    },
  );

  it.each([
    { savedProfile: undefined, resolvedProfile: 'full' },
    { savedProfile: 'full', resolvedProfile: 'full' },
    { savedProfile: 'read-write', resolvedProfile: 'read-write' },
    { savedProfile: 'read-only', resolvedProfile: 'read-only' },
  ])(
    'resolves bundle profile $savedProfile to $resolvedProfile and enforces it',
    async ({ savedProfile, resolvedProfile }) => {
      const config = await getMcpConfigForManifest({
        manifest: bundleManifest,
        extensionPath: path.dirname(cliPath),
        systemDirs: {},
        userConfig: savedProfile ? { permission_profile: savedProfile } : {},
        pathSeparator: path.sep,
      });
      expect(bundleManifest.user_config.permission_profile.required).toBe(false);
      expect(config?.args?.slice(1)).toEqual(['stdio', '--profile', resolvedProfile]);

      const env = environment();
      const context = createContext();
      try {
        const setup = await setupInitialAdmin(context.db, {
          name: 'Bundle Owner',
          email: 'bundle-owner@example.invalid',
          password: 'River42!',
        });
        saveLocalInstance('local');
        saveSessionToken('local', setup.session.token);
      } finally {
        await context.registry.close();
        (context.db as unknown as { $client: { close(): void } }).$client.close();
      }

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', cliPath, ...config!.args!.slice(1)],
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        stderr: 'pipe',
      });
      const client = new Client({ name: 'bundle-permissions-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name);
        for (const name of ['send_email', 'forward_email', 'preview_send', 'get_delivery_operation']) {
          expect(names.includes(name)).toBe(resolvedProfile === 'full');
        }
        for (const name of [
          'create_draft',
          'get_draft',
          'update_draft',
          'delete_draft',
          'cancel_scheduled_email',
          'archive_emails',
          'move_emails',
          'trash_emails',
          'restore_emails',
        ]) {
          expect(names.includes(name)).toBe(resolvedProfile !== 'read-only');
        }
        expect(names).not.toContain('delete_emails');
        expect(names).not.toContain('modify_emails');
        if (resolvedProfile === 'full') {
          expect(new Set(names)).toEqual(new Set(bundleManifest.tools.map((tool: { name: string }) => tool.name)));
        }
        await expect(
          client.callTool({ name: 'delete_emails', arguments: { messageIds: ['nonexistent-fixture-message'] } }),
        ).rejects.toMatchObject({ code: -32602 });
        const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
        expect(accounts.isError).not.toBe(true);
        expect(accounts.structuredContent).toMatchObject({ data: [] });
      } finally {
        await client.close();
        await transport.close();
      }
    },
  );

  it('serves its tools from a new data directory and leaves it ready for setup', async () => {
    const env = environment();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', cliPath, 'stdio', '--profile', 'full'],
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const client = new Client({ name: 'setup-required-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(new Set(tools.map((tool) => tool.name))).toEqual(
        new Set(bundleManifest.tools.map((tool: { name: string }) => tool.name)),
      );
      const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(accounts.isError).toBe(true);
      expect(JSON.stringify(accounts.content)).toContain('Fluxmail is not set up.');
      expect(JSON.stringify(accounts.content)).not.toContain(env.FLUXMAIL_DATA_DIR!);
    } finally {
      await client.close();
      await transport.close();
    }
    expect(stderr).toContain(`Fluxmail is not set up in ${env.FLUXMAIL_DATA_DIR}.`);
    expect(existsSync(path.join(env.FLUXMAIL_DATA_DIR!, 'fluxmail.db'))).toBe(false);
    expect(existsSync(path.join(env.FLUXMAIL_DATA_DIR!, 'cli'))).toBe(false);

    await runFile(
      process.execPath,
      ['--import', 'tsx', cliPath, 'setup', '--name', 'Setup Owner', '--email', 'setup-owner@example.invalid'],
      { env: { ...env, FLUXMAIL_PASSWORD: 'River42!' }, timeout: 10_000 },
    );
    expect(existsSync(path.join(env.FLUXMAIL_DATA_DIR!, 'fluxmail.db'))).toBe(true);
  });

  it('prints one structured invalid-request error without protocol output or a new store', async () => {
    const env = environment();
    const error = await runFile(
      process.execPath,
      ['--import', 'tsx', cliPath, 'stdio', '--profile', 'private-invalid'],
      {
        env,
        timeout: 10_000,
      },
    ).then(
      () => {
        throw new Error('Expected stdio startup to fail');
      },
      (failure: Error & { code: number; stdout: string; stderr: string }) => failure,
    );

    expect(error.code).toBe(2);
    expect(error.stdout).toBe('');
    expect(JSON.parse(error.stderr.trim())).toMatchObject({
      error: { code: 'invalid_request', message: expect.stringContaining('Unknown profile') },
    });
    expect(existsSync(path.join(env.FLUXMAIL_DATA_DIR!, 'fluxmail.db'))).toBe(false);
  });
});
