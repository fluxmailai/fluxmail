/** How long a stdio session may take to shut down before the process exits anyway. */
const STDIO_SHUTDOWN_DEADLINE_MS = 10_000;
/** How long the process waits after releasing everything before it exits anyway. */
const STDIO_EXIT_GRACE_MS = 1_000;

export interface StdioShutdownOptions {
  /** Flushes telemetry. It waits for tool calls and resource reads that are still running. */
  flushTelemetry: () => Promise<void>;
  /** Closes the MCP server, provider connections and database, and returns any failures. */
  release: () => Promise<unknown[]>;
  /** Records release failures. Called before the logs close. */
  report: (failures: unknown[]) => void;
  flushLogs: () => Promise<void>;
  /** Defaults to process.exit() with no code, which keeps an exit code set earlier. */
  exit?: () => void;
  deadlineMs?: number;
  graceMs?: number;
}

/**
 * Returns a function that shuts a stdio session down once, however often the client's disconnect is reported.
 * An IMAP account keeps its connection open after a read, so the session releases what it holds rather than
 * waiting for the event loop to drain, and the process exits once nothing is left to serve.
 */
export function createStdioShutdown(options: StdioShutdownOptions): () => void {
  let started = false;
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    (options.exit ?? (() => process.exit()))();
  };
  const run = async (): Promise<void> => {
    try {
      await options.flushTelemetry();
    } catch {
      // Analytics failures must not stop the release.
    }
    try {
      const failures = await options.release();
      if (failures.length) options.report(failures);
    } catch (error) {
      options.report([error]);
    }
    try {
      await options.flushLogs();
    } catch {
      // Nothing is left to record the failure in.
    }
  };
  return () => {
    if (started) return;
    started = true;
    // Armed before any step runs, so a call stuck on a half-open connection can't keep the process alive.
    setTimeout(exit, options.deadlineMs ?? STDIO_SHUTDOWN_DEADLINE_MS).unref();
    // The MCP SDK starts request handlers in microtasks after consuming input. Wait one turn so the final
    // request can register as active before the flush waits for it.
    setImmediate(() => {
      void run().finally(() => setTimeout(exit, options.graceMs ?? STDIO_EXIT_GRACE_MS).unref());
    });
  };
}

/**
 * Starts `shutdown` when the transport closes, which it does when stdin ends or closes or when stdout fails,
 * so every way a client can go away is covered. Call it after serveStdio, which sets onclose synchronously.
 */
export function shutDownOnClose(transport: { onclose?: () => void }, shutdown: () => void): void {
  const close = transport.onclose;
  transport.onclose = () => {
    close?.();
    shutdown();
  };
}
