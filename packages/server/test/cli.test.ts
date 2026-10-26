import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCliProgram,
  installStdioShutdownHandler,
  permissionPolicyForUpdate,
  permissionPolicyFromOptions,
  shutdownTelemetryAndLogging,
  waitForServerListening,
} from '../src/cli.js';
import { resolveDeploymentConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { setupInitialAdmin } from '../src/auth.js';
import { saveLocalInstance, saveRemoteInstance, saveSessionToken } from '../src/cliInstances.js';
import { InstanceConfigStore } from '../src/instanceConfig.js';
import { getLogger } from '../src/logging.js';
import {
  FULL_PERMISSION_POLICY,
  customPermissionPolicy,
  enableCapabilitiesInstructions,
  permissionOptionsGranting,
  permissionPolicyForProfile,
} from '../src/permissions.js';
import { encryptString } from '../src/storage/crypto.js';
import {
  accountCredentials,
  accounts,
  inspectStoreCompatibility,
  instanceSettings,
  openDb,
} from '../src/storage/db.js';
import { getTelemetry } from '../src/telemetry.js';
import { AccountRegistry, IMAP_CONNECTION_TEST_TIMEOUT_MS } from '../src/accounts/registry.js';
import type { AuthorizedOAuthResult } from '../src/accounts/googleAuth.js';
import type { MicrosoftOAuthResult } from '../src/accounts/microsoftAuth.js';

const oauthFlowMocks = vi.hoisted(() => ({ google: vi.fn(), microsoft: vi.fn() }));

vi.mock('../src/accounts/googleAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/accounts/googleAuth.js')>();
  return { ...actual, runLoopbackFlow: oauthFlowMocks.google as typeof actual.runLoopbackFlow };
});

vi.mock('../src/accounts/microsoftAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/accounts/microsoftAuth.js')>();
  return { ...actual, runMicrosoftLoopbackFlow: oauthFlowMocks.microsoft as typeof actual.runMicrosoftLoopbackFlow };
});

const runFile = promisify(execFile);
const configMigrationModuleUrl = new URL('../src/configMigration.ts', import.meta.url).href;
const fileLockModuleUrl = new URL('../src/storage/fileLock.ts', import.meta.url).href;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function telemetrySpy() {
  const capture = vi.fn();
  return { capture, telemetry: { capture, shutdown: vi.fn().mockResolvedValue(undefined) } };
}

