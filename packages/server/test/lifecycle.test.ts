import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { RuntimeLifecycle } from '../src/lifecycle.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture() {
  const delivery = deferred();
  const refresh = deferred();
  const request = deferred();
  const context = {
    scheduler: { stop: vi.fn(() => delivery.promise) },
    licenseController: { stop: vi.fn(() => refresh.promise) },
    updateCheck: { stop: vi.fn() },
    registry: { close: vi.fn(async () => undefined) },
    db: { $client: { close: vi.fn() } },
  };
  const flush = vi.fn(async () => undefined);
  const terminate = vi.fn();
  const lifecycle = new RuntimeLifecycle(context as unknown as AppContext, flush, terminate);
  return { context, delivery, refresh, request, flush, terminate, lifecycle };
}

afterEach(() => vi.useRealTimers());

describe('runtime lifecycle', () => {
  it('stops accepting HTTP work and drains delivery, refresh, and disconnected requests before closing resources', async () => {
    const f = fixture();
    const order: string[] = [];
    f.context.registry.close.mockImplementation(async () => {
      order.push('providers');
    });
    f.context.db.$client.close.mockImplementation(() => {
      order.push('db');
    });
    f.flush.mockImplementation(async () => {
      order.push('flush');
    });
    let finishHttp!: () => void;
    const close = vi.fn((done: () => void) => {
      finishHttp = done;
    });
    f.lifecycle.attachServer({ close, closeIdleConnections: vi.fn() });
    const request = f.lifecycle.request(() => f.request.promise);
    const closing = f.lifecycle.close();
    expect(f.lifecycle.close()).toBe(closing);
    expect(f.lifecycle.stopping).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(f.context.scheduler.stop).toHaveBeenCalledOnce();
    expect(f.context.licenseController.stop).toHaveBeenCalledOnce();
    f.delivery.resolve();
    f.refresh.resolve();
    finishHttp();
    await Promise.resolve();
    expect(f.context.registry.close).not.toHaveBeenCalled();
    f.request.resolve();
    await request;
    await closing;
    expect(order).toEqual(['providers', 'db', 'flush']);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('drains on %s before terminating', async (signal) => {
    const f = fixture();
    process.emit(signal);
    expect(f.lifecycle.stopping).toBe(true);
    expect(f.terminate).not.toHaveBeenCalled();
    f.delivery.resolve();
    f.refresh.resolve();
    await f.lifecycle.close();
    await Promise.resolve();
    expect(f.flush).toHaveBeenCalledOnce();
    expect(f.terminate).toHaveBeenCalledWith(signal);
  });

  it.each(['second signal', 'deadline'])(
    'terminates on %s without closing resources under unfinished tasks',
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      process.emit('SIGTERM');
      if (reason === 'second signal') process.emit('SIGINT');
      else await vi.advanceTimersByTimeAsync(30_000);
      expect(f.terminate).toHaveBeenCalledOnce();
      expect(f.context.registry.close).not.toHaveBeenCalled();
      expect(f.context.db.$client.close).not.toHaveBeenCalled();
      expect(f.flush).not.toHaveBeenCalled();
      f.delivery.resolve();
      f.refresh.resolve();
      await f.lifecycle.close();
      expect(f.context.registry.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('cleans a partially started runtime without a listening HTTP server', async () => {
    const f = fixture();
    f.delivery.resolve();
    f.refresh.resolve();
    f.lifecycle.attachServer({
      close: (done) => done(Object.assign(new Error('not started'), { code: 'ERR_SERVER_NOT_RUNNING' })),
    });
    await f.lifecycle.close();
    expect(f.context.registry.close).toHaveBeenCalledOnce();
    expect(f.context.db.$client.close).toHaveBeenCalledOnce();
    expect(f.flush).toHaveBeenCalledOnce();
  });
  it('finishes cleanup and removes lifetime handles even if a provider fails to close', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.context.registry.close.mockRejectedValue(new Error('close failed'));
    f.delivery.resolve();
    f.refresh.resolve();
    await expect(f.lifecycle.close()).rejects.toThrow('close failed');
    expect(f.context.db.$client.close).toHaveBeenCalledOnce();
    expect(f.flush).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
