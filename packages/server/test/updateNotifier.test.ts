import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings, UpdateInfo, UpdateNotifier } from 'update-notifier';
import {
  createCliUpdateNotifier,
  isNewerVersion,
  SERVER_UPDATE_CHECK_INTERVAL_MS,
  ServerUpdateCheck,
  serverUpdateChecksAllowed,
  startMcpUpdateCheck,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_GUIDE_URL,
  updateChecksAllowed,
} from '../src/updateNotifier.js';
import type { Logger } from '../src/logging.js';
import { VERSION } from '../src/version.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function notifierStub(
  update?: UpdateInfo,
  notify = vi.fn(),
  config: NonNullable<UpdateNotifier['config']> = {
    get: vi.fn(() => Date.now()),
    set: vi.fn(),
  } as unknown as NonNullable<UpdateNotifier['config']>,
): UpdateNotifier {
  return { config, update, notify } as UpdateNotifier;
}

describe('MCP update check', () => {
  const latest = (version: unknown, ok = true) =>
    vi.fn(async () => ({ ok, json: async () => ({ version }) }) as Response) as unknown as typeof fetch;

  it('reports a newer npm release', async () => {
    const check = latest('2.0.0');
    const available = startMcpUpdateCheck({ env: {}, fetch: check, currentVersion: '1.0.0' });

    await vi.waitFor(() => {
      expect(available()).toEqual({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        instructionsUrl: UPDATE_GUIDE_URL,
      });
    });
    expect(check).toHaveBeenCalledWith('https://registry.npmjs.org/fluxmail/latest', expect.anything());
  });

  it.each([
    ['the same version', latest('1.0.0')],
    ['an older version', latest('0.9.0')],
    ['an invalid response', latest(undefined)],
    ['a registry error', latest('2.0.0', false)],
    ['a network failure', vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch],
  ])('reports nothing for %s', async (_name, check) => {
    const available = startMcpUpdateCheck({ env: {}, fetch: check, currentVersion: '1.0.0' });

    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    expect(available()).toBeUndefined();
  });

  it.each([{ NO_UPDATE_NOTIFIER: '1' }, { CI: 'true' }, { NODE_ENV: 'test' }])(
    'does not contact the registry with %j',
    (env) => {
      const check = latest('2.0.0');
      expect(startMcpUpdateCheck({ env, fetch: check, currentVersion: '1.0.0' })()).toBeUndefined();
      expect(check).not.toHaveBeenCalled();
    },
  );

  it('runs without a terminal and under npx', () => {
    expect(serverUpdateChecksAllowed({ npm_config_user_agent: 'npm/11.0.0', npm_command: 'exec' })).toBe(true);
  });
});

