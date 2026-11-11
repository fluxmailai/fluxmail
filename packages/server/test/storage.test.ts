import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { decryptString, encryptString } from '../src/storage/crypto.js';
import {
  accounts,
  apiKeys,
  CURRENT_STORE_FORMAT,
  gmailConnectionGrants,
  IncompatibleStoreError,
  inspectStoreCompatibility,
  members,
  openDb,
} from '../src/storage/db.js';
import {
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKeyAccounts,
  updateApiKeyPermissions,
  verifyApiKey,
} from '../src/storage/apiKeys.js';
import { customPermissionPolicy, permissionPolicyForProfile } from '../src/permissions.js';
import {
  claimGmailConnectionGrant,
  claimOutlookConnectionGrant,
  createGmailConnectionGrant,
  createOutlookConnectionGrant,
  gmailConnectionTokenHash,
  GMAIL_CONNECTION_GRANT_TTL_MS,
  inspectGmailConnectionGrant,
  inspectOutlookConnectionGrant,
} from '../src/storage/gmailConnectionGrants.js';
import { addMember, removeMember, setMemberRole } from '../src/storage/members.js';
import {
  assertAccountLimit,
  assertMemberLimit,
  PERSONAL_TIER,
  type Entitlements,
} from '../src/licensing/entitlements.js';

const paidPlan: Entitlements = {
  plan: 'team',
  licensed: true,
  inGrace: false,
  maxMembers: 5,
  maxAccounts: 5,
};
const runFile = promisify(execFile);
const dbModuleUrl = new URL('../src/storage/db.ts', import.meta.url).href;

describe('crypto', () => {
  const key = randomBytes(32);

  it('round-trips', () => {
    const packed = encryptString(key, 'secret token json');
    expect(packed).not.toContain('secret');
    expect(decryptString(key, packed)).toBe('secret token json');
  });

  it('rejects tampered ciphertext', () => {
    const packed = encryptString(key, 'data');
    const buf = Buffer.from(packed, 'base64');
    buf[buf.length - 1]! ^= 0xff;
    expect(() => decryptString(key, buf.toString('base64'))).toThrow();
  });

  it('rejects the wrong key', () => {
    const packed = encryptString(key, 'data');
    expect(() => decryptString(randomBytes(32), packed)).toThrow();
  });
});

describe('api keys', () => {
  it('creates, verifies, and revokes', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', role: 'member' });
    const { key, info } = createApiKey(db, 'test', member.id);
    expect(key).toMatch(/^fmk_[0-9a-f]{64}$/);
    expect(verifyApiKey(db, key)).toBe(true);
    expect(verifyApiKey(db, 'fmk_wrong')).toBe(false);
    expect(listApiKeys(db)[0]).toMatchObject({ permissionProfile: 'full' });
    expect(revokeApiKey(db, info.id)).toBe(true);
    expect(verifyApiKey(db, key)).toBe(false);
  });

  it('allows multiple keys', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', role: 'member' });
    createApiKey(db, 'first', member.id);
    createApiKey(db, 'second', member.id);
    expect(listApiKeys(db)).toHaveLength(2);
  });

  it('issues a key to a member and revokes it when the member is removed', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', role: 'member' });
    const { key, info } = createApiKey(db, 'alice-key', member.id);
    expect(info.memberId).toBe(member.id);
    expect(listApiKeys(db)[0]?.memberId).toBe(member.id);
    expect(authenticateApiKey(db, key)?.role).toBe('member');

    removeMember(db, member.id);
    expect(listApiKeys(db)).toHaveLength(0);
    expect(verifyApiKey(db, key)).toBe(false);
  });

  it('rejects an unknown member', () => {
    const db = openDb(':memory:');
    expect(() => createApiKey(db, 'key', 'member_nope')).toThrow(/No member with id/);
  });

  it('does not create memberless system credentials', () => {
    const db = openDb(':memory:');
    expect(() => createApiKey(db, 'system')).toThrow(/member is required/i);
  });

  it('stores named and custom permission policies', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice' });
    const readOnly = createApiKey(db, 'reader', member.id, permissionPolicyForProfile('read-only'));
    const custom = createApiKey(db, 'organizer', member.id, customPermissionPolicy(['mail.read', 'mail.trash']));

    expect(authenticateApiKey(db, readOnly.key)?.permissions).toEqual(permissionPolicyForProfile('read-only'));
    expect(authenticateApiKey(db, custom.key)?.permissions).toEqual(
      customPermissionPolicy(['mail.read', 'mail.trash']),
    );
    expect(listApiKeys(db).map((key) => key.permissionProfile)).toEqual(['read-only', 'custom']);
  });

  it('stores named profile supplements and rejects admin capabilities for non-admin members', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', role: 'admin' });
    const root = createApiKey(
      db,
      'root',
      member.id,
      permissionPolicyForProfile('read-only', ['admin.accounts', 'admin.api_keys']),
    );
    expect(authenticateApiKey(db, root.key)?.permissions).toEqual(
      permissionPolicyForProfile('read-only', ['admin.accounts', 'admin.api_keys']),
    );
    expect(listApiKeys(db)[0]?.supplementalCapabilities).toEqual(['admin.accounts', 'admin.api_keys']);

    db.insert(members)
      .values({
        id: 'member_backup_admin',
        name: 'Backup Admin',
        role: 'admin',
        status: 'active',
        createdAt: Date.now(),
      })
      .run();
    setMemberRole(db, member.id, 'member');
    expect(() =>
      createApiKey(db, 'forbidden', member.id, customPermissionPolicy(['mail.read', 'admin.license'])),
    ).toThrow(/admin member/);
  });

  it('updates permissions without rotating the key', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice' });
    const { key, info } = createApiKey(db, 'test', member.id);

    expect(updateApiKeyPermissions(db, info.id, permissionPolicyForProfile('read-only'))).toBe(true);
    expect(authenticateApiKey(db, key)?.permissions).toEqual(permissionPolicyForProfile('read-only'));
    expect(updateApiKeyPermissions(db, 'key_missing', permissionPolicyForProfile('full'))).toBe(false);
  });

  it('fails authentication closed for malformed stored permissions', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice' });
    const { key, info } = createApiKey(db, 'test', member.id);
    db.update(apiKeys)
      .set({ permissionProfile: 'custom', customCapabilities: '["mail.read","unknown"]' })
      .where(eq(apiKeys.id, info.id))
      .run();

    expect(authenticateApiKey(db, key)).toBeNull();
  });

  it('stores, replaces, clears, and validates mailbox allowlists', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice' });
    db.insert(accounts)
      .values({
        id: 'acct_1',
        provider: 'gmail',
        email: 'alice@example.com',
        status: 'active',
        createdAt: Date.now(),
        ownerMemberId: member.id,
        sharedWithAll: false,
      })
      .run();
    const { key, info } = createApiKey(db, 'scoped', member.id, undefined, ['acct_1', 'acct_1']);

    expect(authenticateApiKey(db, key)?.accountIds).toEqual(['acct_1']);
    db.delete(accounts).where(eq(accounts.id, 'acct_1')).run();
    expect(authenticateApiKey(db, key)?.accountIds).toEqual(['acct_1']);
    expect(updateApiKeyAccounts(db, info.id, ['acct_deleted'])).toBe(true);
    expect(authenticateApiKey(db, key)?.accountIds).toEqual(['acct_deleted']);
    expect(updateApiKeyAccounts(db, info.id, null)).toBe(true);
    expect(authenticateApiKey(db, key)?.accountIds).toBeNull();

    db.update(apiKeys).set({ accountIds: '{bad json' }).where(eq(apiKeys.id, info.id)).run();
    expect(authenticateApiKey(db, key)).toBeNull();
  });
});

