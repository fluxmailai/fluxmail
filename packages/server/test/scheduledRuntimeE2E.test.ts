import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupInitialAdmin } from '../src/auth.js';
import { createContext, type AppContext } from '../src/context.js';
import { saveLocalInstance, saveRemoteInstance, saveSessionToken } from '../src/cliInstances.js';
import { eq } from 'drizzle-orm';
import { accounts, scheduledSends } from '../src/storage/db.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { createScheduledSend, getScheduledSend } from '../src/storage/scheduledSends.js';
import { FULL_PERMISSION_POLICY } from '../src/permissions.js';
import { shutdownLogging } from '../src/logging.js';

const entry = fileURLToPath(new URL('./fixtures/scheduledRuntime.ts', import.meta.url));
const children: ChildProcess[] = [];
const contexts: AppContext[] = [];

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await closed;
  } finally {
    clearTimeout(deadline);
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  for (const ctx of contexts.splice(0)) {
    await ctx.registry.close();
    (ctx.db as unknown as { $client: { close(): void } }).$client.close();
  }
  await shutdownLogging();
  vi.unstubAllEnvs();
});

async function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-scheduled-process-'));
  vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
  vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'bc'.repeat(32));
  vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
  const ctx = createContext();
  contexts.push(ctx);
  const admin = await setupInitialAdmin(ctx.db, {
    name: 'Fixture Owner',
    email: 'owner@example.com',
    password: 'River42!',
  });
  ctx.db
    .insert(accounts)
    .values({
      id: 'acct_fixture',
      provider: 'gmail',
      email: 'owner@example.com',
      ownerMemberId: admin.member.id,
      status: 'active',
      createdAt: Date.now(),
    })
    .run();
  saveLocalInstance('local');
  saveSessionToken('local', admin.session.token);
  const { key } = createApiKey(ctx.db, 'fixture', admin.member.id, FULL_PERMISSION_POLICY);
  const env = Object.fromEntries(
    Object.entries({ ...process.env, NO_UPDATE_NOTIFIER: '1' }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { dataDir, ctx, env, key };
}

function launch(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, '--no-update-notifier', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr!.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function stdio(env: Record<string, string>, args: string[] = [], era: 'legacy' | 'modern' = 'legacy') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', entry, '--no-update-notifier', 'stdio', ...args],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const client = new Client(
    { name: 'scheduled-runtime-test', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } },
  );
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