describe('server update check', () => {
  const releases = (...versions: Array<string | Error>) => {
    const check = vi.fn();
    for (const version of versions) {
      if (version instanceof Error) check.mockRejectedValueOnce(version);
      else check.mockResolvedValueOnce({ ok: true, json: async () => ({ version }) });
    }
    return check as unknown as typeof fetch;
  };
  const start = (check: typeof fetch, env: NodeJS.ProcessEnv = {}) => {
    const warn = vi.fn();
    const updateCheck = new ServerUpdateCheck({
      env,
      fetch: check,
      currentVersion: '1.0.0',
      logger: { warn } as unknown as Logger,
    });
    return { updateCheck, warn };
  };

  it('checks at startup and every 7 days, logging each new version once', async () => {
    vi.useFakeTimers();
    const check = releases('2.0.0', '2.0.0', '3.0.0');
    const { updateCheck, warn } = start(check);

    updateCheck.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCheck.available()).toMatchObject({ latestVersion: '2.0.0' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('server.update_available', expect.stringContaining(UPDATE_GUIDE_URL));

    await vi.advanceTimersByTimeAsync(SERVER_UPDATE_CHECK_INTERVAL_MS - 1);
    expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(SERVER_UPDATE_CHECK_INTERVAL_MS);
    expect(updateCheck.available()).toMatchObject({ latestVersion: '3.0.0' });
    expect(warn).toHaveBeenCalledTimes(2);
    updateCheck.stop();
  });

  it('keeps the known update through a registry failure', async () => {
    vi.useFakeTimers();
    const { updateCheck, warn } = start(releases('2.0.0', new Error('offline')));

    updateCheck.start();
    await vi.advanceTimersByTimeAsync(SERVER_UPDATE_CHECK_INTERVAL_MS);

    expect(updateCheck.available()).toMatchObject({ latestVersion: '2.0.0' });
    expect(warn).toHaveBeenCalledOnce();
    updateCheck.stop();
  });

  it('clears the update when the registry no longer offers a newer version', async () => {
    vi.useFakeTimers();
    const { updateCheck } = start(releases('2.0.0', '1.0.0'));

    updateCheck.start();
    await vi.advanceTimersByTimeAsync(SERVER_UPDATE_CHECK_INTERVAL_MS);

    expect(updateCheck.available()).toBeUndefined();
    updateCheck.stop();
  });

  it('stops checking and ignores a response that arrives after shutdown', async () => {
    vi.useFakeTimers();
    const check = releases('2.0.0');
    const { updateCheck, warn } = start(check);

    updateCheck.start();
    updateCheck.stop();
    await vi.advanceTimersByTimeAsync(SERVER_UPDATE_CHECK_INTERVAL_MS);

    expect(check).toHaveBeenCalledOnce();
    expect(updateCheck.available()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing until started or when opted out', async () => {
    vi.useFakeTimers();
    const check = releases('2.0.0');
    new ServerUpdateCheck({ env: {}, fetch: check });
    start(check, { NO_UPDATE_NOTIFIER: '1' }).updateCheck.start();
    await vi.advanceTimersByTimeAsync(SERVER_UPDATE_CHECK_INTERVAL_MS);

    expect(check).not.toHaveBeenCalled();
  });
});

describe('CLI update notifier', () => {
  it('checks the stable npm channel once per day', () => {
    const set = vi.fn();
    const config = {
      get: vi.fn(() => Date.now()),
      set,
    } as unknown as NonNullable<UpdateNotifier['config']>;
    const factory = vi.fn((_settings: Settings) => notifierStub(undefined, vi.fn(), config));

    expect(createCliUpdateNotifier({ env: {}, stdoutIsTTY: true, notifierFactory: factory })).toBeDefined();
    expect(factory).toHaveBeenCalledWith({
      pkg: { name: 'fluxmail', version: VERSION },
      distTag: 'latest',
      updateCheckInterval: UPDATE_CHECK_INTERVAL_MS,
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('records a due check attempt before the registry request succeeds', () => {
    const previousCheck = Date.now() - UPDATE_CHECK_INTERVAL_MS - 1;
    const set = vi.fn();
    const config = {
      get: vi.fn(() => previousCheck),
      set,
    } as unknown as NonNullable<UpdateNotifier['config']>;

    expect(
      createCliUpdateNotifier({
        env: {},
        stdoutIsTTY: true,
        notifierFactory: () => notifierStub(undefined, vi.fn(), config),
      }),
    ).toBeDefined();

    expect(set).toHaveBeenCalledWith('lastUpdateCheck', expect.any(Number));
    expect(set.mock.calls[0]?.[1]).toBeGreaterThan(previousCheck);
  });

  it.each([
    ['redirected output', {}, false],
    ['the environment opt-out', { NO_UPDATE_NOTIFIER: '' }, true],
    ['tests', { NODE_ENV: 'test' }, true],
    ['CI', { CI: '1' }, true],
    ['npm scripts', { npm_lifecycle_event: 'test' }, true],
    ['npm execution', { npm_execpath: '/private/npm-cli.js' }, true],
    ['npx', { npm_command: 'exec' }, true],
    ['package manager user agents', { npm_config_user_agent: 'pnpm/11 npm/? node/v22' }, true],
  ])('does not check during %s', (_name, env, stdoutIsTTY) => {
    const factory = vi.fn((_settings: Settings) => notifierStub());

    expect(createCliUpdateNotifier({ env, stdoutIsTTY, notifierFactory: factory })).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('treats explicit false CI values as local execution', () => {
    expect(updateChecksAllowed({ CI: 'false' }, true)).toBe(true);
    expect(updateChecksAllowed({ CI: '0' }, true)).toBe(true);
  });

  it('shows a cached newer version immediately with the update guide', () => {
    const notify = vi.fn();
    const notifier = createCliUpdateNotifier({
      env: {},
      stdoutIsTTY: true,
      notifierFactory: () =>
        notifierStub({ current: '1.2.3', latest: '1.3.0', type: 'minor', name: 'fluxmail' }, notify),
    });

    notifier?.notify();

    expect(notify).toHaveBeenCalledWith({
      defer: false,
      message: expect.stringContaining(UPDATE_GUIDE_URL),
    });
  });

  it.each([
    ['equal versions', '1.2.3', '1.2.3'],
    ['an older registry version', '1.2.3', '1.2.2'],
    ['a malformed current version', 'private-version', '1.2.3'],
    ['a malformed registry version', '1.2.3', 'private-version'],
  ])('ignores %s', (_name, current, latest) => {
    const notify = vi.fn();
    const notifier = createCliUpdateNotifier({
      env: {},
      stdoutIsTTY: true,
      notifierFactory: () => notifierStub({ current, latest, type: 'latest', name: 'fluxmail' }, notify),
    });

    notifier?.notify();

    expect(notify).not.toHaveBeenCalled();
  });

  it('silences notifier construction and display failures', () => {
    expect(
      createCliUpdateNotifier({
        env: {},
        stdoutIsTTY: true,
        notifierFactory: () => {
          throw new Error('private cache path');
        },
      }),
    ).toBeUndefined();

    const notifier = createCliUpdateNotifier({
      env: {},
      stdoutIsTTY: true,
      notifierFactory: () =>
        notifierStub(
          { current: '1.0.0', latest: '2.0.0', type: 'major', name: 'fluxmail' },
          vi.fn(() => {
            throw new Error('private terminal failure');
          }),
        ),
    });
    expect(() => notifier?.notify()).not.toThrow();
  });

  it('removes the permission warning installed by update-notifier when its cache cannot open', () => {
    const warning = vi.fn();
    const factory = vi.fn((_settings: Settings) => {
      process.once('exit', warning);
      return { config: undefined } as UpdateNotifier;
    });

    expect(createCliUpdateNotifier({ env: {}, stdoutIsTTY: true, notifierFactory: factory })).toBeUndefined();
    expect(process.listeners('exit')).not.toContain(warning);
  });
});

describe('isNewerVersion', () => {
  it.each([
    ['1.2.3', '1.2.4'],
    ['1.2.3', '1.3.0'],
    ['1.2.3', '2.0.0'],
    ['2.0.0-beta.1', '2.0.0'],
    ['2.0.0-beta.1', '2.0.0-beta.2'],
    ['2.0.0-beta.2', '2.0.0-beta.10'],
  ])('recognizes %s -> %s as newer', (current, latest) => {
    expect(isNewerVersion(current, latest)).toBe(true);
  });

  it.each([
    ['1.2.3', '1.2.3+build.2'],
    ['2.0.0', '2.0.0-beta.2'],
    ['2.0.0-beta.2', '2.0.0-beta.1'],
    ['01.2.3', '1.2.4'],
    ['1.2', '1.2.3'],
  ])('does not recognize %s -> %s as newer', (current, latest) => {
    expect(isNewerVersion(current, latest)).toBe(false);
  });
});