describe('Gmail connection grants', () => {
  it('stores a digest of a 256-bit token and preserves its intent', () => {
    const db = openDb(':memory:');
    const created = createGmailConnectionGrant(db, {
      ownerMemberId: 'member_1',
      reauthorizeAccountId: 'acct_1',
      sharedWithAll: false,
      grantedMemberIds: ['member_2'],
    });

    expect(Buffer.from(created.token, 'base64url')).toHaveLength(32);
    const row = db.select().from(gmailConnectionGrants).get();
    expect(row?.tokenHash).toBe(gmailConnectionTokenHash(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(inspectGmailConnectionGrant(db, created.token)).toBe('available');

    expect(claimGmailConnectionGrant(db, created.token)).toEqual({
      status: 'claimed',
      grant: {
        expiresAt: created.expiresAt,
        ownerMemberId: 'member_1',
        reauthorizeAccountId: 'acct_1',
        sharedWithAll: false,
        grantedMemberIds: ['member_2'],
      },
    });
    expect(inspectGmailConnectionGrant(db, created.token)).toBe('used');
  });

  it('rejects invalid, expired, and already-used grants', () => {
    const db = openDb(':memory:');
    expect(claimGmailConnectionGrant(db, 'missing')).toEqual({ status: 'invalid' });

    const expired = createGmailConnectionGrant(db, {}, 100);
    expect(inspectGmailConnectionGrant(db, expired.token, 100 + GMAIL_CONNECTION_GRANT_TTL_MS)).toBe('expired');
    expect(claimGmailConnectionGrant(db, expired.token, 100 + GMAIL_CONNECTION_GRANT_TTL_MS)).toEqual({
      status: 'expired',
    });

    const used = createGmailConnectionGrant(db);
    expect(claimGmailConnectionGrant(db, used.token).status).toBe('claimed');
    expect(claimGmailConnectionGrant(db, used.token)).toEqual({ status: 'used' });
  });

  it('allows only one claim when requests race', async () => {
    const db = openDb(':memory:');
    const { token } = createGmailConnectionGrant(db);
    const claims = await Promise.all([
      Promise.resolve().then(() => claimGmailConnectionGrant(db, token)),
      Promise.resolve().then(() => claimGmailConnectionGrant(db, token)),
    ]);

    expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'used')).toHaveLength(1);
  });

  it('does not accept a Gmail link on the Outlook flow or vice versa', () => {
    const db = openDb(':memory:');
    const gmail = createGmailConnectionGrant(db);
    const outlook = createOutlookConnectionGrant(db);

    expect(inspectOutlookConnectionGrant(db, gmail.token)).toBe('invalid');
    expect(inspectGmailConnectionGrant(db, outlook.token)).toBe('invalid');
    expect(claimOutlookConnectionGrant(db, outlook.token).status).toBe('claimed');
  });
});