async function schedule(client: Client, delayMs = 1_000) {
  const response = await client.callTool({
    name: 'send_email',
    arguments: {
      accountId: 'acct_fixture',
      idempotencyKey: `fixture_${Date.now()}`,
      to: ['recipient@example.com'],
      subject: 'Fixture schedule',
      bodyText: 'Controlled delivery',
      sendAt: new Date(Date.now() + delayMs).toISOString(),
    },
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const data = (response.structuredContent as { data: { scheduleId: string; status: string } }).data;
  expect(data.status).toBe('queued');
  return data.scheduleId;
}

async function delivered(ctx: AppContext, id: string) {
  await vi.waitFor(() => expect(getScheduledSend(ctx.db, id)?.status).toBe('sent'), { timeout: 8_000, interval: 50 });
}

describe('scheduled delivery process handoff', { timeout: 20_000 }, () => {
  it.each((['legacy', 'modern'] as const).flatMap((era) => [undefined, '12'].map((limitMb) => ({ era, limitMb }))))(
    '$era stdio accepts attachments at the configured limit ($limitMb)',
    async ({ era, limitMb }) => {
      if (limitMb === undefined) vi.stubEnv('FLUXMAIL_MAX_ATTACHMENT_MB', undefined);
      else vi.stubEnv('FLUXMAIL_MAX_ATTACHMENT_MB', limitMb);
      const { env } = await setup();
      const { client, transport } = await stdio(env, ['--profile', 'full'], era);
      try {
        const content = Buffer.alloc(Number(limitMb ?? 10) * 1024 * 1024).toString('base64');
        const draft = await client.callTool(
          {
            name: 'create_draft',
            arguments: {
              to: ['recipient@example.com'],
              bodyText: 'x'.repeat(1024 * 1024),
              attachments: [{ filename: 'attachment.bin', mimeType: 'application/octet-stream', content }],
            },
          },
          undefined,
          { timeout: 5_000 },
        );
        expect(draft.isError, JSON.stringify(draft)).not.toBe(true);
        expect(draft.structuredContent).toMatchObject({ data: { draftId: expect.any(String) } });
        expect((await client.callTool({ name: 'list_accounts', arguments: {} })).isError).not.toBe(true);
      } finally {
        await client.close();
        await transport.close();
      }
    },
  );

  it.each(['legacy', 'modern'] as const)('%s stdio reads resources and retries sends once', async (era) => {
    const { dataDir, env } = await setup();
    const { client, transport } = await stdio(env, ['--profile', 'full'], era);
    try {
      expect(client.getProtocolEra()).toBe(era);
      const draft = await client.callTool({
        name: 'create_draft',
        arguments: { to: ['recipient@example.com'], bodyText: 'Fixture' },
      });
      expect(draft.isError).not.toBe(true);
      const draftId = (draft.structuredContent as { data: { draftId: string } }).data.draftId;
      const args = { draftId, idempotencyKey: 'stdio-retry' };
      const first = await client.callTool({ name: 'send_email', arguments: args });
      const second = await client.callTool({ name: 'send_email', arguments: args });
      expect(first.isError).not.toBe(true);
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(readFileSync(path.join(dataDir, 'deliveries.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
      const attachment = await client.callTool({
        name: 'download_attachment',
        arguments: { messageId: 'm1', attachmentId: 'a1' },
      });
      const link = attachment.content.find((item) => item.type === 'resource_link') as { uri: string };
      expect(link).toBeDefined();
      expect((await client.readResource({ uri: link.uri })).contents).toEqual([
        { uri: link.uri, mimeType: 'text/plain', text: 'hi' },
      ]);
      expect(
        (await client.callTool({ name: 'send_email', arguments: { ...args, idempotencyKey: null } })).isError,
      ).toBe(true);
      await expect(client.callTool({ name: 'delete_emails', arguments: { messageIds: ['m1'] } })).rejects.toMatchObject(
        {
          code: -32602,
        },
      );
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it.each([{ args: [] }, { args: ['--profile', 'read-only'] }, { args: ['--account', 'acct_fixture'] }])(
    'stdio %j leaves overdue schedules untouched and permits scoped inspection',
    async ({ args }) => {
      const f = await setup();
      const row = createScheduledSend(f.ctx.db, {
        accountId: 'acct_fixture',
        draftId: 'overdue',
        sendAt: Date.now() - 1_000,
      });
      const mcp = await stdio(f.env, args);
      try {
        const response = await mcp.client.callTool({ name: 'list_scheduled_emails', arguments: {} });
        expect(response.isError).not.toBe(true);
        expect(
          (response.structuredContent as { data: { scheduleId: string }[] }).data.map((send) => send.scheduleId),
        ).toContain(row.id);
        expect(getScheduledSend(f.ctx.db, row.id)).toMatchObject({ status: 'pending', claimToken: null });
        expect(existsSync(path.join(f.dataDir, 'deliveries.jsonl'))).toBe(false);
        expect(mcp.stderr()).toContain('Delivery requires');
      } finally {
        await mcp.client.close();
        await mcp.transport.close();
      }
    },
  );

  it('an empty standalone runner stays alive and delivers work created by another stdio process', async () => {
    const f = await setup();
    const worker = launch(['scheduled', 'run'], f.env);
    await vi.waitFor(() => expect(worker.stdout()).toContain('scheduled delivery running'), { timeout: 8_000 });
    expect(worker.child.exitCode).toBeNull();
    const mcp = await stdio(f.env, ['--profile', 'full']);
    let id: string;
    try {
      id = await schedule(mcp.client);
      const response = await mcp.client.callTool({ name: 'list_scheduled_emails', arguments: {} });
      expect(response.isError).not.toBe(true);
    } finally {
      await mcp.client.close();
      await mcp.transport.close();
    }
    await delivered(f.ctx, id!);
    expect(readFileSync(path.join(f.dataDir, 'deliveries.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    await stop(worker.child);
    expect(worker.child.signalCode).toBe('SIGTERM');
  });

  it.each(['before-dispatch', 'provider-pending', 'after-success'])(
    'recovers after a process crash at %s without replacing an unresolved delivery',
    async (crashPoint) => {
      const f = await setup();
      const mcp = await stdio(f.env, ['--profile', 'full']);
      let id: string;
      try {
        id = await schedule(mcp.client);
      } finally {
        await mcp.client.close();
        await mcp.transport.close();
      }
      const crashed = launch(['scheduled', 'run'], { ...f.env, FLUXMAIL_FIXTURE_CRASH_POINT: crashPoint });
      await vi.waitFor(() => expect(existsSync(path.join(f.dataDir, 'crash-point'))).toBe(true), { timeout: 8_000 });
      expect(getScheduledSend(f.ctx.db, id!)?.status).toBe('sending');
      const exited = new Promise<void>((resolve) => crashed.child.once('close', () => resolve()));
      crashed.child.kill('SIGKILL');
      await exited;
      // Advance lease expiry without waiting five wall-clock minutes after the crash.
      f.ctx.db
        .update(scheduledSends)
        .set({ claimUntil: Date.now() - 1 })
        .where(eq(scheduledSends.id, id!))
        .run();
      const recovered = launch(['scheduled', 'run'], f.env);
      await vi.waitFor(() => expect(recovered.stdout()).toContain('scheduled delivery running'), { timeout: 8_000 });
      if (crashPoint === 'provider-pending') {
        await vi.waitFor(() => expect(getScheduledSend(f.ctx.db, id!)?.status).toBe('uncertain'), { timeout: 8_000 });
      } else await delivered(f.ctx, id!);
      expect(readFileSync(path.join(f.dataDir, 'deliveries.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    },
  );

  it('serve delivers HTTP MCP and remote CLI schedules after client disconnects and a server restart', async () => {
    const f = await setup();
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP port');
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const port = String(address.port);
    const url = `http://localhost:${port}`;
    const env = { ...f.env, FLUXMAIL_PORT: port };
    const server = launch(['serve'], env);
    await vi.waitFor(() => expect(server.stdout()).toContain('Fluxmail listening'), { timeout: 8_000 });
    const client = new Client({ name: 'remote-scheduler-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${f.key}` } },
    });
    await client.connect(transport);
    const httpId = await schedule(client);
    await client.close();
    await delivered(f.ctx, httpId);

    const clientDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-remote-scheduler-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', clientDir);
    saveRemoteInstance('remote', url);
    saveSessionToken('remote', f.key);
    vi.stubEnv('FLUXMAIL_DATA_DIR', f.dataDir);
    const remote = launch(
      [
        '--instance',
        'remote',
        '--mail-account',
        'acct_fixture',
        'emails',
        'send',
        '--to',
        'recipient@example.com',
        '--subject',
        'Remote fixture',
        '--body',
        'Controlled delivery',
        '--idempotency-key',
        'remote-fixture',
        '--send-at',
        new Date(Date.now() + 6_000).toISOString(),
      ],
      { ...f.env, FLUXMAIL_DATA_DIR: clientDir },
    );
    await vi.waitFor(() => expect(remote.child.exitCode).not.toBeNull(), { timeout: 8_000 });
    expect(remote.child.exitCode, remote.stderr()).toBe(0);
    const cliId = JSON.parse(remote.stdout()).data.scheduleId as string;
    expect(cliId).toMatch(/^sch_/);
    await stop(server.child);
    expect(getScheduledSend(f.ctx.db, cliId)?.status).toBe('pending');
    const restarted = launch(['serve'], env);
    await vi.waitFor(() => expect(restarted.stdout()).toContain('Fluxmail listening'), { timeout: 8_000 });
    await delivered(f.ctx, cliId);
    expect(readFileSync(path.join(f.dataDir, 'deliveries.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    // The shipped deployment uses this same single serve process and allows its shutdown deadline.
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    expect(compose).toContain('stop_grace_period: 45s');
    expect(dockerfile).toContain('CMD ["serve"]');
  });
});
