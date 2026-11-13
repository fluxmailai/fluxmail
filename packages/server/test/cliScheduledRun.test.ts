import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli.js';
import { saveLocalInstance, saveRemoteInstance, useInstance } from '../src/cliInstances.js';
import * as contextModule from '../src/context.js';
import { RuntimeLifecycle } from '../src/lifecycle.js';
import { LicenseController } from '../src/licensing/refresher.js';
import { SendScheduler } from '../src/scheduler/sendScheduler.js';
import * as logging from '../src/logging.js';

let directory: string;
const runtimes: RuntimeLifecycle[] = [];

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-runner-'));
  vi.stubEnv('FLUXMAIL_DATA_DIR', directory);
  vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(SendScheduler.prototype, 'start').mockImplementation(() => {});
  vi.spyOn(LicenseController.prototype, 'start').mockImplementation(() => {});
  const close = RuntimeLifecycle.prototype.close;
  vi.spyOn(RuntimeLifecycle.prototype, 'close').mockImplementation(function (this: RuntimeLifecycle) {
    if (!runtimes.includes(this)) runtimes.push(this);
    return close.call(this);
  });
});

afterEach(async () => {
  // Successful runner starts can be reached through the signal handlers with a harmless termination stub.
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  process.emit('SIGTERM');
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  kill.mockRestore();
  await logging.shutdownLogging();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function invocation(args: string[]) {
  const capture = vi.fn();
  const telemetry = { capture, shutdown: vi.fn(async () => undefined) };
  const program = createCliProgram({ telemetry });
  return { capture, run: () => program.parseAsync(['node', 'fluxmail', '--no-update-notifier', ...args]) };
}

function expectTelemetry(capture: ReturnType<typeof vi.fn>, outcome: 'success' | 'error', errorCode?: string) {
  expect(capture.mock.calls).toEqual([
    [
      'operation completed',
      {
        product_surface: 'cli',
        operation: 'scheduled run',
        outcome,
        duration_ms: expect.any(Number),
        ...(errorCode ? { error_code: errorCode } : {}),
      },
    ],
  ]);
  const properties = JSON.stringify(capture.mock.calls);
  for (const privateInput of [
    directory,
    'private-instance',
    'private-mailbox@example.com',
    'private.example.com',
    'private-secret',
  ]) {
    expect(properties).not.toContain(privateInput);
  }
}

describe('scheduled run startup', () => {
  it.each(['unconfigured', 'remote active', 'explicit local'])(
    'starts without a login session with %s profiles',
    async (mode) => {
      const args: string[] = [];
      if (mode === 'remote active') {
        saveRemoteInstance('private-instance', 'https://private.example.com');
        useInstance('private-instance');
      } else if (mode === 'explicit local') {
        saveLocalInstance('private-instance');
        args.push('--instance', 'private-instance');
      }
      const flush = vi.spyOn(logging, 'shutdownLogging');
      const f = invocation([...args, 'scheduled', 'run']);
      await f.run();
      expectTelemetry(f.capture, 'success');
      expect(SendScheduler.prototype.start).toHaveBeenCalledOnce();
      expect(LicenseController.prototype.start).toHaveBeenCalledOnce();
      expect(flush).not.toHaveBeenCalled();
    },
  );

  it.each(['remote', 'missing', 'mail account'])(
    'rejects %s selection with private input absent from telemetry',
    async (mode) => {
      const create = vi.spyOn(contextModule, 'createContext');
      saveRemoteInstance('private-instance', 'https://private.example.com');
      const args =
        mode === 'mail account'
          ? ['--mail-account', 'private-mailbox@example.com']
          : ['--instance', mode === 'remote' ? 'private-instance' : 'private-secret'];
      const f = invocation([...args, 'scheduled', 'run']);
      await expect(f.run()).rejects.toMatchObject({ code: mode === 'missing' ? 'not_found' : 'invalid_request' });
      expectTelemetry(f.capture, 'error', mode === 'missing' ? 'not_found' : 'invalid_request');
      expect(create).not.toHaveBeenCalled();
      expect(SendScheduler.prototype.start).not.toHaveBeenCalled();
    },
  );

  it('cleans partial runner startup and records one safe error', async () => {
    vi.mocked(LicenseController.prototype.start).mockImplementation(() => {
      throw new Error('private-secret startup failure');
    });
    const create = vi.spyOn(contextModule, 'createContext');
    const f = invocation(['scheduled', 'run']);
    await expect(f.run()).rejects.toThrow('private-secret');
    expectTelemetry(f.capture, 'error', 'internal');
    expect(SendScheduler.prototype.start).not.toHaveBeenCalled();
    const ctx = create.mock.results[0]!.value as contextModule.AppContext;
    expect((ctx.db as unknown as { $client: { open: boolean } }).$client.open).toBe(false);
  });

  it('failed HTTP binding starts no delivery and closes initialized resources', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    vi.stubEnv('FLUXMAIL_PORT', String(address.port));
    const create = vi.spyOn(contextModule, 'createContext');
    const f = invocation(['serve']);
    try {
      await expect(f.run()).rejects.toMatchObject({ code: 'invalid_request' });
      expect(SendScheduler.prototype.start).not.toHaveBeenCalled();
      expect(LicenseController.prototype.start).not.toHaveBeenCalled();
      const ctx = create.mock.results[0]!.value as contextModule.AppContext;
      expect((ctx.db as unknown as { $client: { open: boolean } }).$client.open).toBe(false);
      expect(f.capture.mock.calls).toEqual([
        [
          'operation completed',
          {
            product_surface: 'cli',
            operation: 'serve',
            outcome: 'error',
            error_code: 'invalid_request',
            duration_ms: expect.any(Number),
          },
        ],
      ]);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