describe('account storage', () => {
  it('prevents duplicate provider and email pairs', () => {
    const db = openDb(':memory:');
    db.insert(accounts)
      .values({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'active',
        createdAt: Date.now(),
      })
      .run();

    expect(() =>
      db
        .insert(accounts)
        .values({
          id: 'acct_2',
          provider: 'gmail',
          email: 'me@example.com',
          status: 'active',
          createdAt: Date.now(),
        })
        .run(),
    ).toThrow();
  });
});

describe('store compatibility', () => {
  it('adopts a legacy store at the current format and creates a backup', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-store-'));
    const dbPath = path.join(directory, 'fluxmail.db');
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE legacy_data (value TEXT NOT NULL); INSERT INTO legacy_data VALUES ('kept')");
    legacy.close();

    openDb(dbPath, { dataDir: directory });

    expect(inspectStoreCompatibility(dbPath, directory)).toMatchObject({
      storeFormat: CURRENT_STORE_FORMAT,
      compatible: true,
      requiresMigration: false,
    });
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.prepare('SELECT value FROM legacy_data').pluck().get()).toBe('kept');
    reopened.close();
    expect(readdirSync(path.join(directory, 'backups'))).toHaveLength(1);
  });

  it('rejects a newer store before changing it', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-store-'));
    const dbPath = path.join(directory, 'fluxmail.db');
    const newer = new Database(dbPath);
    newer.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('untouched')");
    newer.pragma(`user_version = ${CURRENT_STORE_FORMAT + 1}`);
    newer.close();

    expect(() => openDb(dbPath, { dataDir: directory })).toThrow(IncompatibleStoreError);

    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.pragma('user_version', { simple: true })).toBe(CURRENT_STORE_FORMAT + 1);
    expect(reopened.prepare('SELECT value FROM marker').pluck().get()).toBe('untouched');
    reopened.close();
    expect(readdirSync(directory)).not.toContain('backups');
  });

  it('keeps the original store and backup when a migration fails', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-store-'));
    const dbPath = path.join(directory, 'fluxmail.db');
    const malformed = new Database(dbPath);
    malformed.exec('CREATE TABLE members (id TEXT PRIMARY KEY)');
    malformed.close();

    expect(() => openDb(dbPath, { dataDir: directory })).toThrow();

    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.pragma('user_version', { simple: true })).toBe(0);
    expect(reopened.prepare('PRAGMA table_info(members)').all()).toHaveLength(1);
    reopened.close();
    expect(readdirSync(path.join(directory, 'backups'))).toHaveLength(1);
    expect(readdirSync(directory)).not.toContain('fluxmail.db.migration.lock');
  });

  it('serializes migration and backup across separate processes', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-store-'));
    const dbPath = path.join(directory, 'fluxmail.db');
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE legacy_data (value TEXT NOT NULL); INSERT INTO legacy_data VALUES ('kept')");
    legacy.close();
    const script = `
      import { openDb } from ${JSON.stringify(dbModuleUrl)};
      openDb(process.argv[1], { dataDir: process.argv[2] });
    `;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        runFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dbPath, directory]),
      ),
    );

    expect(inspectStoreCompatibility(dbPath, directory).storeFormat).toBe(CURRENT_STORE_FORMAT);
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.prepare('SELECT value FROM legacy_data').pluck().get()).toBe('kept');
    reopened.close();
    expect(readdirSync(path.join(directory, 'backups'))).toHaveLength(1);
    expect(readdirSync(directory)).not.toContain('fluxmail.db.migration.lock');
  });
});

describe('entitlements', () => {
  it('the Personal plan allows 3 mailboxes and 1 member', () => {
    expect(() => assertAccountLimit(2, PERSONAL_TIER)).not.toThrow();
    expect(() => assertAccountLimit(3, PERSONAL_TIER)).toThrow(/Personal plan allows 3 connected mailboxes/);
    expect(() => assertMemberLimit(0, PERSONAL_TIER)).not.toThrow();
    expect(() => assertMemberLimit(1, PERSONAL_TIER)).toThrow(/Personal plan allows 1 member/);
  });

  it('throws entitlement_exceeded', () => {
    try {
      assertAccountLimit(3, PERSONAL_TIER);
      expect.unreachable();
    } catch (err) {
      expect((err as EmailError).code).toBe('entitlement_exceeded');
    }
  });

  it('names the plan from the lease when a license is active', () => {
    expect(() => assertAccountLimit(5, paidPlan)).toThrow(/Your team plan allows 5 connected mailboxes/);
    expect(() => assertMemberLimit(5, paidPlan)).toThrow(/Your team plan allows 5 members/);
  });
});
