import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as stdio from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateBearer, setupInitialAdmin } from '../src/auth.js';
import { accounts } from '../src/storage/db.js';
import { createScheduledSend } from '../src/storage/scheduledSends.js';
import { createCliProgram } from '../src/cli.js';
import {
  credentialPath,
  instanceConfigPath,
  saveLocalInstance,
  saveRemoteInstance,
  saveSessionToken,
  useInstance,
} from '../src/cliInstances.js';
import type { CliStartupReason } from '../src/cliStartupDiagnostics.js';
import * as contextModule from '../src/context.js';
import type { AppContext } from '../src/context.js';
import { LicenseController } from '../src/licensing/refresher.js';
import { readLocalLogs, shutdownLogging } from '../src/logging.js';
import { SendScheduler } from '../src/scheduler/sendScheduler.js';

vi.mock('@modelcontextprotocol/server/stdio', async (importOriginal) => ({
  ...(await importOriginal<typeof stdio>()),
  serveStdio: vi.fn(),
}));

describe('CLI stdio startup', () => {
  let dataDir: string;
  const contexts: AppContext[] = [];
  let originalSignalListeners: Map<NodeJS.Signals, ReturnType<typeof process.listeners>>;
  let originalEndListeners: ReturnType<typeof process.stdin.listeners>;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-stdio-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'ba'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(stdio.serveStdio)
      .mockReset()
      .mockReturnValue({ close: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(SendScheduler.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(LicenseController.prototype, 'start').mockImplementation(() => {});
    const createContext = contextModule.createContext;
    vi.spyOn(contextModule, 'createContext').mockImplementation((options) => {
      const context = createContext(options);
      contexts.push(context);
      return context;
    });
    originalSignalListeners = new Map(
      (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => [signal, process.listeners(signal)]),
    );
    originalEndListeners = process.stdin.listeners('end');
  });

  afterEach(async () => {
    for (const context of contexts.splice(0)) {
      context.scheduler.stop();
      context.licenseController.stop();
      await context.registry.close();
      const client = (context.db as unknown as { $client: { open: boolean; close(): void } }).$client;
      if (client.open) client.close();
    }
    for (const [signal, listeners] of originalSignalListeners) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.includes(listener)) process.removeListener(signal, listener);
      }
    }
    for (const listener of process.stdin.listeners('end')) {
      if (!originalEndListeners.includes(listener)) process.stdin.removeListener('end', listener);
    }
    await shutdownLogging();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function localSession(instanceName = 'local'): Promise<string> {
    const context = contextModule.createContext();
    const setup = await setupInitialAdmin(context.db, {
      name: 'Private Owner',
      email: 'private-owner@example.com',
      password: 'River42!',
    });
    saveLocalInstance(instanceName);
    saveSessionToken(instanceName, setup.session.token);
    return setup.session.token;
  }

  function invocation(args: string[] = []) {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const program = createCliProgram({ telemetry });
    const run = () => program.parseAsync(['node', 'fluxmail', ...args]);
    return { capture, run };
  }

  function expectEvent(
    capture: ReturnType<typeof vi.fn>,
    outcome: string,
    phase: string,
    errorCode?: string,
    diagnostics: Partial<{
      startup_reason: CliStartupReason;
      startup_io_code: string;
      startup_data_dir_source: 'environment' | 'default';
      startup_instance_selection: 'automatic' | 'explicit';
    }> = {},
  ): void {
    expect(capture.mock.calls).toEqual([
      [
        'operation completed',
        {
          product_surface: 'cli',
          operation: 'stdio',
          outcome,
          startup_phase: phase,
          startup_data_dir_source: 'environment',
          startup_instance_selection: 'automatic',
          ...diagnostics,
          duration_ms: expect.any(Number),
          ...(errorCode ? { error_code: errorCode } : {}),
        },
      ],
    ]);
    const properties = JSON.stringify(capture.mock.calls);
    for (const privateInput of [
      dataDir,
      'private-owner@example.com',
      'River42!',
      'private-invalid',
      'private-work',
      'private.example.com',
      'fms_private-remote-token',
    ]) {
      expect(properties).not.toContain(privateInput);
    }
  }

  it.each([
    ['--profile', 'private-invalid'],
    ['--allow', 'private-invalid'],
    ['--profile', 'read-only', '--allow', 'private-invalid'],
  ])('reports invalid permission options as invalid requests before opening the store: %j', async (...options) => {
    const { capture, run } = invocation(['stdio', ...options]);

    await expect(run()).rejects.toMatchObject({ code: 'invalid_request' });

    expectEvent(capture, 'error', 'permissions', 'invalid_request');
    expect(contextModule.createContext).not.toHaveBeenCalled();
    expect(existsSync(path.join(dataDir, 'fluxmail.db'))).toBe(false);
  });

  it('records unconfigured instances without creating a store', async () => {
    const { capture, run } = invocation(['stdio']);
    await expect(run()).rejects.toMatchObject({ code: 'invalid_request' });
    expectEvent(capture, 'error', 'instance', 'invalid_request', { startup_reason: 'instance_not_configured' });
    expect(contextModule.createContext).not.toHaveBeenCalled();
  });

  it('requires a local login without initializing an unused store', async () => {
    saveLocalInstance();
    const { capture, run } = invocation(['stdio']);
    await expect(run()).rejects.toMatchObject({ code: 'permission_denied' });
    expectEvent(capture, 'error', 'authentication', 'permission_denied', { startup_reason: 'session_missing' });
    expect(contextModule.createContext).not.toHaveBeenCalled();
  });

  it('rejects an invalid local session and closes the context', async () => {
    await localSession();
    saveSessionToken('local', 'fms_private-invalid');
    const { capture, run } = invocation(['stdio']);
    await expect(run()).rejects.toMatchObject({ code: 'permission_denied' });
    expectEvent(capture, 'error', 'authentication', 'permission_denied', { startup_reason: 'session_invalid' });
    expect((contexts.at(-1)!.db as unknown as { $client: { open: boolean } }).$client.open).toBe(false);
    expect(stdio.serveStdio).not.toHaveBeenCalled();
  });

  it('identifies configuration failures without sending configuration values', async () => {
    await localSession();
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'private-invalid-key');
    const { capture, run } = invocation(['stdio']);
    await expect(run()).rejects.toThrow(/FLUXMAIL_ENCRYPTION_KEY/);
    expectEvent(capture, 'error', 'context', 'internal');
    expect(stdio.serveStdio).not.toHaveBeenCalled();
  });

  it('records account scope errors without capturing the account reference', async () => {
    const token = await localSession();
    const { capture, run } = invocation(['stdio', '--account', 'private-invalid-account']);
    await expect(run()).rejects.toMatchObject({ code: 'not_found' });
    expectEvent(capture, 'error', 'account_scope', 'not_found');
    expect(JSON.stringify(capture.mock.calls)).not.toContain(token);
    expect(stdio.serveStdio).not.toHaveBeenCalled();
  });

  it('starts with the authenticated local session even when the active instance is remote', async () => {
    const token = await localSession();
    saveRemoteInstance('private-work', 'https://private.example.com');
    saveSessionToken('private-work', 'fms_private-remote-token');
    useInstance('private-work');
    const { capture, run } = invocation(['stdio', '--profile', 'read-only']);

    await run();

    expectEvent(capture, 'success', 'ready');
    expect(JSON.stringify(capture.mock.calls)).not.toContain(token);
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private');
    expect(stdio.serveStdio).toHaveBeenCalledOnce();
    expect(SendScheduler.prototype.start).not.toHaveBeenCalled();
    expect(LicenseController.prototype.start).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('accepts stdio requests that carry an attachment within the configured limit', async () => {
    await localSession();
    await invocation(['stdio', '--profile', 'read-only']).run();
    const transport = vi.mocked(stdio.serveStdio).mock.calls[0]![1]!.transport as stdio.StdioServerTransport;
    const onmessage = vi.fn();
    const onerror = vi.fn();
    transport.onmessage = onmessage;
    transport.onerror = onerror;
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_draft',
        arguments: {
          attachments: [{ filename: 'large.bin', content: Buffer.alloc(8 * 1024 * 1024).toString('base64') }],
        },
      },
    };

    transport._ondata(Buffer.from(`${JSON.stringify(request)}\n`));

    expect(onerror).not.toHaveBeenCalled();
    expect(onmessage).toHaveBeenCalledWith(expect.objectContaining({ id: 1, method: 'tools/call' }));
  });

  it('reports pending mail only in the connection mailbox scope and never starts delivery', async () => {
    const token = await localSession();
    const context = contexts.at(-1)!;
    const memberId = authenticateBearer(context.db, token)!.memberId;
    for (const id of ['visible', 'hidden']) {
      context.db
        .insert(accounts)
        .values({
          id,
          provider: 'gmail',
          email: `${id}@example.com`,
          ownerMemberId: memberId,
          status: 'active',
          createdAt: Date.now(),
        })
        .run();
      createScheduledSend(context.db, { accountId: id, draftId: `draft_${id}`, sendAt: Date.now() - 1 });
    }
    const f = invocation(['stdio', '--account', 'visible', '--profile', 'read-only']);
    await f.run();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Scheduled sends pending: 1. Delivery requires'),
    );
    expect(SendScheduler.prototype.start).not.toHaveBeenCalled();
  });

  it('does not inspect schedules for a client without mail.read', async () => {
    await localSession();
    const service = await import('../src/service/emailService.js');
    const list = vi.spyOn(service.EmailService.prototype, 'listScheduled');
    const f = invocation(['stdio', '--allow', 'mail.send']);
    await f.run();
    expect(list).not.toHaveBeenCalled();
    expect(SendScheduler.prototype.start).not.toHaveBeenCalled();
  });

  it('starts with a sole named local profile when the active profile is remote', async () => {
    const token = await localSession('private-personal');
    saveRemoteInstance('private-work', 'https://private.example.com');
    saveSessionToken('private-work', 'fms_private-remote-token');
    useInstance('private-work');
    const { capture, run } = invocation(['stdio']);

    await run();

    expectEvent(capture, 'success', 'ready');
    expect(JSON.stringify(capture.mock.calls)).not.toContain(token);
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private');
    expect(stdio.serveStdio).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('rejects an explicitly selected remote instance before opening a local store', async () => {
    saveRemoteInstance('private-work', 'https://private.example.com');
    saveSessionToken('private-work', 'fms_private-remote-token');
    const { capture, run } = invocation(['--instance', 'private-work', 'stdio']);
    await expect(run()).rejects.toMatchObject({ code: 'invalid_request' });
    expectEvent(capture, 'error', 'instance', 'invalid_request', {
      startup_reason: 'local_instance_required',
      startup_instance_selection: 'explicit',
    });
    expect(contextModule.createContext).not.toHaveBeenCalled();
  });

  it.each(['missing', 'expired'])('directs a %s named local session to the matching login', async (session) => {
    if (session === 'expired') {
      await localSession('private-personal');
      saveSessionToken('private-personal', 'fms_private-invalid');
    } else saveLocalInstance('private-personal');
    saveRemoteInstance('private-work', 'https://private.example.com');
    useInstance('private-work');
    const { capture, run } = invocation(['stdio']);

    await expect(run()).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringContaining('fluxmail --instance private-personal login'),
    });

    expectEvent(capture, 'error', 'authentication', 'permission_denied', {
      startup_reason: session === 'missing' ? 'session_missing' : 'session_invalid',
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-personal');
    expect(stdio.serveStdio).not.toHaveBeenCalled();
    if (session === 'missing') expect(contextModule.createContext).not.toHaveBeenCalled();
  });

  it('reports ambiguous local profiles before reading credentials or opening the store', async () => {
    saveLocalInstance('private-personal');
    saveLocalInstance('private-other');
    saveRemoteInstance('private-work', 'https://private.example.com');
    useInstance('private-work');
    const { capture, run } = invocation(['stdio']);

    await expect(run()).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('fluxmail --instance <name> stdio'),
    });

    expectEvent(capture, 'error', 'instance', 'invalid_request', { startup_reason: 'local_instance_ambiguous' });
    expect(contextModule.createContext).not.toHaveBeenCalled();
    expect(stdio.serveStdio).not.toHaveBeenCalled();
  });

  it('records transport failures and closes the context without starting background work', async () => {
    await localSession();
    vi.mocked(stdio.serveStdio).mockImplementation(() => {
      throw new Error('private-invalid-transport');
    });
    const { capture, run } = invocation(['stdio']);

    await expect(run()).rejects.toThrow('private-invalid-transport');

    expectEvent(capture, 'error', 'transport', 'internal');
    expect(SendScheduler.prototype.start).not.toHaveBeenCalled();
    expect(LicenseController.prototype.start).not.toHaveBeenCalled();
    expect((contexts.at(-1)!.db as unknown as { $client: { open: boolean } }).$client.open).toBe(false);
  });

  it('distinguishes an unknown explicit instance from an unconfigured installation', async () => {
    const { capture, run } = invocation(['--instance', 'private-missing', 'stdio']);
    await expect(run()).rejects.toMatchObject({ code: 'not_found' });
    expectEvent(capture, 'error', 'instance', 'not_found', {
      startup_reason: 'instance_not_found',
      startup_instance_selection: 'explicit',
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-missing');
    expect(contextModule.createContext).not.toHaveBeenCalled();
  });

  it.each(['instance_config', 'credentials'] as const)(
    'identifies invalid %s JSON without capturing its contents',
    async (kind) => {
      if (kind === 'credentials') saveLocalInstance();
      const file = kind === 'instance_config' ? instanceConfigPath() : credentialPath();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '{"private-owner@example.com":"fms_private-remote-token"');
      const { capture, run } = invocation(['stdio']);
      await expect(run()).rejects.toMatchObject({ code: 'invalid_request' });
      expectEvent(capture, 'error', 'instance', 'invalid_request', { startup_reason: `${kind}_invalid_json` });
      expect(JSON.stringify(capture.mock.calls)).not.toContain(file);
      expect(contextModule.createContext).not.toHaveBeenCalled();
    },
  );

  it.each(['instance_config', 'credentials'] as const)(
    'records the safe filesystem code for an unreadable %s file',
    async (kind) => {
      if (kind === 'credentials') saveLocalInstance();
      const file = kind === 'instance_config' ? instanceConfigPath() : credentialPath();
      mkdirSync(file, { recursive: true });
      const { capture, run } = invocation(['stdio']);
      await expect(run()).rejects.toMatchObject({ code: 'invalid_request' });
      expectEvent(capture, 'error', 'instance', 'invalid_request', {
        startup_reason: `${kind}_read_failed`,
        startup_io_code: 'EISDIR',
      });
      expect(JSON.stringify(capture.mock.calls)).not.toContain(file);
      expect(contextModule.createContext).not.toHaveBeenCalled();
    },
  );

  it('retains the same startup diagnostics in the local structured log', async () => {
    const { capture, run } = invocation(['stdio']);
    await expect(run()).rejects.toMatchObject({ code: 'invalid_request' });
    await shutdownLogging();
    const entries = readLocalLogs(dataDir, { tail: 20, minimumLevel: 'warn' }).entries;
    const failure = entries.find((entry) => entry.record.event === 'cli.operation_failed')!.record;
    expect(failure.details).toEqual({
      startup_phase: 'instance',
      startup_data_dir_source: 'environment',
      startup_instance_selection: 'automatic',
      startup_reason: 'instance_not_configured',
    });
    expect(failure.error?.code).toBe('invalid_request');
    expect(capture.mock.calls[0]![1]).toMatchObject(failure.details!);
  });

  it('records the default data directory source without sending the home path', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', '');
    const { capture, run } = invocation(['--instance', 'private-missing', 'stdio']);
    // Keep filesystem access isolated while exercising the unset-directory branch.
    vi.spyOn(await import('../src/config.js'), 'resolveDataDir').mockReturnValue(dataDir);
    await expect(run()).rejects.toMatchObject({ code: 'not_found' });
    expectEvent(capture, 'error', 'instance', 'not_found', {
      startup_reason: 'instance_not_found',
      startup_instance_selection: 'explicit',
      startup_data_dir_source: 'default',
    });
    expect(contextModule.createContext).not.toHaveBeenCalled();
  });
});
