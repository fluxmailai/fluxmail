import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCliProgram } from '../src/cli.js';
import { cloudAccessToken } from '../src/cliCloudAuth.js';
import {
  cloudCredentialPath,
  loadCloudSession,
  loadInstanceConfig,
  removeInstance,
  saveCloudInstance,
  saveCloudSession,
  saveLocalInstance,
  useInstance,
  type CloudSession,
} from '../src/cliInstances.js';
import { startFakeCloud, type FakeCloud } from './fakeCloud.js';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.ts');
const mailbox = { id: 'mbx_1', email: 'one@example.com', provider: 'gmail' };
const secondMailbox = { id: 'mbx_2', email: 'two@example.com', provider: 'outlook' };

interface Run {
  code: number | undefined;
  stdout: string;
  stderr: string;
  json: any;
  telemetry: Array<Record<string, unknown>>;
}

let cloud: FakeCloud;
let dataDir: string;

function spawnCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--no-update-notifier', ...args], {
      cwd: path.resolve(path.dirname(cliPath), '../../..'),
      env: { ...process.env, FLUXMAIL_DATA_DIR: dataDir, FLUXMAIL_TELEMETRY: '0', ...env },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

async function run(args: string[], browser?: (url: string) => Promise<void>): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const opened: Array<Promise<void>> = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...values) => void stdout.push(values.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation((...values) => {
    const line = values.join(' ');
    stderr.push(line);
    const url = line.match(/https?:\/\/\S+/)?.[0];
    if (browser && url) opened.push(browser(url));
  });
  const capture = vi.fn();
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await createCliProgram({ telemetry: { capture, shutdown: async () => {} } }).parseAsync([
      'node',
      'fluxmail',
      ...args,
    ]);
    await Promise.all(opened);
    const code = process.exitCode as number | undefined;
    const text = stdout.join('\n');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {
      code,
      stdout: text,
      stderr: stderr.join('\n'),
      json,
      telemetry: capture.mock.calls.map((call) => call[1] as Record<string, unknown>),
    };
  } finally {
    process.exitCode = previous;
    log.mockRestore();
    error.mockRestore();
  }
}

/** The approval page followed by the redirect to the CLI's loopback listener. */
async function approve(url: string): Promise<void> {
  const response = await fetch(url);
  await response.text();
}

function useSession(session: Partial<Extract<CloudSession, { kind: 'oauth' }>> = {}): void {
  cloud.state.accessTokens.add('header.seeded.signature');
  cloud.state.refreshTokens.set('seeded-refresh', 'active');
  saveCloudInstance('cloud', cloud.origin);
  saveCloudSession('cloud', {
    kind: 'oauth',
    serverUrl: cloud.origin,
    clientId: 'client_seeded',
    accessToken: 'header.seeded.signature',
    refreshToken: 'seeded-refresh',
    expiresAt: Date.now() + 600_000,
    ...session,
  });
  useInstance('cloud');
}

async function logIn(args: string[] = []): Promise<Run> {
  return run(['login', '--cloud', '--server', cloud.origin, ...args], approve);
}

function page(items: unknown[], extra: Record<string, unknown> = {}) {
  return { data: { items, exhausted: true, ...extra } };
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-cloud-'));
  vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
  vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '44'.repeat(32));
  cloud = await startFakeCloud();
  cloud.setTool('get_connection_status', () => ({
    data: { workspace: { name: 'Personal' }, mailboxes: [mailbox] },
  }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cloud.close();
});

