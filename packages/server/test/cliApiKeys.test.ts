import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSession } from '../src/auth.js';
import { createCliProgram } from '../src/cli.js';
import { saveLocalInstance, saveSessionToken } from '../src/cliInstances.js';
import { FULL_PERMISSION_POLICY } from '../src/permissions.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { members, openDb, type FluxmailDb } from '../src/storage/db.js';
import { findMember } from '../src/storage/members.js';

describe('fluxmail apikey list', () => {
  let dataDir: string;
  let db: FluxmailDb | undefined;
  let output: ReturnType<typeof vi.spyOn<Console, 'log'>>;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-apikeys-'));
    vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
    vi.stubEnv('FLUXMAIL_ENCRYPTION_KEY', '33'.repeat(32));
    vi.stubEnv('FLUXMAIL_PASSWORD', 'Granite harbor compass 2026!');
    vi.stubEnv('FLUXMAIL_TELEMETRY', '0');
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    (db as unknown as { $client: { close(): void } } | undefined)?.$client.close();
    db = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function setup(email = 'admin@example.com') {
    await createCliProgram().parseAsync(['node', 'fluxmail', 'setup', '--name', 'Admin', '--email', email]);
  }

  /** An admin, a member named Grace, and keys Grace made, the admin made, and a now suspended admin made. */
  async function instanceWithKeys() {
    await setup();
    db = openDb(path.join(dataDir, 'fluxmail.db'));
    const admin = findMember(db, 'admin@example.com');
    for (const [id, role] of [
      ['grace', 'member'],
      ['ada', 'admin'],
    ] as const) {
      db.insert(members)
        .values({ id, name: id, email: `${id}@example.com`, role, status: 'active', createdAt: 1 })
        .run();
    }
    const keys = {
      own: createApiKey(db, 'grace-own', 'grace', FULL_PERMISSION_POLICY, null).info,
      delegated: createApiKey(db, 'made-for-grace', 'grace', FULL_PERMISSION_POLICY, null, admin.id).info,
      pinned: createApiKey(db, 'pinned', 'grace', FULL_PERMISSION_POLICY, ['acct_team'], admin.id).info,
      fromAda: createApiKey(db, 'from-ada', 'grace', FULL_PERMISSION_POLICY, null, 'ada').info,
    };
    db.update(members).set({ status: 'suspended' }).where(eq(members.id, 'ada')).run();
    saveLocalInstance('grace');
    saveSessionToken('grace', issueSession(db, 'grace', 'test').token);
    return { admin, keys };
  }

  async function list(...args: string[]): Promise<string> {
    output.mockClear();
    await createCliProgram().parseAsync(['node', 'fluxmail', ...args, 'apikey', 'list']);
    expect(process.exitCode).toBeUndefined();
    return output.mock.calls.map(([value]) => String(value)).join('\n');
  }

  const lineFor = (printed: string, id: string) =>
    printed.split('\n').find((line) => line.startsWith(`${id}  `)) ?? printed;

  it('shows who created a key and how far it reaches', async () => {
    const { admin, keys } = await instanceWithKeys();

    // The admin lists every key; Grace lists her own through the member route.
    for (const instance of [[], ['--instance', 'grace']]) {
      const printed = await list(...instance, '--format', 'table');
      expect(lineFor(printed, keys.own.id)).toContain('member=grace  accounts=all granted  profile=');
      expect(lineFor(printed, keys.delegated.id)).toContain(
        'member=grace  issuedBy=admin@example.com  accounts=all granted to both  profile=',
      );
      expect(lineFor(printed, keys.pinned.id)).toContain(
        'issuedBy=admin@example.com  accounts=acct_team if granted to both  profile=',
      );
      expect(lineFor(printed, keys.fromAda.id)).toContain(
        'issuedBy=ada@example.com (suspended, key disabled)  accounts=all granted to both',
      );
      expect(printed).not.toContain(admin.id);
    }
  });

  it('prints each key as an object in JSON output', async () => {
    const { admin, keys } = await instanceWithKeys();

    for (const instance of [[], ['--instance', 'grace']]) {
      const listed = (JSON.parse(await list(...instance)) as { data: Array<Record<string, unknown>> }).data;
      const byId = new Map(listed.map((key) => [key.id, key]));
      expect(byId.get(keys.own.id)).toMatchObject({
        issuedByMemberId: null,
        issuedByEmail: null,
        issuedByStatus: null,
      });
      expect(byId.get(keys.pinned.id)).toMatchObject({
        accountIds: ['acct_team'],
        issuedByMemberId: admin.id,
        issuedByEmail: 'admin@example.com',
        issuedByStatus: 'active',
      });
      expect(byId.get(keys.fromAda.id)).toMatchObject({ issuedByMemberId: 'ada', issuedByStatus: 'suspended' });
      // Both routes print the same timestamp format.
      expect(byId.get(keys.own.id)).toMatchObject({
        createdAt: new Date(keys.own.createdAt).toISOString(),
        lastUsedAt: null,
      });
      expect(JSON.stringify(listed)).not.toMatch(/fmk_/);
    }
  });

  it('keeps the empty-list hint out of JSON output', async () => {
    await setup();

    expect(JSON.parse(await list())).toEqual({ data: [] });
    expect(await list('--format', 'table')).toContain('No API keys.');
  });
});
