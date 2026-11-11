import { AsyncLocalStorage } from 'node:async_hooks';

/** Steps of a mail operation whose time is worth seeing on its own. */
export type TimedStep = 'imap_connect' | 'imap_list' | 'imap_select' | 'imap_search' | 'imap_fetch' | 'imap_other';

const timing = new AsyncLocalStorage<Partial<Record<TimedStep, number>>>();

/** Run one MCP or REST operation, collecting the time its steps take. */
export function withOperationTiming<T>(run: () => T): T {
  return timing.run({}, run);
}

/**
 * Add a step's time to the current operation. Overlapping steps add up, so a
 * batch call's steps can total more than its duration, and an IMAP command's
 * time includes its wait behind earlier commands on the same connection. It
 * uses the same clock as an operation's duration.
 */
export async function measureStep<T>(step: TimedStep, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    const steps = timing.getStore();
    if (steps) steps[step] = (steps[step] ?? 0) + (performance.now() - started);
  }
}

/** Where the current operation's time went, leaving out steps it didn't take. */
export function operationTimingProperties(): Partial<Record<`${TimedStep}_ms`, number>> {
  const steps = timing.getStore();
  if (!steps) return {};
  return Object.fromEntries(Object.entries(steps).map(([step, ms]) => [`${step}_ms`, Math.round(ms)]));
}
