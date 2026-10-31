import type { AppContext } from './context.js';

interface RuntimeServer {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Owns the lifetime of a server or a foreground scheduler, including startup failures. */
export class RuntimeLifecycle {
  private server?: RuntimeServer;
  private closing?: Promise<void>;
  private readonly requests = new Set<Promise<unknown>>();
  private terminated = false;
  private deadline?: NodeJS.Timeout;
  // Scheduler and license timers are unreferenced. An empty runner must still stay alive.
  private readonly lifetime = setInterval(() => {}, 60_000);
  private readonly handlers = new Map<NodeJS.Signals, () => void>();

  constructor(
    private readonly context: AppContext,
    private readonly flush: () => Promise<void>,
    private readonly terminate: (signal: NodeJS.Signals) => void = (signal) => {
      process.kill(process.pid, signal);
    },
    private readonly deadlineMs = 30_000,
  ) {
    for (const signal of SIGNALS) {
      const handler = () => {
        if (this.closing) {
          this.force(signal);
          return;
        }
        this.deadline = setTimeout(() => this.force(signal), this.deadlineMs);
        void this.close().then(
          () => this.force(signal),
          () => this.force(signal),
        );
      };
      this.handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  get stopping(): boolean {
    return this.closing !== undefined;
  }

  attachServer(server: RuntimeServer): void {
    this.server = server;
  }

  async request<T>(handle: () => T | Promise<T>): Promise<T> {
    const task = Promise.resolve().then(handle);
    this.requests.add(task);
    try {
      return await task;
    } finally {
      this.requests.delete(task);
    }
  }

  private force(signal: NodeJS.Signals): void {
    if (this.terminated) return;
    this.terminated = true;
    this.dispose();
    this.terminate(signal);
  }

  private dispose(): void {
    if (this.deadline) clearTimeout(this.deadline);
    clearInterval(this.lifetime);
    for (const [signal, handler] of this.handlers) process.off(signal, handler);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Both stop calls disable their timers synchronously before waiting for active work.
    const scheduler = this.context.scheduler.stop();
    const refresh = this.context.licenseController.stop();
    this.context.updateCheck.stop();
    const http = new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
      this.server.closeIdleConnections?.();
    });
    this.closing = (async () => {
      // Do not close the database or providers until every task has finished, even if one fails.
      const drains = await Promise.allSettled([scheduler, refresh, http, ...this.requests]);
      if (this.terminated) return;
      const failures = drains.filter((result) => result.status === 'rejected').map((result) => result.reason);
      try {
        await this.context.registry.close();
      } catch (error) {
        failures.push(error);
      }
      if (this.terminated) return;
      try {
        (this.context.db as unknown as { $client: { close(): void } }).$client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.flush();
      } finally {
        this.dispose();
      }
      if (failures.length) throw failures[0];
    })();
    return this.closing;
  }
}