describe('fluxmail login --cloud', () => {
  it('signs in through the browser with PKCE and stores the session privately', async () => {
    const result = await logIn();

    expect(result.code).toBeUndefined();
    expect(result.stdout).toContain('Logged in to cloud.');
    const [registration] = cloud.state.registrations;
    expect(registration).toMatchObject({
      client_name: 'Fluxmail CLI',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    });
    expect(String(registration!.scope).split(' ')).toContain('mail.delete');
    const [authorization] = cloud.state.authorizations;
    expect(authorization!.get('code_challenge_method')).toBe('S256');
    expect(authorization!.get('resource')).toBe(`${cloud.origin}/mcp`);
    expect(authorization!.get('scope')).toBe('mail.read mail.drafts mail.organize mail.trash mail.send offline_access');
    expect(authorization!.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    expect(loadInstanceConfig()).toEqual({
      active: 'cloud',
      instances: { cloud: { kind: 'cloud', serverUrl: cloud.origin } },
    });
    expect(loadCloudSession('cloud')).toMatchObject({ kind: 'oauth', clientId: 'client_1' });
    expect(statSync(cloudCredentialPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dataDir, 'cli', 'instances.json'), 'utf8')).not.toContain('refresh');
  });

  it('requests a narrower permission profile', async () => {
    await logIn(['--profile', 'read-only']);
    expect(cloud.state.authorizations[0]!.get('scope')).toBe('mail.read offline_access');
  });

  it('rejects an unknown permission profile before contacting Cloud', async () => {
    const result = await logIn(['--profile', 'everything']);
    expect(result.code).toBe(2);
    expect(cloud.state.registrations).toHaveLength(0);
  });

  it('revokes the previous connection on a repeat login', async () => {
    await logIn();
    const first = loadCloudSession('cloud') as Extract<CloudSession, { kind: 'oauth' }>;
    await run(['login'], approve);
    expect(cloud.state.revocations).toEqual([first.refreshToken]);
    expect(loadCloudSession('cloud')).toMatchObject({ clientId: 'client_2' });
  });

  it('keeps no profile when the browser reports a denial', async () => {
    const result = await run(['login', '--cloud', '--server', cloud.origin], async (url) => {
      const target = new URL(url);
      const redirect = new URL(target.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('state', target.searchParams.get('state')!);
      redirect.searchParams.set('error', 'access_denied');
      await (await fetch(redirect)).text();
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('access_denied');
    expect(loadInstanceConfig().instances).toEqual({});
  });

  it('refuses to replace a profile of another kind', async () => {
    saveLocalInstance('local');
    const result = await run(['--instance', 'local', 'login', '--cloud']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not a Fluxmail Cloud profile');
  });

  it('refuses metadata that points at another server', async () => {
    const other = await startFakeCloud({ authorizationServer: 'https://auth.example.com' });
    try {
      const result = await run(['login', '--cloud', '--server', other.origin], approve);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain('named another server');
      expect(other.state.registrations).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('reuses the active Cloud profile and leaves other logins alone', async () => {
    useSession();
    saveCloudInstance('hosted', cloud.origin);
    useInstance('hosted');
    saveCloudSession('hosted', { kind: 'key', key: 'fm_valid_key', serverUrl: cloud.origin });

    await run(['login', '--cloud'], approve);
    expect(loadCloudSession('hosted')).toMatchObject({ kind: 'oauth' });

    const named = await run(['--instance', 'cloud', 'login', '--server', 'https://mail.example.com']);
    expect(named.code).toBe(2);
    expect(named.stderr).toContain('is a Fluxmail Cloud profile');

    const options = await run(['--instance', 'cloud', 'login', '--email', 'a@example.com']);
    expect(options.code).toBe(2);
    expect(options.stderr).toContain('do not apply to Fluxmail Cloud');
  });

  it('revokes the previous connection only at its own server when the profile moves', async () => {
    useSession();
    const next = await startFakeCloud();
    try {
      next.setTool('get_connection_status', () => ({ data: { mailboxes: [mailbox] } }));
      const result = await run(['--instance', 'cloud', 'login', '--cloud', '--server', next.origin], approve);

      expect(result.code).toBeUndefined();
      expect(cloud.state.revocations).toEqual(['seeded-refresh']);
      expect(next.state.revocations).toEqual([]);
      expect(loadInstanceConfig().instances.cloud).toEqual({ kind: 'cloud', serverUrl: next.origin });
    } finally {
      await next.close();
    }
  });

  it('revokes the previous connection at its own server after an API key login elsewhere', async () => {
    useSession();
    const next = await startFakeCloud();
    try {
      next.setTool('get_connection_status', () => ({ data: { mailboxes: [mailbox] } }));
      vi.stubEnv('FLUXMAIL_CLOUD_API_KEY', 'fm_valid_key');
      const result = await run(['--instance', 'cloud', 'login', '--cloud', '--api-key', '--server', next.origin]);

      expect(result.code).toBeUndefined();
      expect(cloud.state.revocations).toEqual(['seeded-refresh']);
      expect(next.state.revocations).toEqual([]);
      expect(loadCloudSession('cloud')).toEqual({ kind: 'key', key: 'fm_valid_key', serverUrl: next.origin });
    } finally {
      await next.close();
    }
  });

  it('keeps the working session when a new API key is rejected', async () => {
    useSession();
    vi.stubEnv('FLUXMAIL_CLOUD_API_KEY', 'fm_rejected_key');
    const result = await run(['--instance', 'cloud', 'login', '--api-key']);

    expect(result.code).toBe(4);
    expect(loadCloudSession('cloud')).toMatchObject({ kind: 'oauth', refreshToken: 'seeded-refresh' });
    expect(cloud.state.revocations).toEqual([]);
  });

  it('accepts an API key from the environment and verifies it', async () => {
    vi.stubEnv('FLUXMAIL_CLOUD_API_KEY', 'fm_valid_key');
    const result = await run(['login', '--cloud', '--api-key', '--server', cloud.origin]);
    expect(result.code).toBeUndefined();
    expect(loadCloudSession('cloud')).toEqual({ kind: 'key', key: 'fm_valid_key', serverUrl: cloud.origin });
    expect(cloud.state.registrations).toHaveLength(0);
  });

  it('does not keep an API key Cloud rejects', async () => {
    vi.stubEnv('FLUXMAIL_CLOUD_API_KEY', 'fm_revoked_private_key');
    const result = await run(['login', '--cloud', '--api-key', '--server', cloud.origin]);
    expect(result.code).toBe(4);
    expect(result.stderr).not.toContain('fm_revoked_private_key');
    expect(loadCloudSession('cloud')).toBeUndefined();
    expect(loadInstanceConfig().instances).toEqual({});
  });

  it('records the instance kind without credentials or addresses', async () => {
    const result = await logIn();
    expect(result.telemetry).toHaveLength(1);
    expect(result.telemetry[0]).toMatchObject({
      operation: 'login',
      outcome: 'success',
      product_surface: 'cli',
      instance_kind: 'cloud',
    });
    const serialized = JSON.stringify(result.telemetry);
    const session = loadCloudSession('cloud') as Extract<CloudSession, { kind: 'oauth' }>;
    for (const secret of [session.accessToken, session.refreshToken, session.clientId, cloud.origin]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('Cloud mail commands', () => {
  beforeEach(() => useSession());

  it('lists messages in the REST envelope', async () => {
    cloud.setTool('list_emails', () => page([{ id: 'msg_1' }], { nextPageToken: 'next', exhausted: false }));
    const result = await run(['emails', 'list', '--folder', 'inbox', '--read', 'false', '--page-size', '5']);

    expect(result.json).toEqual({ data: [{ id: 'msg_1' }], meta: { exhausted: false, nextPageToken: 'next' } });
    expect(cloud.state.calls.at(-1)).toEqual({
      name: 'list_emails',
      args: { accountId: 'mbx_1', folder: 'inbox', read: false, pageSize: 5 },
    });
  });

  it('pages through --all', async () => {
    cloud.setTool('list_emails', (args) =>
      args.pageToken ? page([{ id: 'msg_2' }]) : page([{ id: 'msg_1' }], { nextPageToken: 'p2', exhausted: false }),
    );
    const result = await run(['emails', 'list', '--all']);
    expect(result.json.data).toEqual([{ id: 'msg_1' }, { id: 'msg_2' }]);
  });

  it('searches with search_emails while Cloud list_emails has no query argument', async () => {
    // Older Cloud releases ignore unknown arguments, so list_emails would return unfiltered mail.
    cloud.setTool(
      'list_emails',
      () => page([{ id: 'unfiltered' }]),
      z.object({ text: z.string().optional() }).passthrough(),
    );
    cloud.setTool('search_emails', () => page([{ id: 'msg_1' }]));
    const result = await run(['emails', 'search', 'from:ann@example.com']);
    expect(result.json.data).toEqual([{ id: 'msg_1' }]);
    expect(cloud.state.calls.at(-1)).toEqual({
      name: 'search_emails',
      args: { accountId: 'mbx_1', query: 'from:ann@example.com' },
    });
  });

  it('searches with list_emails once Cloud advertises its query argument', async () => {
    cloud.setTool(
      'list_emails',
      (args) =>
        args.pageToken ? page([{ id: 'msg_2' }]) : page([{ id: 'msg_1' }], { nextPageToken: 'p2', exhausted: false }),
      z.object({ query: z.string().optional() }).passthrough(),
    );
    cloud.setTool('search_emails', () => page([{ id: 'wrong_tool' }]));
    const result = await run(['emails', 'search', 'from:ann@example.com', '--all']);
    expect(result.json.data).toEqual([{ id: 'msg_1' }, { id: 'msg_2' }]);
    expect(cloud.state.calls.filter((call) => call.name !== 'get_connection_status')).toEqual([
      { name: 'list_emails', args: { accountId: 'mbx_1', query: 'from:ann@example.com', pageSize: 100 } },
      {
        name: 'list_emails',
        args: { accountId: 'mbx_1', query: 'from:ann@example.com', pageSize: 100, pageToken: 'p2' },
      },
    ]);
  });

  it('flattens batch search groups', async () => {
    cloud.setTool('search_emails_batch', () => ({
      data: {
        groups: [
          { accountId: 'mbx_1', page: { items: [{ id: 'msg_1' }], exhausted: true } },
          { accountId: 'mbx_2', error: { code: 'provider_unavailable', message: 'Down', exhausted: false } },
        ],
        exhausted: false,
      },
    }));
    const result = await run(['emails', 'search-batch', 'invoice', '--account', 'mbx_1', '--account', 'mbx_2']);
    expect(result.json.data[0]).toEqual({ accountId: 'mbx_1', data: [{ id: 'msg_1' }], meta: { exhausted: true } });
    expect(result.code).toBe(3);
  });

  it('chooses a mailbox by address and explains ambiguity', async () => {
    cloud.setTool('get_connection_status', () => ({ data: { mailboxes: [mailbox, secondMailbox] } }));
    cloud.setTool('list_folders', () => ({ data: [] }));

    const ambiguous = await run(['folders', 'list']);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain('mbx_1 (one@example.com), mbx_2 (two@example.com)');

    await run(['-a', 'TWO@example.com', 'folders', 'list']);
    expect(cloud.state.calls.at(-1)).toEqual({ name: 'list_folders', args: { accountId: 'mbx_2' } });
  });

  it('skips the lookup for an explicit mailbox ID', async () => {
    cloud.setTool('list_labels', () => ({ data: [] }));
    await run(['-a', 'mbx_9', 'labels', 'list']);
    expect(cloud.state.calls.map((call) => call.name)).toEqual(['list_labels']);
  });

  it('reads the rest of a long message body', async () => {
    cloud.setTool('get_email', () => ({
      data: {
        id: 'msg_1',
        body: { text: 'first ', html: '' },
        bodyTruncation: { text: { totalChars: 16, nextOffset: 6 }, html: { totalChars: 3, nextOffset: 0 } },
      },
    }));
    cloud.setTool('get_email_body', (args) => ({
      data:
        args.format === 'html'
          ? { text: '<p>', offset: 0, totalChars: 3 }
          : args.offset === 6
            ? { text: 'second ', nextOffset: 13 }
            : { text: 'end' },
    }));

    const result = await run(['emails', 'get', 'msg_1']);

    expect(result.json.data).toEqual({ id: 'msg_1', body: { text: 'first second end', html: '<p>' } });
  });

  it('collects every page of a thread', async () => {
    cloud.setTool('get_thread', (args) => ({
      data: args.pageToken
        ? { id: 't1', subject: 'Hi', messages: [{ id: 'msg_2' }] }
        : { id: 't1', subject: 'Hi', messages: [{ id: 'msg_1' }], nextPageToken: 'p2' },
    }));
    const result = await run(['threads', 'get', 't1']);
    expect(result.json.data).toEqual({ id: 't1', subject: 'Hi', messages: [{ id: 'msg_1' }, { id: 'msg_2' }] });
  });

  it('turns message options into tool arguments', async () => {
    cloud.setTool('send_email', () => ({ data: { operationId: 'key-1', status: 'succeeded' } }));
    const result = await run([
      'emails',
      'send',
      '--to',
      'Ann Example <ann@example.com>',
      '--cc',
      'lee@example.com',
      '--subject',
      'Hello',
      '--body',
      'Hi Ann',
      '--idempotency-key',
      'key-1',
    ]);

    expect(result.code).toBeUndefined();
    expect(cloud.state.calls.at(-1)).toEqual({
      name: 'send_email',
      args: {
        accountId: 'mbx_1',
        idempotencyKey: 'key-1',
        to: ['Ann Example <ann@example.com>'],
        cc: ['lee@example.com'],
        subject: 'Hello',
        bodyText: 'Hi Ann',
      },
    });
  });

  it('reports a failed delivery that carries an operation', async () => {
    cloud.setTool('send_email', () => ({
      raw: {
        isError: true,
        structuredContent: { data: { operationId: 'key-1', status: 'uncertain', error: { code: 'unknown' } } },
        content: [{ type: 'text', text: '{}' }],
      },
    }));
    const result = await run(['emails', 'send', '--draft', 'd1', '--idempotency-key', 'key-1']);
    expect(result.json.data.status).toBe('uncertain');
    expect(result.code).toBe(3);
  });

  it('runs scheduled sends only on self-hosted instances', async () => {
    const send = await run([
      'emails',
      'send',
      '--draft',
      'd1',
      '--send-at',
      '2030-01-01T00:00:00Z',
      '--idempotency-key',
      'key-1',
    ]);
    expect(send.code).toBe(2);
    expect(send.stderr).toContain('does not offer scheduled sending');
    expect((await run(['scheduled', 'list'])).code).toBe(2);
    expect(cloud.state.calls.map((call) => call.name)).not.toContain('send_email');
  });

  it('maps modify actions to their tools', async () => {
    const result = { data: { action: 'move', succeededIds: ['m1'], failed: [], uncertainIds: [] } };
    for (const name of ['move_emails', 'restore_emails', 'add_labels']) cloud.setTool(name, () => result);
    await run(['emails', 'modify', 'move', 'm1', '--folder', 'Projects']);
    expect(cloud.state.calls.at(-1)).toEqual({
      name: 'move_emails',
      args: { accountId: 'mbx_1', messageIds: ['m1'], folder: 'Projects' },
    });
    await run(['emails', 'modify', 'untrash', 'm1']);
    expect(cloud.state.calls.at(-1)?.name).toBe('restore_emails');
    await run(['emails', 'modify', 'add-labels', 'm1', '--label', 'Customer']);
    expect(cloud.state.calls.at(-1)?.args.labels).toEqual(['Customer']);
  });

  it('flags a partly failed modify', async () => {
    cloud.setTool('archive_emails', () => ({
      raw: {
        isError: true,
        structuredContent: {
          data: {
            action: 'archive',
            succeededIds: [],
            failed: [{ messageId: 'm1', code: 'not_found' }],
            uncertainIds: [],
          },
        },
        content: [{ type: 'text', text: '{}' }],
      },
    }));
    const result = await run(['emails', 'modify', 'archive', 'm1']);
    expect(result.json.data.failed).toHaveLength(1);
    expect(result.code).toBe(3);
  });

  it('downloads an attachment through its resource', async () => {
    const output = path.join(dataDir, 'report.pdf');
    const result = await run(['attachments', 'download', 'msg_1', 'att/1', '--output', output]);

    expect(readFileSync(output, 'utf8')).toBe('attachment bytes');
    expect(result.json.data).toEqual({ output, mimeType: 'application/pdf', sizeBytes: 16 });
    expect(cloud.state.resourceReads).toEqual(['fluxmail://attachment/mbx_1/msg_1/att%2F1/attachment']);
  });

  it('reports the code Cloud gives for a failed attachment read', async () => {
    cloud.state.attachmentFailure = 'Message unavailable.';
    cloud.setTool('download_attachment', () => ({
      raw: {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: 'not_found', message: 'Message unavailable.' }) }],
      },
    }));
    const output = path.join(dataDir, 'missing.pdf');
    const result = await run(['attachments', 'download', 'msg_1', 'att_1', '--output', output]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'not_found', message: 'Message unavailable.' });
    expect(cloud.state.calls.at(-1)).toEqual({
      name: 'download_attachment',
      args: { accountId: 'mbx_1', messageId: 'msg_1', attachmentId: 'att_1' },
    });
    expect(existsSync(output)).toBe(false);
  });

  it('treats a failed read that the tool cannot reproduce as transient', async () => {
    cloud.state.attachmentFailure = 'Try again.';
    cloud.setTool('download_attachment', () => ({ data: { filename: 'a.pdf', mimeType: 'application/pdf' } }));
    const result = await run(['attachments', 'download', 'msg_1', 'att_1', '--output', path.join(dataDir, 'a.pdf')]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stderr).error.code).toBe('provider_unavailable');
  });

  it('reports a call past --timeout as a request timeout', { timeout: 20_000 }, async () => {
    cloud.setTool('list_folders', () => ({ data: [] }));
    cloud.setTool('send_email', () => ({ data: { status: 'succeeded' } }));
    cloud.state.toolDelayMs = 1_500;

    const listing = await run(['--timeout', '1', '-a', 'mbx_1', 'folders', 'list']);
    expect(listing.code).toBe(5);
    expect(JSON.parse(listing.stderr).error.code).toBe('request_timeout');

    const send = await run([
      '--timeout',
      '1',
      '-a',
      'mbx_1',
      'emails',
      'send',
      '--draft',
      'd1',
      '--idempotency-key',
      'k1',
    ]);
    expect(send.code).toBe(5);
    expect(JSON.parse(send.stderr).error.message).toContain('Check the operation status before retrying a send');
    expect(send.telemetry[0]).toMatchObject({ outcome: 'error', error_code: 'request_timeout' });
  });

  it('prints connection status and accounts', async () => {
    cloud.setTool('list_accounts', () => ({ data: [{ ...mailbox, status: 'active' }] }));
    expect((await run(['status'])).json.data.workspace).toEqual({ name: 'Personal' });
    expect((await run(['accounts', 'list'])).json.data).toEqual([{ ...mailbox, status: 'active' }]);
  });

  it('reports Cloud tool errors with their code and request ID', async () => {
    cloud.setTool('list_folders', () => ({
      raw: {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'subscription_required',
              message: 'Start a plan.',
              requestId: 'req_1',
            }),
          },
        ],
      },
    }));
    const result = await run(['folders', 'list']);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: 'subscription_required', message: 'Start a plan.', requestId: 'req_1' },
    });
  });

  it('reports HTTP failures from the service', async () => {
    cloud.state.nextHttpFailure = { status: 429, code: 'hourly_limit_exceeded', message: 'Limit reached.' };
    const result = await run(['status']);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'hourly_limit_exceeded', message: 'Limit reached.' });
  });

  it('reports only the latest transport failure', async () => {
    cloud.setTool('list_emails', () => page([]));
    let attempts = 0;
    cloud.setTool('search_emails', () => {
      attempts += 1;
      return attempts === 1
        ? {
            raw: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ error: 'provider_unavailable', message: 'Busy.' }) }],
            },
          }
        : page([{ id: 'msg_1' }]);
    });
    const result = await run(['emails', 'search', 'invoice', '--all']);
    expect(result.json.data).toEqual([{ id: 'msg_1' }]);
    expect(attempts).toBe(2);
  });

  it('falls back to the older protocol when discovery is rejected', async () => {
    cloud.state.rejectDiscovery = true;
    expect((await run(['status'])).code).toBeUndefined();
    expect(cloud.state.handshakes).toBeGreaterThan(0);
  });

  it('explains a tool the connection may not use', async () => {
    cloud.setTool('send_email', () => ({ data: {} }));
    cloud.state.hiddenTools.add('send_email');
    const result = await run(['emails', 'send', '--draft', 'd1', '--idempotency-key', 'key-1']);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('does not allow this command');
  });

  it('points administration at the dashboard', async () => {
    for (const [args, page] of [
      [['members', 'list'], ''],
      [['apikey', 'list'], ''],
      [['license', 'status'], ''],
      [['accounts', 'add', 'gmail'], '/mailboxes'],
    ] as const) {
      const result = await run([...args]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr).error.message).toContain(`${cloud.origin}${page}.`);
    }
    expect(cloud.state.calls).toHaveLength(0);
  });

  it('records success and failure telemetry without private input', async () => {
    cloud.setTool('search_emails', () => page([]));
    const success = await run(['emails', 'search', 'subject:quarterly-secret']);
    expect(success.telemetry[0]).toMatchObject({
      operation: 'emails search',
      outcome: 'success',
      instance_kind: 'cloud',
    });
    cloud.state.nextHttpFailure = { status: 429, code: 'hourly_limit_exceeded', message: 'Private detail.' };
    const failure = await run(['emails', 'search', 'subject:quarterly-secret']);
    expect(failure.telemetry[0]).toMatchObject({
      outcome: 'error',
      error_code: 'hourly_limit_exceeded',
      instance_kind: 'cloud',
    });
    const serialized = JSON.stringify([...success.telemetry, ...failure.telemetry]);
    for (const value of ['quarterly-secret', 'Private detail', 'one@example.com', 'mbx_1', 'seeded']) {
      expect(serialized).not.toContain(value);
    }
  });
});

