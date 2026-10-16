import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueMemberAuthToken, setupInitialAdmin } from '../src/auth.js';
import { createCliProgram } from '../src/cli.js';
import { CliCanceledError, resolveInstance, saveLocalInstance, saveRemoteInstance } from '../src/cliInstances.js';
import { createContext } from '../src/context.js';

describe('CLI authentication flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it('sets up, logs out, logs back in, and switches instance profiles', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-auth-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '22'.repeat(32));
    vi.stubEnv('FLUXMAIL_PASSWORD', 'Granite harbor compass 2026!');
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createCliProgram().parseAsync([
      'node',
      'fluxmail',
      'setup',
      '--name',
      'CLI Admin',
      '--email',
      'cli@example.com',
    ]);
    const first = resolveInstance('local');
    expect(first.profile).toEqual({ kind: 'local' });
    expect(first.token).toMatch(/^fms_/);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Logged in to local'));

    await createCliProgram().parseAsync(['node', 'fluxmail', '--instance', 'local', 'logout']);
    expect(resolveInstance('local').token).toBeUndefined();
    await createCliProgram().parseAsync([
      'node',
      'fluxmail',
      '--instance',
      'local',
      'login',
      '--email',
      'cli@example.com',
    ]);
    expect(resolveInstance('local').token).toMatch(/^fms_/);

    saveRemoteInstance('work', 'https://mail.example.com');
    await createCliProgram().parseAsync(['node', 'fluxmail', 'instances', 'use', 'work']);
    expect(resolveInstance().name).toBe('work');
    await createCliProgram().parseAsync(['node', 'fluxmail', 'instances', 'use', 'local']);
    expect(resolveInstance().name).toBe('local');

    await createCliProgram().parseAsync(['node', 'fluxmail', 'instances', 'remove', 'local']);
    expect(() => resolveInstance('local')).toThrow(/No CLI instance/);
    await createCliProgram().parseAsync([
      'node',
      'fluxmail',
      '--instance',
      'local',
      'login',
      '--email',
      'cli@example.com',
    ]);
    expect(resolveInstance('local')).toMatchObject({
      profile: { kind: 'local' },
      token: expect.stringMatching(/^fms_/),
    });
  });

  it('re-prompts for an invalid interactive setup password and accepts eight characters', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-password-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '33'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const prompt = vi.fn().mockResolvedValueOnce('short7').mockResolvedValueOnce('River42!');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createCliProgram({ passwordPrompt: prompt }).parseAsync([
      'node',
      'fluxmail',
      'setup',
      '--name',
      'CLI Admin',
      '--email',
      'cli@example.com',
    ]);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Error: Password must contain between 8 and 256 characters.');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('Fluxmail is ready'));
    expect(resolveInstance('local').token).toMatch(/^fms_/);
    expect(process.exitCode).toBeUndefined();
  });

  it('re-prompts when a reset password fails member-specific validation on the server', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-reset-password-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '44'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const context = createContext();
    const setup = await setupInitialAdmin(context.db, {
      name: 'Reset Owner',
      email: 'owner@example.com',
      password: 'Granite harbor compass 2026!',
    });
    const reset = issueMemberAuthToken(context.db, {
      memberId: setup.member.id,
      kind: 'password_reset',
      createdByMemberId: setup.member.id,
    });
    saveLocalInstance('local');
    vi.stubEnv('FLUXMAIL_RESET_CODE', reset.token);
    const prompt = vi.fn().mockResolvedValueOnce('owner-2026!').mockResolvedValueOnce('River42!');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createCliProgram({ passwordPrompt: prompt }).parseAsync([
      'node',
      'fluxmail',
      '--instance',
      'local',
      'login',
      '--reset',
    ]);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Error: Choose a password that is not common or based on your member details.');
    expect(output).toHaveBeenCalledWith('Logged in to local as Reset Owner.');
    expect(resolveInstance('local').token).toMatch(/^fms_/);
    expect(process.exitCode).toBeUndefined();
  });

  it('uses the administrator details when retrying a recovery password', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-recovery-password-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '55'.repeat(32));
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    const context = createContext();
    const setup = await setupInitialAdmin(context.db, {
      name: 'Recovery Owner',
      email: 'recovery@example.com',
      password: 'Granite harbor compass 2026!',
    });
    saveLocalInstance('local');
    const prompt = vi.fn().mockResolvedValueOnce('recovery-2026!').mockResolvedValueOnce('River42!');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createCliProgram({ passwordPrompt: prompt }).parseAsync([
      'node',
      'fluxmail',
      '--instance',
      'local',
      'auth',
      'recover-admin',
      setup.member.id,
    ]);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Error: Choose a password that is not common or based on your member details.');
    expect(output).toHaveBeenCalledWith("Reset Recovery Owner's password and revoked existing sessions.");
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a canceled password prompt as canceled instead of an internal error', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-cancel-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '66'.repeat(32));
    vi.stubEnv('FLUXMAIL_RESET_CODE', 'private-reset-code');
    saveLocalInstance('local');
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const prompt = vi.fn().mockRejectedValue(new CliCanceledError());
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createCliProgram({ passwordPrompt: prompt, telemetry }).parseAsync([
      'node',
      'fluxmail',
      '--no-update-notifier',
      '--instance',
      'local',
      'login',
      '--reset',
    ]);

    expect(capture).toHaveBeenCalledWith('operation completed', {
      product_surface: 'cli',
      operation: 'login',
      outcome: 'error',
      error_code: 'canceled',
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-reset-code');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"code":"canceled"'));
    expect(process.exitCode).toBe(1);
  });
});