describe('CLI telemetry', () => {
  it('records a send-as update without capturing the account or address', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-send-as-add-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'ad'.repeat(32));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();
    const privateAlias = 'private-alias@example.com';

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      const account = context.registry.addImapAccount(
        'mailbox@example.com',
        {
          imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'mailbox', password: 'secret' },
          smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'mailbox', password: 'secret' },
          saveSent: true,
          folderOverrides: {},
        },
        undefined,
        setup.member.id,
      );
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'send-as',
        'add',
        account.id,
        privateAlias,
        '--name',
        'Private Sales',
      ]);

      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'accounts send-as add',
        outcome: 'success',
        duration_ms: expect.any(Number),
      });
      const captured = JSON.stringify(capture.mock.calls);
      expect(captured).not.toContain(account.id);
      expect(captured).not.toContain(privateAlias);
      expect(captured).not.toContain('Private Sales');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('records a send-as lookup error without capturing the account reference', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-send-as-list-error-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'ae'.repeat(32));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();
    const privateAccount = 'acct_private_send_as';

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'send-as',
        'list',
        privateAccount,
      ]);

      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'accounts send-as list',
        outcome: 'error',
        error_code: 'not_found',
        duration_ms: expect.any(Number),
      });
      expect(JSON.stringify(capture.mock.calls)).not.toContain(privateAccount);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('flushes local logs when a stdio stream ends', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-stdio-logging-'));
    const input = new PassThrough();
    const logger = getLogger(dataDir, 'stdio', { level: 'info', destination: 'file' });
    installStdioShutdownHandler(input);
    logger.error('mcp.operation_failed', 'Final request failed', new Error('provider unavailable'));

    input.resume();
    input.end();

    const logFile = path.join(dataDir, 'logs', 'fluxmail.jsonl');
    await vi.waitFor(() => expect(readFileSync(logFile, 'utf8')).toContain('mcp.operation_failed'));
  });

  it('flushes local logs while telemetry waits for an active operation', async () => {
    await shutdownTelemetryAndLogging();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-signal-logging-'));
    const finishActivity = getTelemetry(dataDir).beginActivity?.();
    const logger = getLogger(dataDir, 'serve', { level: 'info', destination: 'file' });
    logger.error('server.operation_failed', 'Request was interrupted', new Error('provider unavailable'));

    let shutdownFinished = false;
    const shutdown = shutdownTelemetryAndLogging().then(() => {
      shutdownFinished = true;
    });

    const logFile = path.join(dataDir, 'logs', 'fluxmail.jsonl');
    await vi.waitFor(() => expect(readFileSync(logFile, 'utf8')).toContain('server.operation_failed'));
    expect(shutdownFinished).toBe(false);
    logger.error('server.final_failure', 'Active request failed during shutdown', new Error('request interrupted'));

    finishActivity?.();
    await shutdown;
    expect(shutdownFinished).toBe(true);
    expect(readFileSync(logFile, 'utf8')).toContain('server.final_failure');
  });

  it('shows filtered local logs and records only the command telemetry', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-logs-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const logDir = path.join(dataDir, 'logs');
    mkdirSync(logDir);
    const record = (level: 'info' | 'warn' | 'error', event: string) =>
      JSON.stringify({
        timestamp: '2026-07-19T12:00:00.000Z',
        level,
        event,
        message: `${event} message`,
        version: 'test',
        pid: 1,
        run_id: 'run',
        process_mode: 'serve',
      });
    writeFileSync(
      path.join(logDir, 'fluxmail.jsonl'),
      `${record('info', 'server.started')}\n${record('error', 'server.failed')}\n`,
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'logs', '--level', 'error', '--json']);

    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('server.failed'));
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'cli', operation: 'logs', outcome: 'success' }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('server.failed');
  });

  it('keeps plain local log output on one physical line', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-plain-logs-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const logDir = path.join(dataDir, 'logs');
    mkdirSync(logDir);
    writeFileSync(
      path.join(logDir, 'fluxmail.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-07-19T12:00:00.000Z',
        level: 'error',
        event: 'provider.failed\nforged.event\u001b[2J',
        message: 'First line\r\n2026-01-01 ERROR forged: second line\u0007',
        version: 'test',
        pid: 1,
        run_id: 'run',
        process_mode: 'serve',
      })}\n`,
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { telemetry } = telemetrySpy();

    await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'logs']);

    expect(output).toHaveBeenCalledTimes(1);
    const line = String(output.mock.calls[0]?.[0]);
    expect(
      [...line].some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
      }),
    ).toBe(false);
    expect(line).toContain('provider.failed\\nforged.event');
    expect(line).toContain('First line\\r\\n2026-01-01 ERROR forged: second line');
    expect(line).toContain('\\x1b[2J');
    expect(line).toContain('\\x07');
  });

  it('records a safe logs command error without the invalid option value', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-logs-error-')));
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    try {
      await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'logs', '--tail', 'private-invalid-value']);

      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({
          product_surface: 'cli',
          operation: 'logs',
          outcome: 'error',
          error_code: 'invalid_request',
        }),
      );
      expect(JSON.stringify(capture.mock.calls)).not.toContain('private-invalid-value');
      expect(output).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('rejects server startup errors before the command can be recorded as successful', async () => {
    const startupError = new Error('address already in use');
    const server = createServer();
    const listening = waitForServerListening(server);

    server.emit('error', startupError);

    await expect(listening).rejects.toBe(startupError);
  });

  it('records successful commands with the shared operation schema', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-telemetry-')));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'telemetry', 'status']);

    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'telemetry status',
      outcome: 'success',
      duration_ms: expect.any(Number),
    });
    expect(log).toHaveBeenCalled();
  });

  it('records command failures without arguments or error text', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    try {
      await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'license', 'activate', 'private-key']);

      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'license activate',
        outcome: 'error',
        error_code: 'command_failed',
        duration_ms: expect.any(Number),
      });
      expect(JSON.stringify(capture.mock.calls)).not.toContain('private-key');
      expect(error).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('records a safe error code when account setup rejects a provider', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    try {
      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        'accounts',
        'add',
        'private-provider-value',
      ]);

      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'accounts add',
        outcome: 'error',
        error_code: 'invalid_request',
        failure_kind: 'validation_error',
        duration_ms: expect.any(Number),
      });
      expect(JSON.stringify(capture.mock.calls)).not.toContain('private-provider-value');
      expect(error).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('records the operation error code from a local dispatch instead of a generic failure', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-accounts-add-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '88'.repeat(32));
    vi.stubEnv('FLUXMAIL_IMAP_PASSWORD_FOR_TEST', 'private-imap-password');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'add',
        'imap',
        '--reauthorize',
        'acct_private_reference',
        '--email',
        'owner@example.com',
        '--imap-host',
        'imap.example.com',
        '--smtp-host',
        'smtp.example.com',
        '--imap-password-env',
        'FLUXMAIL_IMAP_PASSWORD_FOR_TEST',
      ]);

      // The local instance answers in this process, so the command reports the
      // REST error code once rather than a second, generic CLI event.
      expect(capture.mock.calls).toEqual([
        [
          'operation completed',
          expect.objectContaining({
            product_surface: 'cli',
            operation: 'accounts add',
            outcome: 'error',
            error_code: 'not_found',
            duration_ms: expect.any(Number),
            provider: 'imap',
            reauthorize: true,
            connection_flow: 'imap_credentials',
            connection_stage: 'server_validation',
            request_timeout_class: 'imap_margin',
            http_status: 404,
            failure_kind: 'http_error',
            connection_request_duration_ms: expect.any(Number),
          }),
        ],
      ]);
      const captured = JSON.stringify(capture.mock.calls);
      expect(captured).not.toContain('private-imap-password');
      expect(captured).not.toContain('acct_private_reference');
      expect(captured).not.toContain('owner@example.com');
      expect(captured).not.toContain('imap.example.com');
      expect(error).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('records mailbox totals and implicit reauthorization for a local IMAP connection', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-accounts-add-success-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'bb'.repeat(32));
    vi.stubEnv('FLUXMAIL_IMAP_PASSWORD_FOR_TEST', 'private-imap-password');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(AccountRegistry.prototype, 'testImapCredentials').mockResolvedValue([]);
    const { capture, telemetry } = telemetrySpy();
    const privateMailbox = 'private@example.com';

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      context.registry.addImapAccount(
        privateMailbox,
        {
          imap: { host: 'old-imap.example.com', port: 993, security: 'tls', user: privateMailbox, password: 'old' },
          smtp: {
            host: 'old-smtp.example.com',
            port: 587,
            security: 'starttls',
            user: privateMailbox,
            password: 'old',
          },
          saveSent: true,
          folderOverrides: {},
        },
        undefined,
        setup.member.id,
      );
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'add',
        'imap',
        '--email',
        privateMailbox,
        '--imap-host',
        'imap.example.com',
        '--smtp-host',
        'smtp.example.com',
        '--imap-password-env',
        'FLUXMAIL_IMAP_PASSWORD_FOR_TEST',
      ]);

      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'accounts add',
        outcome: 'success',
        duration_ms: expect.any(Number),
        provider: 'imap',
        reauthorize: true,
        connection_flow: 'imap_credentials',
        connection_stage: 'complete',
        request_timeout_class: 'imap_margin',
        connection_request_duration_ms: expect.any(Number),
        account_count: 1,
        gmail_account_count: 0,
        outlook_account_count: 0,
        imap_account_count: 1,
      });
      const captured = JSON.stringify(capture.mock.calls);
      expect(captured).not.toContain(privateMailbox);
      expect(captured).not.toContain('private-imap-password');
      expect(captured).not.toContain('imap.example.com');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('records the local dispatch error code for every command, not just accounts add', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-accounts-remove-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'aa'.repeat(32));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'remove',
        'acct_private_reference',
      ]);

      expect(capture.mock.calls).toEqual([
        [
          'operation completed',
          {
            product_surface: 'cli',
            operation: 'accounts remove',
            outcome: 'error',
            error_code: 'not_found',
            duration_ms: expect.any(Number),
          },
        ],
      ]);
      const captured = JSON.stringify(capture.mock.calls);
      expect(captured).not.toContain('acct_private_reference');
      expect(captured).not.toContain('owner@example.com');
      expect(error).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('records the provider and mailbox totals after a local account removal', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-accounts-remove-success-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'cc'.repeat(32));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();
    const privateMailbox = 'private@example.com';

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      const account = context.registry.addImapAccount(
        privateMailbox,
        {
          imap: { host: 'imap.example.com', port: 993, security: 'tls', user: privateMailbox, password: 'secret' },
          smtp: {
            host: 'smtp.example.com',
            port: 587,
            security: 'starttls',
            user: privateMailbox,
            password: 'secret',
          },
          saveSent: true,
          folderOverrides: {},
        },
        undefined,
        setup.member.id,
      );
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'remove',
        account.id,
      ]);

      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'accounts remove',
        outcome: 'success',
        duration_ms: expect.any(Number),
        provider: 'imap',
        account_count: 0,
        gmail_account_count: 0,
        outlook_account_count: 0,
        imap_account_count: 0,
      });
      const captured = JSON.stringify(capture.mock.calls);
      expect(captured).not.toContain(privateMailbox);
      expect(captured).not.toContain(account.id);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each(['gmail', 'outlook'] as const)(
    'names the loopback flag when a public URL selected the hosted %s connection',
    async (provider) => {
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      const dataDir = mkdtempSync(path.join(tmpdir(), `fluxmail-cli-hosted-${provider}-`));
      vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
      vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '99'.repeat(32));
      vi.stubEnv('FLUXMAIL_PUBLIC_URL', 'https://mail.example.com');
      const messages: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((line: string) => messages.push(line));
      const { capture, telemetry } = telemetrySpy();

      try {
        const context = createContext();
        const setup = await setupInitialAdmin(context.db, {
          name: 'Local Owner',
          email: 'owner@example.com',
          password: 'River42!',
        });
        (context.db as unknown as { $client: { close(): void } }).$client.close();
        saveLocalInstance('local');
        saveSessionToken('local', setup.session.token);

        await createCliProgram({ telemetry }).parseAsync([
          'node',
          'fluxmail',
          '--no-update-notifier',
          'accounts',
          'add',
          provider,
        ]);

        expect(messages.join('\n')).toContain('FLUXMAIL_PUBLIC_URL is set');
        expect(messages.join('\n')).toContain('--local');
        expect(capture).toHaveBeenCalledWith('operation completed', {
          product_surface: 'cli',
          operation: 'accounts add',
          outcome: 'error',
          error_code: 'invalid_request',
          failure_kind: 'validation_error',
          duration_ms: expect.any(Number),
          provider,
          reauthorize: false,
          connection_flow: 'hosted',
          connection_stage: 'cli_validation',
          oauth_app: 'built-in',
        });
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  it('records a hosted Gmail connection with the operator OAuth application', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-hosted-custom-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '77'.repeat(32));
    vi.stubEnv('FLUXMAIL_PUBLIC_URL', 'https://mail.example.com');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'private-google-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'private-google-client-secret');
    const messages: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => messages.push(line));
    const { capture, telemetry } = telemetrySpy();

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'add',
        'gmail',
      ]);

      expect(messages.join('\n')).toContain('/auth/google/connect?token=');
      expect(capture).toHaveBeenCalledWith('operation completed', {
        product_surface: 'cli',
        operation: 'accounts add',
        outcome: 'success',
        duration_ms: expect.any(Number),
        provider: 'gmail',
        reauthorize: false,
        connection_flow: 'hosted',
        connection_stage: 'oauth_prepare',
        request_timeout_class: 'default',
        connection_request_duration_ms: expect.any(Number),
        oauth_app: 'custom',
      });
      const captured = JSON.stringify(capture.mock.calls);
      expect(captured).not.toContain('private-google-client-id');
      expect(captured).not.toContain('private-google-client-secret');
      expect(captured).not.toContain('owner@example.com');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each(['gmail', 'outlook'] as const)('marks a successful local %s loopback setup complete', async (provider) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), `fluxmail-cli-${provider}-loopback-`)));
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '33'.repeat(32));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      const account = {
        id: `acct_${provider}_loopback`,
        email: `${provider}@example.com`,
        ownerMemberId: setup.member.id,
      };
      if (provider === 'gmail') oauthFlowMocks.google.mockResolvedValueOnce(account);
      else oauthFlowMocks.microsoft.mockResolvedValueOnce(account);

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'add',
        provider,
      ]);

      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({
          operation: 'accounts add',
          outcome: 'success',
          provider,
          connection_flow: 'loopback',
          connection_stage: 'complete',
          oauth_app: 'built-in',
        }),
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each(['gmail', 'outlook'] as const)('reports local %s OAuth failures during preparation', async (provider) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), `fluxmail-cli-${provider}-oauth-error-`)));
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '44'.repeat(32));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const privateFailure = 'private OAuth provider details';
    const { capture, telemetry } = telemetrySpy();

    try {
      const context = createContext();
      const setup = await setupInitialAdmin(context.db, {
        name: 'Local Owner',
        email: 'owner@example.com',
        password: 'River42!',
      });
      (context.db as unknown as { $client: { close(): void } }).$client.close();
      saveLocalInstance('local');
      saveSessionToken('local', setup.session.token);

      if (provider === 'gmail') oauthFlowMocks.google.mockRejectedValueOnce(new Error(privateFailure));
      else oauthFlowMocks.microsoft.mockRejectedValueOnce(new Error(privateFailure));

      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'add',
        provider,
      ]);

      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({
          operation: 'accounts add',
          outcome: 'error',
          connection_flow: 'loopback',
          connection_stage: 'oauth_prepare',
        }),
      );
      expect(JSON.stringify(capture.mock.calls)).not.toContain(privateFailure);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each(['gmail', 'outlook'] as const)(
    'reports local %s persistence failures at the save stage',
    async (provider) => {
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), `fluxmail-cli-${provider}-save-error-`)));
      vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '55'.repeat(32));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const privateFailure = 'private persistence details';
      const { capture, telemetry } = telemetrySpy();

      try {
        const context = createContext();
        const setup = await setupInitialAdmin(context.db, {
          name: 'Local Owner',
          email: 'owner@example.com',
          password: 'River42!',
        });
        (context.db as unknown as { $client: { close(): void } }).$client.close();
        saveLocalInstance('local');
        saveSessionToken('local', setup.session.token);

        if (provider === 'gmail') {
          vi.spyOn(AccountRegistry.prototype, 'addGmailAccount').mockImplementation(() => {
            throw new Error(privateFailure);
          });
          oauthFlowMocks.google.mockImplementationOnce(async (...args: unknown[]) => {
            const persist = args[2] as (result: AuthorizedOAuthResult) => unknown;
            return persist({ email: 'private@example.com', tokens: {}, oauthClient: {} } as AuthorizedOAuthResult);
          });
        } else {
          vi.spyOn(AccountRegistry.prototype, 'addOutlookAccount').mockImplementation(() => {
            throw new Error(privateFailure);
          });
          oauthFlowMocks.microsoft.mockImplementationOnce(async (...args: unknown[]) => {
            const persist = args[2] as (result: MicrosoftOAuthResult) => unknown;
            return persist({ email: 'private@example.com', credentials: {} } as MicrosoftOAuthResult);
          });
        }

        await createCliProgram({ telemetry }).parseAsync([
          'node',
          'fluxmail',
          '--no-update-notifier',
          'accounts',
          'add',
          provider,
        ]);

        expect(capture).toHaveBeenCalledWith(
          'operation completed',
          expect.objectContaining({
            operation: 'accounts add',
            outcome: 'error',
            connection_flow: 'loopback',
            connection_stage: 'account_persist',
          }),
        );
        expect(JSON.stringify(capture.mock.calls)).not.toContain(privateFailure);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  it('defaults IMAP and SMTP security to the standard mode for the chosen port', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-imap-security-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_IMAP_PASSWORD_FOR_TEST', 'private-imap-password');
    saveRemoteInstance('work', 'https://mail.example.com');
    saveSessionToken('work', 'fms_private_session');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const bodies: Array<{ imap: { security: string }; smtp: { security: string } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: { account: { id: 'acct_remote', email: 'owner@example.com' } } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const add = (...options: string[]) =>
      createCliProgram({ telemetry: telemetrySpy().telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'add',
        'imap',
        '--email',
        'owner@example.com',
        '--imap-host',
        'imap.example.com',
        '--smtp-host',
        'smtp.example.com',
        '--imap-password-env',
        'FLUXMAIL_IMAP_PASSWORD_FOR_TEST',
        ...options,
      ]);

    await add();
    await add('--imap-port', '143', '--smtp-port', '465');
    await add('--imap-port', '143', '--imap-security', 'tls', '--smtp-port', '465', '--smtp-security', 'starttls');

    expect(bodies.map(({ imap, smtp }) => [imap.security, smtp.security])).toEqual([
      ['tls', 'starttls'],
      ['starttls', 'tls'],
      ['tls', 'starttls'],
    ]);
  });

  it('omits reauthorize when only a remote instance can match an existing IMAP mailbox', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-remote-imap-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_IMAP_PASSWORD_FOR_TEST', 'private-imap-password');
    saveRemoteInstance('work', 'https://mail.example.com');
    saveSessionToken('work', 'fms_private_session');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const abortSignalTimeout = vi.spyOn(AbortSignal, 'timeout');
    let requestId: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL, init: RequestInit) => {
        requestId = new Headers(init.headers).get('x-request-id');
        return new Response(JSON.stringify({ data: { account: { id: 'acct_remote', email: 'owner@example.com' } } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry }).parseAsync([
      'node',
      'fluxmail',
      '--no-update-notifier',
      'accounts',
      'add',
      'imap',
      '--email',
      'owner@example.com',
      '--imap-host',
      'imap.example.com',
      '--smtp-host',
      'smtp.example.com',
      '--imap-password-env',
      'FLUXMAIL_IMAP_PASSWORD_FOR_TEST',
    ]);

    expect(capture.mock.calls).toEqual([
      [
        'operation completed',
        {
          product_surface: 'cli',
          operation: 'accounts add',
          outcome: 'success',
          duration_ms: expect.any(Number),
          provider: 'imap',
          connection_flow: 'imap_credentials',
          connection_stage: 'complete',
          request_timeout_class: 'imap_margin',
          connection_request_duration_ms: expect.any(Number),
        },
      ],
    ]);
    expect(abortSignalTimeout).toHaveBeenCalledWith(IMAP_CONNECTION_TEST_TIMEOUT_MS + 5_000);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
    const captured = JSON.stringify(capture.mock.calls);
    expect(captured).not.toContain('private-imap-password');
    expect(captured).not.toContain('owner@example.com');
    expect(captured).not.toContain(requestId!);
  });

  it('reports bounded diagnostics for a failed IMAP setup without sending private values', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-remote-imap-error-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_IMAP_PASSWORD_FOR_TEST', 'private-imap-password');
    saveRemoteInstance('work', 'https://customer-private-host.example');
    saveSessionToken('work', 'fms_private_session');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const abortSignalTimeout = vi.spyOn(AbortSignal, 'timeout');
    const privateMessage = 'private mailbox and credential details';
    let requestId: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL, init: RequestInit) => {
        requestId = new Headers(init.headers).get('x-request-id');
        return new Response(
          JSON.stringify({
            error: {
              code: 'provider_unavailable',
              message: privateMessage,
              requestId,
              diagnostics: { connectionStage: 'provider_check' },
            },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { capture, telemetry } = telemetrySpy();

    try {
      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'add',
        'imap',
        '--email',
        'private-mailbox@example.com',
        '--imap-host',
        'private-imap.example.com',
        '--smtp-host',
        'private-smtp.example.com',
        '--imap-password-env',
        'FLUXMAIL_IMAP_PASSWORD_FOR_TEST',
      ]);

      expect(abortSignalTimeout).toHaveBeenCalledWith(IMAP_CONNECTION_TEST_TIMEOUT_MS + 5_000);
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(requestId!));
      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({
          product_surface: 'cli',
          operation: 'accounts add',
          outcome: 'error',
          error_code: 'provider_unavailable',
          provider: 'imap',
          connection_flow: 'imap_credentials',
          connection_stage: 'provider_check',
          request_timeout_class: 'imap_margin',
          connection_request_duration_ms: expect.any(Number),
          http_status: 503,
          failure_kind: 'provider_error',
        }),
      );
      const captured = JSON.stringify(capture.mock.calls);
      expect(captured).not.toContain('private-mailbox@example.com');
      expect(captured).not.toContain('private-imap.example.com');
      expect(captured).not.toContain('private-smtp.example.com');
      expect(captured).not.toContain('private-imap-password');
      expect(captured).not.toContain(privateMessage);
      expect(captured).not.toContain(requestId!);
      expect(captured).not.toContain('customer-private-host.example');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('does not report a locally generated request ID when the server omits it', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-remote-imap-no-request-id-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_IMAP_PASSWORD_FOR_TEST', 'private-imap-password');
    saveRemoteInstance('work', 'https://customer-private-host.example');
    saveSessionToken('work', 'fms_private_session');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let sentRequestId: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL, init: RequestInit) => {
        sentRequestId = new Headers(init.headers).get('x-request-id');
        return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Session expired.' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { telemetry } = telemetrySpy();

    try {
      await createCliProgram({ telemetry }).parseAsync([
        'node',
        'fluxmail',
        '--no-update-notifier',
        'accounts',
        'add',
        'imap',
        '--email',
        'owner@example.com',
        '--imap-host',
        'imap.example.com',
        '--smtp-host',
        'smtp.example.com',
        '--imap-password-env',
        'FLUXMAIL_IMAP_PASSWORD_FOR_TEST',
      ]);

      expect(sentRequestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(console.error).toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(sentRequestId!);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('honors the explicitly configured timeout for remote IMAP account setup', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-remote-imap-timeout-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_IMAP_PASSWORD_FOR_TEST', 'private-imap-password');
    saveRemoteInstance('work', 'https://mail.example.com');
    saveSessionToken('work', 'fms_private_session');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const abortSignalTimeout = vi.spyOn(AbortSignal, 'timeout');
    const { capture, telemetry } = telemetrySpy();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { account: { id: 'acct_remote', email: 'owner@example.com' } } }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await createCliProgram({ telemetry }).parseAsync([
      'node',
      'fluxmail',
      '--no-update-notifier',
      '--timeout',
      '41',
      'accounts',
      'add',
      'imap',
      '--email',
      'owner@example.com',
      '--imap-host',
      'imap.example.com',
      '--smtp-host',
      'smtp.example.com',
      '--imap-password-env',
      'FLUXMAIL_IMAP_PASSWORD_FOR_TEST',
    ]);

    expect(abortSignalTimeout).toHaveBeenCalledWith(41_000);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ request_timeout_class: 'custom' }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('41000');
  });

  it('does not record the telemetry disable command', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-telemetry-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry }).parseAsync(['node', 'fluxmail', 'telemetry', 'disable']);

    expect(capture).not.toHaveBeenCalled();
  });

  it('shows an update notice after command output without changing telemetry', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-update-')));
    const events: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => events.push('command output'));
    const notify = vi.fn(() => events.push('update notice'));
    const updateNotifierFactory = vi.fn(() => ({ notify }));
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory }).parseAsync([
      'node',
      'fluxmail',
      'telemetry',
      'status',
    ]);

    expect(updateNotifierFactory).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(events).toEqual(['command output', 'update notice']);
    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'telemetry status',
      outcome: 'success',
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('update');
  });

  it.each([
    ['before the command', ['--no-update-notifier', 'telemetry', 'status']],
    ['after the command', ['telemetry', 'status', '--no-update-notifier']],
  ])('supports the update opt-out flag %s', async (_name, args) => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-update-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const updateNotifierFactory = vi.fn(() => ({ notify: vi.fn() }));
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory }).parseAsync(['node', 'fluxmail', ...args]);

    expect(updateNotifierFactory).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'telemetry status',
      outcome: 'success',
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('no-update-notifier');
  });

  it('does not create an update notifier for stdio MCP', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-update-')));
    const updateNotifierFactory = vi.fn(() => ({ notify: vi.fn() }));
    const { telemetry } = telemetrySpy();

    await expect(
      createCliProgram({ telemetry, updateNotifierFactory }).parseAsync(['node', 'fluxmail', 'stdio']),
    ).rejects.toThrow();

    expect(updateNotifierFactory).not.toHaveBeenCalled();
  });

  it('does not fail the command when an update notice cannot be displayed', async () => {
    vi.stubEnv('FLUXMAIL_DATA_DIR', mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-update-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const updateNotifierFactory = vi.fn(() => ({
      notify: vi.fn(() => {
        throw new Error('private terminal failure');
      }),
    }));
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory }).parseAsync([
      'node',
      'fluxmail',
      'telemetry',
      'status',
    ]);

    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'telemetry status',
      outcome: 'success',
      duration_ms: expect.any(Number),
    });
  });

  it('records config init without including paths or configuration values', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-cwd-')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'init',
    ]);

    const file = path.join(dataDir, 'config.toml');
    expect(readFileSync(file, 'utf8')).toContain('[server]');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'cli', operation: 'config init', outcome: 'success' }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain(dataDir);
  });

  it('shows configuration without migrating the database or generating an encryption key', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-show-'));
    const dbPath = path.join(dataDir, 'fluxmail.db');
    const db = openDb(dbPath, { dataDir, backupBeforeMigration: false });
    (db as unknown as { $client: { pragma(source: string): void; close(): void } }).$client.pragma('user_version = 1');
    (db as unknown as { $client: { close(): void } }).$client.close();
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { telemetry } = telemetrySpy();

    expect(inspectStoreCompatibility(dbPath, dataDir).storeFormat).toBe(1);
    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'show',
    ]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Database: ${dbPath}`));
    expect(inspectStoreCompatibility(dbPath, dataDir).storeFormat).toBe(1);
    expect(existsSync(path.join(dataDir, 'encryption.key'))).toBe(false);
  });

  it('dry-runs an explicit config migration without deleting the source or recording its secret', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'legacy.env');
    const privateSecret = 'private-migration-secret';
    writeFileSync(source, `GOOGLE_CLIENT_ID=client-id\nGOOGLE_CLIENT_SECRET=${privateSecret}\n`);
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'migrate',
      '--from',
      source,
      '--dry-run',
    ]);

    expect(existsSync(source)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('GOOGLE_CLIENT_SECRET'));
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateSecret);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(source);
  });

  it('does not migrate config.env during unrelated commands', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const legacyFile = path.join(dataDir, 'config.env');
    writeFileSync(legacyFile, 'FLUXMAIL_TELEMETRY=0\n', { mode: 0o600 });
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'telemetry',
      'status',
    ]);

    expect(existsSync(legacyFile)).toBe(true);
    expect(existsSync(path.join(dataDir, 'telemetry.disabled'))).toBe(false);
  });

  it('imports config.env only through the explicit migration command', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const legacyFile = path.join(dataDir, 'config.env');
    const legacyDb = path.join(dataDir, 'legacy.db');
    const privateSecret = 'manual-migration-secret';
    const licenseKey = `fluxmail_lic_${'ab'.repeat(20)}`;
    const licenseServerUrl = 'http://127.0.0.1:9898';
    writeFileSync(
      legacyFile,
      [
        `FLUXMAIL_DB_PATH=${legacyDb}`,
        `FLUXMAIL_ENCRYPTION_KEY=${'12'.repeat(32)}`,
        'FLUXMAIL_PORT=9123',
        'GOOGLE_CLIENT_ID=manual-google-id',
        `GOOGLE_CLIENT_SECRET=${privateSecret}`,
        `FLUXMAIL_LICENSE_KEY=${licenseKey}`,
        `FLUXMAIL_LICENSE_SERVER_URL=${licenseServerUrl}`,
        'FLUXMAIL_TELEMETRY=0',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '12'.repeat(32));
    vi.stubEnv('GOOGLE_CLIENT_ID', 'manual-google-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', privateSecret);
    vi.stubEnv('FLUXMAIL_LICENSE_KEY', licenseKey);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { capture, telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'migrate',
      '--from',
      legacyFile,
    ]);

    expect(existsSync(legacyFile)).toBe(true);
    expect(readFileSync(path.join(dataDir, 'config.toml'), 'utf8')).toContain(legacyDb);
    expect(readFileSync(path.join(dataDir, 'encryption.key'), 'utf8').trim()).toBe('12'.repeat(32));
    expect(existsSync(path.join(dataDir, 'telemetry.disabled'))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Imported'));

    const context = createContext();
    try {
      expect(context.config.dbPath).toBe(legacyDb);
      expect(context.config.port).toBe(9123);
      expect(context.config.google).toEqual({ clientId: 'manual-google-id', clientSecret: privateSecret });
      expect(context.config.licenseKey).toBe(licenseKey);
      expect(context.config.licenseServerUrl).toBe(licenseServerUrl);
      expect(context.configuration.store.google()).toEqual({
        clientId: 'manual-google-id',
        clientSecret: privateSecret,
      });
      expect(context.configuration.store.licenseKey()).toBe(licenseKey);
      expect(JSON.stringify(context.db.select().from(instanceSettings).all())).not.toContain(privateSecret);
      expect(JSON.stringify(context.db.select().from(instanceSettings).all())).not.toContain(licenseKey);
    } finally {
      context.licenseController.stop();
      (context.db as unknown as { $client: { close(): void } }).$client.close();
    }
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateSecret);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(licenseKey);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(legacyFile);
  });

  it('waits for another migration in the same data directory', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'legacy.env');
    const ready = path.join(dataDir, 'lock-ready');
    const release = path.join(dataDir, 'lock-release');
    const lock = path.join(dataDir, '.config-migration.lock');
    writeFileSync(
      source,
      [`FLUXMAIL_DATA_DIR=${dataDir}`, `FLUXMAIL_ENCRYPTION_KEY=${'56'.repeat(32)}`, 'FLUXMAIL_PORT=9123'].join('\n') +
        '\n',
      { mode: 0o600 },
    );
    const holderScript = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { withFileLock } from ${JSON.stringify(fileLockModuleUrl)};
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      withFileLock(process.argv[1], {
        timeoutMs: 5_000,
        staleMs: 30_000,
        description: 'test migration lock',
      }, () => {
        writeFileSync(process.argv[2], 'ready');
        while (!existsSync(process.argv[3])) Atomics.wait(waitArray, 0, 0, 5);
      });
    `;
    const migrationScript = `
      import { migrateConfigurationFile } from ${JSON.stringify(configMigrationModuleUrl)};
      migrateConfigurationFile(process.argv[1]);
    `;
    const holder = runFile(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      holderScript,
      lock,
      ready,
      release,
    ]);
    for (let attempt = 0; attempt < 500 && !existsSync(ready); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(ready)).toBe(true);

    const migration = runFile(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      migrationScript,
      source,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(path.join(dataDir, 'config.toml'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'encryption.key'))).toBe(false);

    writeFileSync(release, 'release');
    await holder;
    await migration;
    expect(readFileSync(path.join(dataDir, 'config.toml'), 'utf8')).toContain('9123');
    expect(readFileSync(path.join(dataDir, 'encryption.key'), 'utf8').trim()).toBe('56'.repeat(32));
    expect(existsSync(lock)).toBe(false);
  });

  it('uses FLUXMAIL_DATA_DIR from the migration file as the target', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const processDataDir = path.join(root, 'process-data');
    const importedDataDir = path.join(root, 'imported-data');
    const source = path.join(root, 'legacy.env');
    writeFileSync(source, `FLUXMAIL_DATA_DIR=${importedDataDir}\nFLUXMAIL_PORT=9123\n`, { mode: 0o600 });
    vi.stubEnv('FLUXMAIL_DATA_DIR', processDataDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'migrate',
      '--from',
      source,
    ]);

    expect(readFileSync(path.join(importedDataDir, 'config.toml'), 'utf8')).toContain('9123');
    expect(existsSync(path.join(processDataDir, 'config.toml'))).toBe(false);
  });

  it('requires the existing encryption key before importing instance settings', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'legacy.env');
    const oldKey = '67'.repeat(32);
    const deployment = resolveDeploymentConfig({
      env: { FLUXMAIL_DATA_DIR: dataDir, FLUXMAIL_ENCRYPTION_KEY: oldKey },
      defaultLicenseServerUrl: 'https://fluxmail.ai',
      generateEncryptionKey: false,
    });
    const db = openDb(deployment.dbPath, { dataDir });
    new InstanceConfigStore(db, deployment.encryptionKey).setMicrosoft({
      clientId: 'existing-client',
      tenantId: 'common',
    });
    (db as unknown as { $client: { close(): void } }).$client.close();
    writeFileSync(source, 'GOOGLE_CLIENT_ID=new-client\nGOOGLE_CLIENT_SECRET=new-secret\n', { mode: 0o600 });
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const { telemetry } = telemetrySpy();

    await expect(
      createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
        'node',
        'fluxmail',
        'config',
        'migrate',
        '--from',
        source,
      ]),
    ).rejects.toThrow(/no encryption key was provided/);

    expect(existsSync(path.join(dataDir, 'encryption.key'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'config.toml'))).toBe(false);
    const reopened = openDb(deployment.dbPath, { dataDir });
    try {
      const store = new InstanceConfigStore(reopened, deployment.encryptionKey);
      expect(store.microsoft()).toEqual({ clientId: 'existing-client', tenantId: 'common' });
      expect(store.google()).toBeUndefined();
    } finally {
      (reopened as unknown as { $client: { close(): void } }).$client.close();
    }
  });

  it('rejects a mismatched encryption key when the database contains encrypted credentials', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'legacy.env');
    const existingKey = '68'.repeat(32);
    const deployment = resolveDeploymentConfig({
      env: { FLUXMAIL_DATA_DIR: dataDir, FLUXMAIL_ENCRYPTION_KEY: existingKey },
      defaultLicenseServerUrl: 'https://fluxmail.ai',
      generateEncryptionKey: false,
    });
    const db = openDb(deployment.dbPath, { dataDir });
    const encryptedCredentials = encryptString(
      deployment.encryptionKey,
      JSON.stringify({ host: 'imap.example.com', password: 'existing-secret' }),
    );
    db.insert(accounts)
      .values({
        id: 'acct_existing',
        provider: 'imap',
        email: 'existing@example.com',
        createdAt: Date.now(),
      })
      .run();
    db.insert(accountCredentials)
      .values({
        accountId: 'acct_existing',
        encryptedCredentials,
        updatedAt: Date.now(),
      })
      .run();
    (db as unknown as { $client: { close(): void } }).$client.close();
    writeFileSync(
      source,
      [
        `FLUXMAIL_ENCRYPTION_KEY=${'69'.repeat(32)}`,
        'GOOGLE_CLIENT_ID=new-client',
        'GOOGLE_CLIENT_SECRET=new-secret',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const { telemetry } = telemetrySpy();

    await expect(
      createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
        'node',
        'fluxmail',
        'config',
        'migrate',
        '--from',
        source,
      ]),
    ).rejects.toThrow(/does not match the encrypted data/);

    expect(existsSync(path.join(dataDir, 'encryption.key'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'config.toml'))).toBe(false);
    const reopened = openDb(deployment.dbPath, { dataDir });
    try {
      const store = new InstanceConfigStore(reopened, deployment.encryptionKey);
      expect(reopened.select().from(accountCredentials).all()).toEqual([
        expect.objectContaining({ accountId: 'acct_existing', encryptedCredentials }),
      ]);
      expect(store.google()).toBeUndefined();
    } finally {
      (reopened as unknown as { $client: { close(): void } }).$client.close();
    }
  });

  it.each(['no', 'off'])('does not persist a false DO_NOT_TRACK value during migration: %s', async (value) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'legacy.env');
    writeFileSync(source, `DO_NOT_TRACK=${value}\n`, { mode: 0o600 });
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'migrate',
      '--from',
      source,
    ]);

    expect(existsSync(path.join(dataDir, 'telemetry.disabled'))).toBe(false);
  });

  it('validates imported deployment values before writing files, even when the process overrides them', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'invalid.env');
    writeFileSync(source, [`FLUXMAIL_ENCRYPTION_KEY=${'34'.repeat(32)}`, 'FLUXMAIL_PORT=70000'].join('\n') + '\n', {
      mode: 0o600,
    });
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_PORT', '8977');
    const { telemetry } = telemetrySpy();

    await expect(
      createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
        'node',
        'fluxmail',
        'config',
        'migrate',
        '--from',
        source,
      ]),
    ).rejects.toThrow(/integer between 1 and 65535/);

    expect(existsSync(source)).toBe(true);
    expect(existsSync(path.join(dataDir, 'config.toml'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'encryption.key'))).toBe(false);
  });

  it('imports instance settings into the database selected by the migrated deployment configuration', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'legacy.env');
    const targetDb = path.join(dataDir, 'target.db');
    const processOverrideDb = path.join(dataDir, 'process-override.db');
    writeFileSync(
      source,
      [
        `FLUXMAIL_DB_PATH=${targetDb}`,
        `FLUXMAIL_ENCRYPTION_KEY=${'45'.repeat(32)}`,
        'GOOGLE_CLIENT_ID=migrated-google-id',
        'GOOGLE_CLIENT_SECRET=migrated-google-secret',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_DB_PATH', processOverrideDb);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { telemetry } = telemetrySpy();

    await createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
      'node',
      'fluxmail',
      'config',
      'migrate',
      '--from',
      source,
    ]);

    delete process.env.FLUXMAIL_DB_PATH;
    const context = createContext();
    try {
      expect(context.config.dbPath).toBe(targetDb);
      expect(context.configuration.store.google()).toEqual({
        clientId: 'migrated-google-id',
        clientSecret: 'migrated-google-secret',
      });
    } finally {
      context.licenseController.stop();
      (context.db as unknown as { $client: { close(): void } }).$client.close();
    }
  });

  it('removes newly created configuration files when encrypted instance import cannot open the database', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-config-'));
    const source = path.join(dataDir, 'unwritable.env');
    const nonDirectory = path.join(dataDir, 'not-a-directory');
    writeFileSync(nonDirectory, 'file');
    writeFileSync(
      source,
      [
        `FLUXMAIL_DB_PATH=${path.join(nonDirectory, 'fluxmail.db')}`,
        'FLUXMAIL_PORT=9123',
        'GOOGLE_CLIENT_ID=client-id',
        'GOOGLE_CLIENT_SECRET=private-secret',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    const { telemetry } = telemetrySpy();

    await expect(
      createCliProgram({ telemetry, updateNotifierFactory: () => ({ notify: () => {} }) }).parseAsync([
        'node',
        'fluxmail',
        'config',
        'migrate',
        '--from',
        source,
      ]),
    ).rejects.toThrow();

    expect(existsSync(source)).toBe(true);
    expect(existsSync(path.join(dataDir, 'config.toml'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'encryption.key'))).toBe(false);
  });
});

describe('API key permission options', () => {
  it('preserves the named mail profile when changing only admin capabilities', () => {
    expect(
      permissionPolicyForUpdate({ allow: [], admin: ['admin.accounts'] }, { permissionProfile: 'read-only' }),
    ).toEqual(permissionPolicyForProfile('read-only', ['admin.accounts']));

    expect(
      permissionPolicyForUpdate(
        { profile: 'full', allow: [], admin: ['admin.accounts'] },
        { permissionProfile: 'read-only' },
      ),
    ).toEqual(permissionPolicyForProfile('full', ['admin.accounts']));
  });

  it('requires a complete allowlist when changing a custom policy', () => {
    expect(() =>
      permissionPolicyForUpdate({ allow: [], admin: ['admin.accounts'] }, { permissionProfile: 'custom' }),
    ).toThrow('This key uses a custom policy. Pass every capability with --allow.');

    expect(
      permissionPolicyForUpdate({ allow: ['mail.read', 'admin.accounts'], admin: [] }, { permissionProfile: 'custom' }),
    ).toEqual(customPermissionPolicy(['mail.read', 'admin.accounts']));
  });

  it('requires at least one permission option when updating a key', () => {
    expect(() => permissionPolicyForUpdate({ allow: [], admin: [] }, { permissionProfile: 'read-only' })).toThrow(
      'Choose --profile, --admin, or at least one --allow capability.',
    );
  });

  it('suggests profiles while keeping deletion explicit and preserving custom grants', () => {
    const readOnly = permissionPolicyForProfile('read-only');
    expect(permissionOptionsGranting(readOnly, ['mail.drafts', 'mail.organize', 'mail.trash'])).toBe(
      '--profile read-write',
    );
    for (const capability of ['mail.drafts', 'mail.organize', 'mail.trash'] as const) {
      expect(permissionOptionsGranting(readOnly, [capability])).toBe('--profile read-write');
    }
    expect(permissionOptionsGranting(readOnly, ['mail.send'])).toBe('--profile full');
    expect(permissionOptionsGranting(readOnly, ['mail.delete'])).toBe('--profile read-only --allow mail.delete');
    expect(permissionOptionsGranting(readOnly, ['mail.send', 'mail.delete'])).toBe(
      '--profile full --allow mail.delete',
    );
    const readWriteAdmin = permissionPolicyForProfile('read-write', ['admin.audit']);
    expect(permissionOptionsGranting(readWriteAdmin, ['mail.send'])).toBe('--profile full --admin admin.audit');
    expect(permissionOptionsGranting(FULL_PERMISSION_POLICY, ['mail.delete'])).toBe(
      '--profile full --allow mail.delete',
    );
    expect(permissionOptionsGranting(customPermissionPolicy(['mail.read', 'admin.audit']), ['mail.drafts'])).toBe(
      '--allow mail.read --allow mail.drafts --allow admin.audit',
    );
    expect(permissionOptionsGranting(customPermissionPolicy(['mail.read', 'mail.delete']), ['mail.send'])).toBe(
      '--allow mail.read --allow mail.delete --allow mail.send',
    );
    expect(enableCapabilitiesInstructions(readOnly, ['mail.send'], undefined)).toBe(
      'To enable it, change the Fluxmail permissions for this connection.',
    );
  });

  it('adds --allow capabilities to a named profile', () => {
    expect(permissionPolicyFromOptions({ profile: 'full', allow: ['mail.delete'] })).toEqual(
      customPermissionPolicy(['mail.read', 'mail.drafts', 'mail.organize', 'mail.trash', 'mail.send', 'mail.delete']),
    );
    expect(permissionPolicyFromOptions({ profile: 'read-only', allow: ['mail.send'], admin: ['admin.audit'] })).toEqual(
      customPermissionPolicy(['mail.read', 'mail.send', 'admin.audit']),
    );
    expect(
      permissionPolicyForUpdate({ profile: 'full', allow: ['mail.delete'] }, { permissionProfile: 'full' }),
    ).toEqual(customPermissionPolicy([...FULL_PERMISSION_POLICY.capabilities, 'mail.delete']));
    expect(() => permissionPolicyFromOptions({ profile: 'full', allow: ['mail.unknown'] })).toThrow(
      /Unknown capability: mail.unknown/,
    );
    expect(() => permissionPolicyFromOptions({ allow: ['mail.read'], admin: ['admin.audit'] })).toThrow(
      /--admin can only be combined with a named --profile/,
    );
  });

  it('uses read-only as the default mail profile', () => {
    expect(permissionPolicyFromOptions({ allow: [] })).toEqual(permissionPolicyForProfile('read-only'));
    expect(permissionPolicyFromOptions({ allow: [], admin: ['admin.accounts'] })).toEqual(
      permissionPolicyForProfile('read-only', ['admin.accounts']),
    );
  });
});
