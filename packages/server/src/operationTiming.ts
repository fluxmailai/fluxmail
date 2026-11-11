import { AsyncLocalStorage } from 'node:async_hooks';

/** Steps of a mail operation whose time is worth seeing on its own. */
export type TimedStep = 'imap_connect' | 'imap_list' | 'imap_select' | 'imap_search' | 'imap_fetch' | 'imap_other';

interface OperationTiming {
  /** Time in steps that have finished. */
  finished: Partial<Record<TimedStep, number>>;
  /** Steps still running, such as a search that a timeout abandoned. */
  running: Set<{ step: TimedStep; started: number }>;
}

const timing = new AsyncLocalStorage<OperationTiming>();

/** Run one MCP or REST operation, collecting the time its steps take. */
export function withOperationTiming<T>(run: () => T): T {
  return timing.run({ finished: {}, running: new Set() }, run);
}

/**
 * Add a step's time to the current operation. Overlapping steps add up, so a
 * batch call's steps can total more than its duration, and an IMAP command's
 * time includes its wait behind earlier commands on the same connection. It
 * uses the same clock as an operation's duration.
 */
export async function measureStep<T>(step: TimedStep, run: () => Promise<T>): Promise<T> {
  const current = timing.getStore();
  const entry = { step, started: performance.now() };
  current?.running.add(entry);
  try {
    return await run();
  } finally {
    if (current) {
      current.running.delete(entry);
      current.finished[step] = (current.finished[step] ?? 0) + (performance.now() - entry.started);
    }
  }
}

/**
 * Where the current operation's time went, leaving out steps it didn't take.
 * A step still running, as when the operation timed out waiting for it, counts
 * up to now.
 */
export function operationTimingProperties(): Partial<Record<`${TimedStep}_ms`, number>> {
  const current = timing.getStore();
  if (!current) return {};
  const totals = { ...current.finished };
  const now = performance.now();
  for (const { step, started } of current.running) totals[step] = (totals[step] ?? 0) + (now - started);
  return Object.fromEntries(Object.entries(totals).map(([step, ms]) => [`${step}_ms`, Math.round(ms)]));
}
