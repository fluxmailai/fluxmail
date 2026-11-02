import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export interface FileLockOptions {
  timeoutMs: number;
  staleMs: number;
  description: string;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const HEARTBEAT_START_TIMEOUT_MS = 5_000;
const HEARTBEAT_STOP_TIMEOUT_MS = 5_000;
const HEARTBEAT_RUNNING = 1;
const HEARTBEAT_STOP_REQUESTED = 2;
const HEARTBEAT_STOPPED = 3;
const HEARTBEAT_WORKER_SOURCE = `
  const { readFileSync, utimesSync } = require('node:fs');
  const { workerData } = require('node:worker_threads');
  const state = new Int32Array(workerData.state);
  Atomics.store(state, 0, ${HEARTBEAT_RUNNING});
  Atomics.notify(state, 0);
  while (Atomics.load(state, 0) === ${HEARTBEAT_RUNNING}) {
    Atomics.wait(state, 0, ${HEARTBEAT_RUNNING}, workerData.intervalMs);
    if (Atomics.load(state, 0) !== ${HEARTBEAT_RUNNING}) break;
    try {
      const owner = JSON.parse(readFileSync(workerData.lockPath, 'utf8'));
      if (owner.token !== workerData.token) break;
      const now = new Date();
      utimesSync(workerData.lockPath, now, now);
    } catch {
      break;
    }
  }
  Atomics.store(state, 0, ${HEARTBEAT_STOPPED});
  Atomics.notify(state, 0);
`;

interface LockHeartbeat {
  state: Int32Array;
  worker: Worker;
}

function startLockHeartbeat(lockPath: string, token: string, staleMs: number): LockHeartbeat {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: {
      lockPath,
      token,
      state: state.buffer,
      intervalMs: Math.max(25, Math.floor(staleMs / 3)),
    },
  });
  worker.unref();
  const started = Atomics.wait(state, 0, 0, HEARTBEAT_START_TIMEOUT_MS);
  if (started === 'timed-out' || Atomics.load(state, 0) !== HEARTBEAT_RUNNING) {
    void worker.terminate();
    throw new Error(`Could not start the heartbeat for ${lockPath}`);
  }
  return { state, worker };
}

function stopLockHeartbeat(heartbeat: LockHeartbeat): void {
  if (Atomics.compareExchange(heartbeat.state, 0, HEARTBEAT_RUNNING, HEARTBEAT_STOP_REQUESTED) === HEARTBEAT_RUNNING) {
    Atomics.notify(heartbeat.state, 0);
    Atomics.wait(heartbeat.state, 0, HEARTBEAT_STOP_REQUESTED, HEARTBEAT_STOP_TIMEOUT_MS);
  }
  void heartbeat.worker.terminate();
}

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockOwner>;
    if (
      typeof value.token !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.hostname !== 'string' ||
      typeof value.createdAt !== 'number'
    ) {
      return undefined;
    }
    return value as LockOwner;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function canRemoveAbandonedLock(lockPath: string, staleMs: number): boolean {
  const owner = readOwner(lockPath);
  if (owner?.hostname === hostname()) return !processIsRunning(owner.pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function releaseOwnedLock(lockPath: string, token: string): void {
  if (readOwner(lockPath)?.token === token) rmSync(lockPath, { force: true });
}

function tryRemoveAbandonedLock(lockPath: string, staleMs: number): boolean {
  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimToken = randomBytes(16).toString('hex');
  const reclaimOwner: LockOwner = {
    token: reclaimToken,
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  };
  let descriptor: number | undefined;

  try {
    descriptor = openSync(reclaimPath, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(reclaimOwner), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      rmSync(reclaimPath, { force: true });
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }

  try {
    if (!canRemoveAbandonedLock(lockPath, staleMs)) return false;
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    releaseOwnedLock(reclaimPath, reclaimToken);
  }
}

function acquireFileLock(lockPath: string, options: FileLockOptions): () => void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner: LockOwner = {
    token: randomBytes(16).toString('hex'),
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  };
  const startedAt = Date.now();

  while (true) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(owner), 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        rmSync(lockPath, { force: true });
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (tryRemoveAbandonedLock(lockPath, options.staleMs)) continue;
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new Error(`Timed out waiting for ${options.description}`);
      }
      Atomics.wait(WAIT_ARRAY, 0, 0, 25);
    }
  }

  let heartbeat: LockHeartbeat | undefined;
  try {
    heartbeat = startLockHeartbeat(lockPath, owner.token, options.staleMs);
  } catch (error) {
    releaseOwnedLock(lockPath, owner.token);
    throw error;
  }
  return () => {
    stopLockHeartbeat(heartbeat);
    releaseOwnedLock(lockPath, owner.token);
  };
}

export function withFileLock<T>(lockPath: string, options: FileLockOptions, callback: () => T): T {
  const release = acquireFileLock(lockPath, options);
  try {
    return callback();
  } finally {
    release();
  }
}

/** Waiting for the lock blocks the event loop, as in {@link withFileLock}; only the callback is asynchronous. */
export async function withAsyncFileLock<T>(
  lockPath: string,
  options: FileLockOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const release = acquireFileLock(lockPath, options);
  try {
    return await callback();
  } finally {
    release();
  }
}
