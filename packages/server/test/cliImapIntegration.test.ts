import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ImapFlow } from 'imapflow';
import { beforeAll, describe, expect, it } from 'vitest';

const host = process.env.GREENMAIL_HOST;
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-imap-'));
const ownerEmail = 'cli-owner@example.com';

function run(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      FLUXMAIL_DATA_DIR: dataDir,
      FLUXMAIL_PASSWORD: 'Granite harbor compass 2026!',
      FLUXMAIL_TELEMETRY: '0',
      CLI_IMAP_PASSWORD: 'pwd3',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
  });
}

const imapPort = Number(process.env.GREENMAIL_IMAPS_PORT ?? 3993);
const smtpsPort = Number(process.env.GREENMAIL_SMTPS_PORT ?? 3465);

describe.skipIf(!host || !existsSync(cliPath)).sequential('IMAP CLI integration', () => {
  beforeAll(async () => {
    const setup = run(['setup', '--name', 'CLI integration owner', '--email', ownerEmail]);
    expect(setup.status, setup.stderr).toBe(0);

    const client = new ImapFlow({
      host: host!,
      port: imapPort,
      secure: true,
      auth: { user: 'cli', pass: 'pwd3' },
      logger: false,
    });
    await client.connect();
    try {
      if (!(await client.list()).some((folder) => folder.path === 'Sent')) await client.mailboxCreate('Sent');
    } finally {
      await client.logout();
    }
  });

  it('adds, lists, configures, and reauthorizes an IMAP account', () => {
    const connectionArgs = [
      '--email',
      'cli@example.com',
      '--imap-host',
      host!,
      '--imap-port',
      String(imapPort),
      '--imap-security',
      'tls',
      '--imap-user',
      'cli',
      '--imap-password-env',
      'CLI_IMAP_PASSWORD',
      '--smtp-host',
      host!,
      '--smtp-port',
      String(smtpsPort),
      '--smtp-security',
      'tls',
      '--smtp-user',
      'cli',
    ];
    const added = run(['accounts', 'add', 'imap', ...connectionArgs]);
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toMatch(/Connected cli@example.com/);
    expect(added.stdout).toMatch(/Warning: no drafts folder could be resolved/);
    const accountId = added.stdout.match(/account id: ([^)]+)/)?.[1];
    expect(accountId).toMatch(/^acct_/);

    const listed = run(['accounts', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).data).toContainEqual(
      expect.objectContaining({ id: accountId, provider: 'imap', email: 'cli@example.com', status: 'active' }),
    );

    const configured = run(['accounts', 'configure', accountId!, '--sent-folder', 'Sent']);
    expect(configured.status, configured.stderr).toBe(0);
    expect(configured.stdout).toContain(`Updated folder settings for ${accountId}.`);
    const automatic = run(['accounts', 'configure', accountId!, '--sent-folder', 'auto']);
    expect(automatic.status, automatic.stderr).toBe(0);

    const reauthorized = run(['accounts', 'add', 'imap', '--reauthorize', accountId!, ...connectionArgs]);
    expect(reauthorized.status, reauthorized.stderr).toBe(0);
    expect(reauthorized.stdout).toContain(`account id: ${accountId}`);
    const accounts = JSON.parse(run(['accounts', 'list']).stdout).data as Array<{ email: string }>;
    expect(accounts.filter((account) => account.email === 'cli@example.com')).toHaveLength(1);
  }, 30_000);

  it('rejects nonexistent folder mappings and literal password flags', () => {
    const listed = run(['accounts', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    const accounts = JSON.parse(listed.stdout).data as Array<{ id: string; provider: string; email: string }>;
    const accountId = accounts.find(
      (account) => account.provider === 'imap' && account.email === 'cli@example.com',
    )?.id;
    expect(accountId).toBeTruthy();

    const missing = run(['accounts', 'configure', accountId!, '--trash-folder', 'Does Not Exist']);
    expect(missing.status).toBe(2);
    const structuredError = missing.stderr.split('\n').find((line) => line.startsWith('{"error":'));
    expect(structuredError).toBeDefined();
    expect(JSON.parse(structuredError!)).toMatchObject({
      error: {
        code: 'invalid_request',
        message: expect.stringContaining('trash folder override "Does Not Exist" does not match a selectable mailbox'),
      },
    });

    const literal = run([
      'accounts',
      'add',
      'imap',
      '--email',
      'cli@example.com',
      '--imap-host',
      host!,
      '--smtp-host',
      host!,
      '--imap-password',
      'secret',
    ]);
    expect(literal.status).not.toBe(0);
    expect(literal.stderr).toMatch(/unknown option.*--imap-password/i);
  }, 30_000);

  it('exits after listing a full page from IMAP', () => {
    const listed = run(['emails', 'list', '--folder', 'inbox', '--page-size', '100']);

    expect(listed.error, listed.stderr).toBeUndefined();
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ data: expect.any(Array) });
  }, 30_000);
});
