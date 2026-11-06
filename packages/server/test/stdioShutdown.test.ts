import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createStdioShutdown, shutDownOnClose, type StdioShutdownOptions } from '../src/stdioShutdown.js';

const steps: string[] = [];
// Stands in for an IMAP connection that keeps the event loop alive after the client leaves.
let lingering: NodeJS.Timeout | undefined;

function options(overrides: Partial<StdioShutdownOptions> = {}): StdioShutdownOptions {
  return {
    flushTelemetry: async () => void steps.push('telemetry'),
    release: async () => {
      steps.push('release');
      return [];
    },
    report: (failures) => steps.push(`report ${failures.length}`),
    flushLogs: async () => void steps.push('logs'),
    exit: vi.fn(() => steps.push('exit')),
    deadlineMs: 1_000,
    graceMs: 10,
    ...overrides,
  };
}

afterEach(() => {
  steps.length = 0;
  clearInterval(lingering);
  vi.restoreAllMocks();
});

describe('stdio shutdown', () => {
  it('flushes telemetry, releases, then closes the logs and exits once, however often it is triggered', async () => {
    lingering = setInterval(() => {}, 1_000);
    const shutdown = createStdioShutdown(options());
    shutdown();
    shutdown();
    shutdown();
    await vi.waitFor(() => expect(steps).toContain('exit'));
    expect(steps).toEqual(['telemetry', 'release', 'logs', 'exit']);
  });

  it('still releases and exits when the telemetry flush fails, and reports failures before the logs close', async () => {
    const failure = new Error('registry close failed');
    const report = vi.fn((failures: unknown[]) => steps.push(`report ${failures.length}`));
    const shutdown = createStdioShutdown(
      options({
        flushTelemetry: async () => {
          throw new Error('logger lock');
        },
        release: async () => {
          steps.push('release');
          return [failure];
        },
        report,
      }),
    );
    shutdown();
    await vi.waitFor(() => expect(steps).toContain('exit'));
    expect(steps).toEqual(['release', 'report 1', 'logs', 'exit']);
    expect(report).toHaveBeenCalledWith([failure]);
  });

  it('reports a release that throws instead of returning failures', async () => {
    const failure = new Error('server close threw');
    const shutdown = createStdioShutdown(
      options({
        release: async () => {
          throw failure;
        },
      }),
    );
    shutdown();
    await vi.waitFor(() => expect(steps).toContain('exit'));
    expect(steps).toEqual(['telemetry', 'report 1', 'logs', 'exit']);
  });

  it('exits at the deadline when a call still running holds up the flush', async () => {
    const exit = vi.fn();
    const shutdown = createStdioShutdown(
      options({ flushTelemetry: () => new Promise(() => {}), exit, deadlineMs: 30 }),
    );
    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce(), { timeout: 1_000 });
    expect(steps).not.toContain('release');
  });

  it('exits without a code by default, so an earlier failure exit code survives', async () => {
    const processExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const shutdown = createStdioShutdown(options({ exit: undefined }));
    shutdown();
    await vi.waitFor(() => expect(processExit).toHaveBeenCalledOnce());
    expect(processExit).toHaveBeenCalledWith();
  });

  it.each([
    ['stdin ends', (stdin: PassThrough) => stdin.end()],
    ['stdin closes without ending', (stdin: PassThrough) => stdin.destroy()],
    ['stdout fails', (_stdin: PassThrough, stdout: PassThrough) => stdout.emit('error', new Error('EPIPE'))],
  ])('shuts down when %s', async (_name, disconnect) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    const serverClosed = vi.fn();
    transport.onclose = serverClosed;
    const shutdown = vi.fn();
    shutDownOnClose(transport, shutdown);
    await transport.start();

    disconnect(stdin, stdout);

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(serverClosed).toHaveBeenCalledOnce();
  });
});
