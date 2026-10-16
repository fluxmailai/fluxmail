import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { ImapProvider } from '@fluxmail/provider-imap';
import { setupInitialAdmin } from '../src/auth.js';
import { createCliProgram } from '../src/cli.js';
import {
  InstanceClient,
  credentialPath,
  instanceConfigPath,
  instanceResponseError,
  loadInstanceConfig,
  resolveInstance,
  resolveStdioInstance,
  saveLocalInstance,
  saveRemoteInstance,
  saveSessionToken,
  setRequestDeadlineMs,
  useInstance,
  validateRemoteServerUrl,
} from '../src/cliInstances.js';
import { createContext } from '../src/context.js';
import { failureProperties, getTelemetry } from '../src/telemetry.js';

const { appDeps } = vi.hoisted(() => ({ appDeps: [] as Array<{ telemetry?: unknown; logger?: unknown }> }));

vi.mock('../src/http/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/http/app.js')>();
  return {
    ...actual,
    createApp: (deps: Parameters<typeof actual.createApp>[0]) => {
      appDeps.push(deps);
      return actual.createApp(deps);
    },
  };
});

function privateMode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe('CLI instance profiles', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('stores profile metadata separately from owner-readable session credentials', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-instances-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    saveLocalInstance('local');
    saveRemoteInstance('work', 'https://mail.example.com/');
    saveSessionToken('work', 'fms_secret');

    expect(loadInstanceConfig()).toMatchObject({
      active: 'local',
      instances: { local: { kind: 'local' }, work: { kind: 'remote', serverUrl: 'https://mail.example.com' } },
    });
    expect(resolveInstance('work')).toMatchObject({ name: 'work', token: 'fms_secret' });
    expect(instanceConfigPath()).not.toBe(credentialPath());
    expect(privateMode(instanceConfigPath())).toBe(0o600);
    expect(privateMode(credentialPath())).toBe(0o600);
    expect(privateMode(path.dirname(credentialPath()))).toBe(0o700);
  });

  it('requires HTTPS except for loopback servers', () => {
    expect(validateRemoteServerUrl('https://mail.example.com/path/?ignored=yes#hash')).toBe(
      'https://mail.example.com/path',
    );
    expect(validateRemoteServerUrl('http://127.0.0.1:8977')).toBe('http://127.0.0.1:8977');
    expect(() => validateRemoteServerUrl('http://mail.example.com')).toThrow(/require HTTPS/);
    expect(() => validateRemoteServerUrl('https://user:password@mail.example.com')).toThrow(
      /cannot contain credentials/,
    );
  });

  it('keeps stdio on the local session when the CLI switches to a remote instance', () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-stdio-instance-')));
    saveLocalInstance();
    saveSessionToken('local', 'fms_private_local_session');
    saveRemoteInstance('work', 'https://private.example.com');
    saveSessionToken('work', 'fms_private_remote_session');
    useInstance('work');

    expect(resolveInstance().name).toBe('work');
    expect(resolveStdioInstance()).toMatchObject({ name: 'local', token: 'fms_private_local_session' });
    expect(resolveInstance().name).toBe('work');
    expect(() => resolveStdioInstance('work')).toThrow(/requires a local instance/);
  });

  it('preserves an active named local profile and explicit local selections for stdio', () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-stdio-instance-')));
    saveLocalInstance();
    saveSessionToken('local', 'fms_private_local_session');
    saveLocalInstance('personal');
    saveSessionToken('personal', 'fms_private_personal_session');

    expect(resolveStdioInstance()).toMatchObject({ name: 'personal', token: 'fms_private_personal_session' });
    expect(resolveStdioInstance('local')).toMatchObject({ name: 'local', token: 'fms_private_local_session' });
    expect(() => resolveStdioInstance('missing')).toThrow(/No CLI instance/);
  });

  it('does not use remote credentials or create a local profile for stdio', () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-stdio-instance-')));
    expect(() => resolveStdioInstance()).toThrow(/No CLI instance is configured/);
    saveRemoteInstance('work', 'https://private.example.com');
    saveSessionToken('work', 'fms_private_remote_session');

    expect(() => resolveStdioInstance()).toThrow(/requires a local instance/);
    expect(loadInstanceConfig().instances.local).toBeUndefined();
  });

  it.each(['work', undefined, 'missing'])('finds a sole named local profile when active is %s', (active) => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-stdio-instance-')));
    saveLocalInstance('personal');
    saveSessionToken('personal', 'fms_private_personal_session');
    saveRemoteInstance('work', 'https://private.example.com');
    saveSessionToken('work', 'fms_private_remote_session');
    const config = loadInstanceConfig();
    config.active = active;
    writeFileSync(instanceConfigPath(), JSON.stringify(config));
    const before = readFileSync(instanceConfigPath(), 'utf8');

    expect(resolveStdioInstance()).toMatchObject({ name: 'personal', token: 'fms_private_personal_session' });
    expect(readFileSync(instanceConfigPath(), 'utf8')).toBe(before);
    expect(() => resolveStdioInstance('work')).toThrow(/requires a local instance/);
    expect(() => resolveStdioInstance('missing')).toThrow(/No CLI instance/);
  });

  it('requires an explicit choice between named local profiles when a remote is active', () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-stdio-instance-')));
    saveLocalInstance('personal');
    saveLocalInstance('other');
    saveRemoteInstance('work', 'https://private.example.com');
    useInstance('work');

    expect(() => resolveStdioInstance()).toThrow(/Multiple local CLI profiles.*--instance/);
    expect(resolveStdioInstance('personal').name).toBe('personal');
    expect(resolveInstance().name).toBe('work');
  });

  it('refuses to forward a session through a remote redirect', async () => {
    const fetchMock = vi.fn(
      async (_input: URL, _init: RequestInit) =>
        new Response(null, { status: 302, headers: { location: 'https://other.example.com/api/v1/me' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new InstanceClient('work', { kind: 'remote', serverUrl: 'https://mail.example.com' }, 'fms_secret');

    await expect(client.request('/api/v1/me')).rejects.toMatchObject({ code: 'permission_denied' });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://mail.example.com/api/v1/me'),
      expect.objectContaining({ redirect: 'manual' }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer fms_secret');
  });

  it('keeps a configured server path when building remote API URLs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new InstanceClient(
      'work',
      { kind: 'remote', serverUrl: 'https://mail.example.com/fluxmail' },
      'fms_secret',
    );

    await expect(client.json('/api/v1/me')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://mail.example.com/fluxmail/api/v1/me'),
      expect.objectContaining({ redirect: 'manual' }),
    );
    await expect(client.request('/https://other.example.com/steal')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('allows a remote request to finish after the default deadline when given a longer deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        (_input: URL, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(new Response(null, { status: 204 })), 30_500);
            init.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              },
              { once: true },
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new InstanceClient(
        'work',
        { kind: 'remote', serverUrl: 'https://mail.example.com' },
        'fms_secret',
        35_000,
      );

      const request = client.request('/api/v1/accounts/connections', { method: 'POST' });
      await vi.advanceTimersByTimeAsync(30_500);

      await expect(request).resolves.toMatchObject({ status: 204 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('can retain REST metadata and safe error codes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: ['message'], meta: { nextPageToken: 'next' }, warnings: ['renew'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'idempotency_conflict', message: 'Use a new key.' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new InstanceClient('work', { kind: 'remote', serverUrl: 'https://mail.example.com' }, 'fms_secret');

    await expect(client.jsonEnvelope('/api/v1/messages')).resolves.toEqual({
      data: ['message'],
      meta: { nextPageToken: 'next' },
      warnings: ['renew'],
    });
    await expect(client.jsonEnvelope('/api/v1/send')).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409,
      message: 'Use a new key.',
    });
  });

  it('preserves existing REST request ids and validates setup diagnostic ids', () => {
    expect(instanceResponseError('rate_limited', 'Try later.', 429, undefined, 'request-123')).toMatchObject({
      requestId: 'request-123',
    });
    expect(
      instanceResponseError('provider_unavailable', 'Unavailable.', 503, undefined, 'request-123', 'provider_check'),
    ).toMatchObject({ requestId: undefined, connectionStage: 'provider_check' });
  });

  it('closes IMAP providers after a local request', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-local-cleanup-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '66'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const setupContext = createContext();
    const setup = await setupInitialAdmin(setupContext.db, {
      name: 'Local Owner',
      email: 'local@example.com',
      password: 'River42!',
    });
    const account = setupContext.registry.addImapAccount(
      'local@example.com',
      {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'local', password: 'private' },
        smtp: { host: 'smtp.example.com', port: 465, security: 'tls', user: 'local', password: 'private' },
        saveSent: false,
      },
      undefined,
      setup.member.id,
    );
    (setupContext.db as unknown as { $client: { close(): void } }).$client.close();
    vi.spyOn(ImapProvider.prototype, 'listMessages').mockResolvedValue({ items: [] });
    const close = vi.spyOn(ImapProvider.prototype, 'close').mockResolvedValue();
    const client = new InstanceClient('local', { kind: 'local' }, setup.session.token);

    await expect(
      client.json(`/api/v1/accounts/${encodeURIComponent(account.id)}/messages?folder=inbox&pageSize=100`),
    ).resolves.toEqual([]);

    expect(close).toHaveBeenCalledOnce();
  });

  it('times out a local request without closing its in-flight provider', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-local-timeout-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '88'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const setupContext = createContext();
    const setup = await setupInitialAdmin(setupContext.db, {
      name: 'Local Owner',
      email: 'local@example.com',
      password: 'River42!',
    });
    const account = setupContext.registry.addImapAccount(
      'local@example.com',
      {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'local', password: 'private' },
        smtp: { host: 'smtp.example.com', port: 465, security: 'tls', user: 'local', password: 'private' },
        saveSent: false,
      },
      undefined,
      setup.member.id,
    );
    (setupContext.db as unknown as { $client: { close(): void } }).$client.close();
    let release!: () => void;
    const pending = new Promise<{ items: [] }>((resolve) => {
      release = () => resolve({ items: [] });
    });
    vi.spyOn(ImapProvider.prototype, 'listMessages').mockImplementation(() => pending);
    const close = vi.spyOn(ImapProvider.prototype, 'close').mockResolvedValue();
    const client = new InstanceClient('local', { kind: 'local' }, setup.session.token);
    setRequestDeadlineMs(1_000);
    try {
      await expect(
        client.request(`/api/v1/accounts/${encodeURIComponent(account.id)}/messages?folder=inbox&pageSize=100`),
      ).rejects.toMatchObject({ code: 'request_timeout' });
      expect(close).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    } finally {
      release();
      setRequestDeadlineMs(30_000);
    }
  });

  it('records a local request in process so one action is not counted twice', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-local-telemetry-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '77'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const setupContext = createContext();
    const setup = await setupInitialAdmin(setupContext.db, {
      name: 'Local Owner',
      email: 'local@example.com',
      password: 'River42!',
    });
    (setupContext.db as unknown as { $client: { close(): void } }).$client.close();
    const client = new InstanceClient('local', { kind: 'local' }, setup.session.token);
    appDeps.length = 0;

    const response = await client.request('/api/v1/me');

    expect(response.status).toBe(200);
    expect(appDeps).toHaveLength(1);
    expect(appDeps[0]!.telemetry).toBeDefined();
    expect(appDeps[0]!.telemetry).not.toBe(getTelemetry(dataDir));
    // The CLI command reports the outcome; local logs still record REST failures.
    expect(appDeps[0]!.logger).toBeDefined();
  });

  it('passes provider failure detail from a local request to the CLI error', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-local-failure-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '99'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const setupContext = createContext();
    const setup = await setupInitialAdmin(setupContext.db, {
      name: 'Local Owner',
      email: 'local@example.com',
      password: 'River42!',
    });
    const account = setupContext.registry.addImapAccount(
      'local@example.com',
      {
        imap: { host: 'imap.private.example', port: 993, security: 'tls', user: 'local', password: 'private' },
        smtp: { host: 'smtp.private.example', port: 465, security: 'tls', user: 'local', password: 'private' },
        saveSent: false,
      },
      undefined,
      setup.member.id,
    );
    (setupContext.db as unknown as { $client: { close(): void } }).$client.close();
    vi.spyOn(ImapProvider.prototype, 'listFolders').mockRejectedValue(
      new EmailError('provider_unavailable', 'connect ECONNREFUSED imap.private.example:993', undefined, {
        phase: 'connect',
        reason: 'connection_refused',
        ioCode: 'ECONNREFUSED',
      }),
    );
    vi.spyOn(ImapProvider.prototype, 'close').mockResolvedValue();
    const client = new InstanceClient('local', { kind: 'local' }, setup.session.token);

    const error = await client.json(`/api/v1/accounts/${encodeURIComponent(account.id)}/folders`).catch((e) => e);

    expect(error).toMatchObject({ code: 'provider_unavailable' });
    expect(failureProperties(error)).toEqual({
      provider: 'imap',
      failure_reason: 'connection_refused',
      failure_phase: 'connect',
      provider_http_status: undefined,
      io_code: 'ECONNREFUSED',
    });
    expect(JSON.stringify(failureProperties(error))).not.toContain('private.example');
  });

  it('reports local provider failure detail for partial batch failures and attachment downloads', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-local-partial-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'aa'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const setupContext = createContext();
    const setup = await setupInitialAdmin(setupContext.db, {
      name: 'Local Owner',
      email: 'local@example.com',
      password: 'River42!',
    });
    const account = setupContext.registry.addImapAccount(
      'local@example.com',
      {
        imap: { host: 'imap.private.example', port: 993, security: 'tls', user: 'local', password: 'private' },
        smtp: { host: 'smtp.private.example', port: 465, security: 'tls', user: 'local', password: 'private' },
        saveSent: false,
      },
      undefined,
      setup.member.id,
    );
    (setupContext.db as unknown as { $client: { close(): void } }).$client.close();
    saveLocalInstance('local');
    saveSessionToken('local', setup.session.token);
    const refused = () =>
      new EmailError('provider_unavailable', 'connect ECONNREFUSED imap.private.example:993', undefined, {
        phase: 'connect',
        reason: 'connection_refused',
        ioCode: 'ECONNREFUSED',
      });
    const listMessages = vi.spyOn(ImapProvider.prototype, 'listMessages').mockRejectedValue(refused());
    const getAttachment = vi.spyOn(ImapProvider.prototype, 'getAttachment').mockRejectedValue(refused());
    const close = vi.spyOn(ImapProvider.prototype, 'close').mockResolvedValue();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const detail = {
      provider: 'imap',
      failure_reason: 'connection_refused',
      failure_phase: 'connect',
      io_code: 'ECONNREFUSED',
    };
    const cli = (args: string[]) =>
      createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', '--instance', 'local', ...args]);

    try {
      await cli(['emails', 'search-batch', 'subject:private', '--account', account.id]);
      await cli([
        '--mail-account',
        account.id,
        'attachments',
        'download',
        'msg_private',
        'att_private',
        '--output',
        path.join(dataDir, 'private.txt'),
      ]);
    } finally {
      process.exitCode = undefined;
      listMessages.mockRestore();
      getAttachment.mockRestore();
      close.mockRestore();
      vi.mocked(console.log).mockRestore();
      vi.mocked(console.error).mockRestore();
    }

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'cli',
        operation: 'emails search-batch',
        outcome: 'error',
        error_code: 'partial_failure',
        ...detail,
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'cli',
        operation: 'attachments download',
        outcome: 'error',
        error_code: 'provider_unavailable',
        ...detail,
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(/private\.example|subject:private|msg_private|att_private/);
  });
});
