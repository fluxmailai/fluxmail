import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import { imapCommandStep, TimedImapFlow } from '../src/accounts/timedImapFlow.js';
import { measureStep, operationTimingProperties, withOperationTiming } from '../src/operationTiming.js';

let clock = 0;

/** A step that moves the clock forward by ms. */
function takes(ms: number) {
  return async () => {
    clock += ms;
  };
}

describe('operation timing', () => {
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds up step times within an operation and leaves out steps it did not take', async () => {
    const properties = await withOperationTiming(async () => {
      await measureStep('imap_search', takes(300.4));
      await measureStep('imap_fetch', takes(1_200));
      await measureStep('imap_search', takes(200));
      return operationTimingProperties();
    });

    expect(properties).toEqual({ imap_search_ms: 500, imap_fetch_ms: 1_200 });
  });

  it('records nothing outside an operation or across operations', async () => {
    await measureStep('imap_fetch', takes(100));
    expect(operationTimingProperties()).toEqual({});

    const [first, second] = await Promise.all([
      withOperationTiming(async () => {
        await measureStep('imap_fetch', takes(100));
        return operationTimingProperties();
      }),
      withOperationTiming(async () => {
        await measureStep('imap_select', takes(50));
        return operationTimingProperties();
      }),
    ]);
    expect(Object.keys(first)).toEqual(['imap_fetch_ms']);
    expect(Object.keys(second)).toEqual(['imap_select_ms']);
  });

  it('counts a step still running when the operation gives up on it, up to that moment', async () => {
    const properties = await withOperationTiming(async () => {
      await measureStep('imap_select', takes(40));
      // A search the server never answers, abandoned at the hard deadline.
      void measureStep('imap_search', () => new Promise<never>(() => {}));
      clock += 29_960;
      return operationTimingProperties();
    });

    expect(properties).toEqual({ imap_select_ms: 40, imap_search_ms: 29_960 });
  });

  it('records a step that fails', async () => {
    const properties = await withOperationTiming(async () => {
      await expect(
        measureStep('imap_search', async () => {
          clock += 900;
          throw new Error('search failed');
        }),
      ).rejects.toThrow('search failed');
      return operationTimingProperties();
    });

    expect(properties).toEqual({ imap_search_ms: 900 });
  });

  it.each([
    ['UID FETCH', 'imap_fetch'],
    ['FETCH', 'imap_fetch'],
    ['UID SEARCH', 'imap_search'],
    ['SORT', 'imap_search'],
    ['SELECT', 'imap_select'],
    ['EXAMINE', 'imap_select'],
    ['LIST', 'imap_list'],
    ['STATUS', 'imap_list'],
    ['NOOP', 'imap_other'],
    ['UID STORE', 'imap_other'],
  ] as const)('counts %s toward %s', (command, step) => {
    expect(imapCommandStep(command)).toBe(step);
  });

  it('times IMAP commands by kind, and counts commands sent while connecting toward the connection', async () => {
    const pace: Record<string, number> = {
      CAPABILITY: 40,
      LOGIN: 60,
      SELECT: 30,
      'UID SEARCH': 500,
      'UID FETCH': 2_000,
    };
    type Execs = { exec: (command: unknown) => Promise<unknown> };
    vi.spyOn(ImapFlow.prototype as unknown as Execs, 'exec').mockImplementation(async (command) => {
      clock += pace[String(command)] ?? 0;
      return {};
    });
    vi.spyOn(ImapFlow.prototype, 'connect').mockImplementation(async function (this: ImapFlow) {
      const { exec } = this as unknown as Execs;
      await exec('CAPABILITY');
      await exec('LOGIN');
    });
    const client = new TimedImapFlow({ host: '127.0.0.1', port: 1, auth: { user: 'u', pass: 'p' }, logger: false });
    const { exec } = client as unknown as Execs;

    const properties = await withOperationTiming(async () => {
      await client.connect();
      await exec('SELECT');
      await exec('UID SEARCH');
      await exec('UID FETCH');
      // A command imapflow sends in some other shape is passed on untimed.
      await exec(Symbol('unexpected'));
      return operationTimingProperties();
    });

    expect(properties).toEqual({
      imap_connect_ms: 100,
      imap_select_ms: 30,
      imap_search_ms: 500,
      imap_fetch_ms: 2_000,
    });
  });
});