describe('Cloud credentials', () => {
  it('refreshes an expired token once and keeps the rotation', async () => {
    useSession({ expiresAt: Date.now() - 1 });
    const result = await run(['status']);

    expect(result.code).toBeUndefined();
    expect(cloud.state.refreshes).toEqual(['seeded-refresh']);
    expect(loadCloudSession('cloud')).toMatchObject({ refreshToken: 'refresh1' });
  });

  it('refreshes and retries when Cloud rejects a token before its expiry', async () => {
    useSession();
    cloud.state.accessTokens.delete('header.seeded.signature');
    const result = await run(['status']);

    expect(result.code).toBeUndefined();
    expect(cloud.state.refreshes).toHaveLength(1);
  });

  it('asks for a new login when the grant has ended', async () => {
    useSession({ expiresAt: Date.now() - 1, refreshToken: 'revoked' });
    const result = await run(['status']);

    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error.message).toContain('fluxmail --instance cloud login');
  });

  it('asks for a new login when an API key stops working', async () => {
    saveCloudInstance('cloud', cloud.origin);
    saveCloudSession('cloud', { kind: 'key', key: 'fm_revoked', serverUrl: cloud.origin });
    await expect(cloudAccessToken('cloud', cloud.origin, 'fm_revoked')).rejects.toThrow(/rejected the API key/);
    const result = await run(['--instance', 'cloud', 'status']);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error.message).toContain('fluxmail --instance cloud login --api-key');
  });

  it('never replays a refresh token across parallel processes', { timeout: 60_000 }, async () => {
    const slow = await startFakeCloud({ refreshDelayMs: 300 });
    try {
      slow.setTool('get_connection_status', () => ({ data: { mailboxes: [mailbox] } }));
      slow.state.refreshTokens.set('seeded-refresh', 'active');
      saveCloudInstance('cloud', slow.origin);
      saveCloudSession('cloud', {
        kind: 'oauth',
        serverUrl: slow.origin,
        clientId: 'client_seeded',
        accessToken: 'expired',
        refreshToken: 'seeded-refresh',
        expiresAt: Date.now() - 1,
      });

      const results = await Promise.all([1, 2, 3, 4].map(() => spawnCli(['--instance', 'cloud', 'status'])));

      expect(results).toEqual(Array(4).fill({ code: 0, stderr: '' }));
      expect(slow.state.refreshes).toEqual(['seeded-refresh']);
      expect(slow.state.replayed).toBe(false);
    } finally {
      await slow.close();
    }
  });

  it('waits for a refresh in flight before a login replaces the session', { timeout: 60_000 }, async () => {
    const slow = await startFakeCloud({ refreshDelayMs: 1_500 });
    try {
      slow.setTool('get_connection_status', () => ({ data: { mailboxes: [mailbox] } }));
      slow.state.refreshTokens.set('seeded-refresh', 'active');
      saveCloudInstance('cloud', slow.origin);
      saveCloudSession('cloud', {
        kind: 'oauth',
        serverUrl: slow.origin,
        clientId: 'client_seeded',
        accessToken: 'expired',
        refreshToken: 'seeded-refresh',
        expiresAt: Date.now() - 1,
      });

      const refreshing = spawnCli(['--instance', 'cloud', 'status']);
      while (slow.state.refreshes.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      const login = await spawnCli(['--instance', 'cloud', 'login', '--api-key'], {
        FLUXMAIL_CLOUD_API_KEY: 'fm_valid_key',
      });

      expect([await refreshing, login]).toEqual([
        { code: 0, stderr: '' },
        { code: 0, stderr: '' },
      ]);
      expect(loadCloudSession('cloud')).toEqual({ kind: 'key', key: 'fm_valid_key', serverUrl: slow.origin });
      // The login revoked the token the refresh issued, not the one it replaced.
      expect(slow.state.revocations).toEqual(['refresh1']);
    } finally {
      await slow.close();
    }
  });

  it('never sends a session to an origin other than the one that issued it', async () => {
    useSession();
    // A login moving the profile has saved the new session but not yet the new URL.
    saveCloudInstance('cloud', 'http://127.0.0.1:9');
    const result = await run(['--instance', 'cloud', 'status']);

    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error.message).toContain('Log in to instance "cloud" first.');
    expect(cloud.state.calls).toEqual([]);
  });

  it('saves the profile URL together with the session on a move', async () => {
    useSession();
    const next = await startFakeCloud();
    try {
      next.setTool('get_connection_status', () => ({ data: { mailboxes: [mailbox] } }));
      await run(['--instance', 'cloud', 'login', '--cloud', '--server', next.origin], approve);
      expect(loadCloudSession('cloud')?.serverUrl).toBe(next.origin);
      expect(loadInstanceConfig().instances.cloud).toEqual({ kind: 'cloud', serverUrl: next.origin });
    } finally {
      await next.close();
    }
  });

  it('keeps a removed profile removed when a refresh was in flight', { timeout: 60_000 }, async () => {
    const slow = await startFakeCloud({ refreshDelayMs: 1_500 });
    try {
      slow.setTool('get_connection_status', () => ({ data: { mailboxes: [mailbox] } }));
      slow.state.refreshTokens.set('seeded-refresh', 'active');
      saveCloudInstance('cloud', slow.origin);
      saveCloudSession('cloud', {
        kind: 'oauth',
        serverUrl: slow.origin,
        clientId: 'client_seeded',
        accessToken: 'expired',
        refreshToken: 'seeded-refresh',
        expiresAt: Date.now() - 1,
      });

      const refreshing = spawnCli(['--instance', 'cloud', 'status']);
      while (slow.state.refreshes.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      const removal = await spawnCli(['instances', 'remove', 'cloud']);
      await refreshing;

      expect(removal.code).toBe(0);
      expect(loadInstanceConfig().instances.cloud).toBeUndefined();
      expect(loadCloudSession('cloud')).toBeUndefined();
    } finally {
      await slow.close();
    }
  });

  it('revokes the connection on logout', async () => {
    useSession();
    const result = await run(['--instance', 'cloud', 'logout']);

    expect(result.stdout).toContain('Logged out of cloud.');
    expect(cloud.state.revocations).toEqual(['seeded-refresh']);
    expect(loadCloudSession('cloud')).toBeUndefined();
  });

  it('forgets the local credentials when Cloud is unreachable', async () => {
    useSession();
    saveCloudInstance('cloud', 'http://127.0.0.1:9');
    saveCloudSession('cloud', { ...loadCloudSession('cloud')!, serverUrl: 'http://127.0.0.1:9' });
    const result = await run(['--instance', 'cloud', 'logout']);

    expect(result.stdout).toContain('To end access, revoke it');
    expect(loadCloudSession('cloud')).toBeUndefined();
  });

  it('removes the session with the profile', () => {
    useSession();
    removeInstance('cloud');
    expect(loadCloudSession('cloud')).toBeUndefined();
    expect(existsSync(cloudCredentialPath())).toBe(true);
  });

  it('refuses to follow a redirect with credentials', async () => {
    useSession();
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    );
    try {
      const result = await run(['--instance', 'cloud', 'status']);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain('Refusing to forward credentials');
    } finally {
      vi.stubGlobal('fetch', realFetch);
    }
  });
});
