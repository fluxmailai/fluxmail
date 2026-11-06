import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { accounts, openDb } from '../src/storage/db.js';
import {
  addMember,
  findMember,
  getMember,
  listMembers,
  removeMember,
  setMemberRole,
  updateMember,
} from '../src/storage/members.js';
import { authenticateApiKey, createApiKey, listApiKeys } from '../src/storage/apiKeys.js';
import {
  assertWithinQuota,
  CAP_REDUCTION_GRACE_MS,
  checkLicenseState,
  clearLease,
  GRACE_PERIOD_MS,
  recordCapState,
  saveLeaseToken,
} from '../src/licensing/entitlements.js';
import { instanceUsageProperties } from '../src/accounts/telemetry.js';

function makeKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function signLease(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, bytes, privateKey);
  return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
}

const keys = makeKeypair();

function leaseToken(overrides: Record<string, unknown> = {}): string {
  return signLease(keys.privateKey, {
    v: 2,
    licenseId: 'd2f7c1e0-0000-4000-8000-000000000000',
    plan: 'team',
    maxMembers: 3,
    maxAccounts: 5,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
}

function insertAccount(db: ReturnType<typeof openDb>, email: string): void {
  db.insert(accounts)
    .values({ id: `acct_${email}`, provider: 'gmail', email, status: 'active', createdAt: Date.now() })
    .run();
}

describe('members', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('adds, lists, and looks up members by id or email', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', email: 'Alice@Example.com' });
    expect(member.id).toMatch(/^member_[0-9a-f]{12}$/);
    expect(member.email).toBe('alice@example.com');
    expect(member.role).toBe('admin');

    expect(getMember(db, member.id).name).toBe('Alice');
    expect(findMember(db, member.id).id).toBe(member.id);
    expect(findMember(db, 'alice@example.com').id).toBe(member.id);
    expect(listMembers(db)).toHaveLength(1);
    expect(() => findMember(db, 'nobody@example.com')).toThrow(/No member/);
  });

  it('uses explicit roles and reads role changes immediately', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', role: 'member' });
    expect(member.role).toBe('member');
    expect(setMemberRole(db, member.id, 'admin').role).toBe('admin');
    expect(getMember(db, member.id).role).toBe('admin');
  });

  it('rejects a duplicate email', () => {
    const db = openDb(':memory:');
    addMember(db, { name: 'Alice', email: 'alice@example.com' });
    expect(() => addMember(db, { name: 'Alias', email: 'alice@example.com' })).toThrow(/already exists/);
  });

  it('protects the last active administrator from demotion, suspension, and removal', () => {
    const db = openDb(':memory:');
    const admin = addMember(db, { name: 'Admin', email: 'admin@example.com', role: 'admin', status: 'active' });
    expect(() => setMemberRole(db, admin.id, 'member')).toThrow(/last active administrator/);
    expect(() => updateMember(db, admin.id, { status: 'suspended' })).toThrow(/last active administrator/);
    expect(() => removeMember(db, admin.id)).toThrow(/last active administrator/);
  });

  it('enforces the Personal-plan member limit', () => {
    const db = openDb(':memory:');
    addMember(db, { name: 'Alice' });
    try {
      addMember(db, { name: 'Bob' });
      expect.unreachable();
    } catch (err) {
      expect((err as EmailError).code).toBe('entitlement_exceeded');
      expect((err as EmailError).message).toMatch(/Personal plan allows 1 member/);
    }
  });

  it('allows members up to the licensed cap', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, leaseToken({ maxMembers: 3 }));

    addMember(db, { name: 'Alice' });
    addMember(db, { name: 'Bob' });
    addMember(db, { name: 'Carol' });
    expect(() => addMember(db, { name: 'Dave' })).toThrow(/team plan allows 3 members/);
  });

  it('blocks owner removal, then revokes keys after the mailbox is removed', () => {
    const db = openDb(':memory:');
    const member = addMember(db, { name: 'Alice', role: 'member' });
    db.insert(accounts)
      .values({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'active',
        createdAt: Date.now(),
        ownerMemberId: member.id,
      })
      .run();
    createApiKey(db, 'alice-key', member.id);

    expect(() => removeMember(db, member.id)).toThrow(/still owns 1 mailbox/);
    db.delete(accounts).run();
    const result = removeMember(db, member.id);
    expect(result).toEqual({ name: 'Alice', revokedApiKeys: 1, reassignedAccountIds: [] });
    expect(listMembers(db)).toHaveLength(0);
    // The member's key is gone, not promoted to an unscoped admin key.
    expect(listApiKeys(db)).toEqual([]);
  });
});

describe('plan quota', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is within quota on a fresh Personal instance', () => {
    const db = openDb(':memory:');
    const state = assertWithinQuota(db);
    expect(state.overQuota).toBe(false);
    expect(state.warning).toBeUndefined();
  });

  it('warns while the license is in its grace period', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, leaseToken({ expiresAt: new Date(Date.now() - 1000).toISOString() }));

    const state = assertWithinQuota(db);
    expect(state.entitlements.inGrace).toBe(true);
    expect(state.warning).toMatch(/expired .* paid limits continue until/i);
  });

  it('blocks once a lapsed license leaves the instance over quota, and clears after trimming', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    // 5 mailboxes were allowed under the team lease…
    saveLeaseToken(db, leaseToken({ maxAccounts: 5 }));
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']) insertAccount(db, email);
    expect(assertWithinQuota(db).overQuota).toBe(false);

    // …then the lease lapses past the grace period.
    const lapsed = new Date(Date.now() - GRACE_PERIOD_MS - 1000).toISOString();
    saveLeaseToken(db, leaseToken({ maxAccounts: 5, expiresAt: lapsed }));
    expect(() => assertWithinQuota(db)).toThrow(/Renew the license .* or remove mailboxes\/members/s);
    expect(checkLicenseState(db).warning).toMatch(/lapsed/);

    // Trimming usage back under the Personal caps unblocks immediately.
    const rows = db.select().from(accounts).all();
    for (const row of rows.slice(0, 2)) {
      db.delete(accounts).where(eq(accounts.id, row.id)).run();
    }
    expect(assertWithinQuota(db).overQuota).toBe(false);
  });
});

describe('API key migrations', () => {
  it('promotes only the earliest existing member during role migration', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fluxmail-role-migrate-'));
    const dbPath = path.join(dir, 'fluxmail.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO members VALUES ('member_later', 'Later', NULL, 2);
      INSERT INTO members VALUES ('member_first', 'First', NULL, 1);
    `);
    raw.close();

    expect(listMembers(openDb(dbPath)).map(({ id, role }) => ({ id, role }))).toEqual([
      { id: 'member_later', role: 'member' },
      { id: 'member_first', role: 'admin' },
    ]);
  });

  it('adds member scope and full permissions to a pre-members database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fluxmail-migrate-'));
    const dbPath = path.join(dir, 'fluxmail.db');
    const raw = new Database(dbPath);
    const legacyKey = 'fmk_legacy_system';
    const legacyHash = createHash('sha256').update(legacyKey).digest('hex');
    raw.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX accounts_provider_email_unique ON accounts(provider, email);
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      INSERT INTO accounts (id, provider, email, created_at) VALUES ('acct_1', 'gmail', 'me@example.com', 1);
      INSERT INTO api_keys (id, name, key_hash, created_at) VALUES ('key_1', 'old', '${legacyHash}', 1);
    `);
    raw.close();

    const db = openDb(dbPath);
    const account = db.select().from(accounts).all()[0];
    expect(account?.id).toBe('acct_1');
    expect(account?.ownerMemberId).toBeNull();
    expect(account?.sharedWithAll).toBe(true);
    expect(listApiKeys(db)).toEqual([]);
    expect(authenticateApiKey(db, legacyKey)).toBeNull();
    // The first member becomes the owner while migrated sharing stays global.
    const member = addMember(db, { name: 'Alice' });
    expect(db.select().from(accounts).all()[0]?.ownerMemberId).toBe(member.id);
    expect(db.select().from(accounts).all()[0]?.sharedWithAll).toBe(true);
  });

  it('preserves only account-management access for existing admin-owned keys', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fluxmail-admin-capability-migrate-'));
    const dbPath = path.join(dir, 'fluxmail.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO members VALUES ('member_admin', 'Admin', NULL, 'admin', 1);
      INSERT INTO members VALUES ('member_user', 'User', NULL, 'member', 2);
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        permission_profile TEXT NOT NULL DEFAULT 'full',
        custom_capabilities TEXT,
        account_ids TEXT
      );
      INSERT INTO api_keys VALUES ('key_admin', 'admin', 'hash-admin', 1, NULL, 'member_admin', 'full', NULL, NULL);
      INSERT INTO api_keys VALUES ('key_user', 'user', 'hash-user', 2, NULL, 'member_user', 'full', NULL, NULL);
      INSERT INTO api_keys VALUES ('key_custom', 'custom', 'hash-custom', 3, NULL, 'member_admin', 'custom', '["mail.read"]', NULL);
    `);
    raw.close();

    expect(listApiKeys(openDb(dbPath))).toEqual([]);
  });
});

describe('cap reduction grace', () => {
  afterEach(() => vi.unstubAllEnvs());

  const DAY_MS = 24 * 60 * 60 * 1000;
  const farExpiry = () => new Date(Date.now() + 60 * DAY_MS).toISOString();

  function overCapInstance(): ReturnType<typeof openDb> {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, leaseToken({ plan: 'business', maxMembers: 2, maxAccounts: 5, expiresAt: farExpiry() }));
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']) insertAccount(db, email);
    // The member limit goes down: the next lease allows 3 mailboxes.
    saveLeaseToken(db, leaseToken({ plan: 'business', maxMembers: 1, maxAccounts: 3, expiresAt: farExpiry() }));
    return db;
  }

  it('warns instead of blocking for seven days after the caps go down', () => {
    const db = overCapInstance();
    const start = new Date();
    recordCapState(db, start);

    const state = assertWithinQuota(db, start);
    expect(state.overQuota).toBe(true);
    expect(state.blocked).toBe(false);
    const deadline = new Date(start.getTime() + CAP_REDUCTION_GRACE_MS).toISOString();
    expect(state.capGraceUntil).toBe(deadline);
    expect(state.warning).toBe(
      'This instance has 5 mailboxes and 0 members, but the business plan allows 3 mailboxes and 1 member. ' +
        `To keep email tools working, remove 2 mailboxes or upgrade your plan by ${deadline}.`,
    );
  });

  it('blocks new members while only the mailbox cap is exceeded', () => {
    const db = overCapInstance();
    recordCapState(db);

    expect(() => addMember(db, { name: 'Owner' })).toThrow(/exceeds its plan limits/);
  });

  it('blocks once the seven days pass', () => {
    const db = overCapInstance();
    const start = new Date();
    recordCapState(db, start);
    const later = new Date(start.getTime() + CAP_REDUCTION_GRACE_MS);

    expect(checkLicenseState(db, later).blocked).toBe(true);
    expect(checkLicenseState(db, later).warning).toMatch(/Email tools are blocked until you remove 2 mailboxes/);
    expect(() => assertWithinQuota(db, later)).toThrow(/Upgrade the plan or remove mailboxes\/members/);
  });

  it('keeps the original deadline across later lease refreshes', () => {
    const db = overCapInstance();
    const start = new Date();
    recordCapState(db, start);
    recordCapState(db, new Date(start.getTime() + 3 * DAY_MS));

    expect(checkLicenseState(db, start).capGraceUntil).toBe(
      new Date(start.getTime() + CAP_REDUCTION_GRACE_MS).toISOString(),
    );
  });

  it('starts a new grace period after usage fits and the caps go down again', () => {
    const db = overCapInstance();
    const start = new Date();
    recordCapState(db, start);
    db.delete(accounts).where(eq(accounts.email, 'd@x.com')).run();
    db.delete(accounts).where(eq(accounts.email, 'e@x.com')).run();
    recordCapState(db, new Date(start.getTime() + DAY_MS));
    expect(checkLicenseState(db, start).overQuota).toBe(false);

    const secondDrop = new Date(start.getTime() + 20 * DAY_MS);
    saveLeaseToken(db, leaseToken({ plan: 'business', maxMembers: 1, maxAccounts: 2, expiresAt: farExpiry() }));
    recordCapState(db, secondDrop);

    const state = checkLicenseState(db, secondDrop);
    expect(state.blocked).toBe(false);
    expect(state.capGraceUntil).toBe(new Date(secondDrop.getTime() + CAP_REDUCTION_GRACE_MS).toISOString());
  });

  it('clears the deadline when removing the extra member', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, leaseToken({ plan: 'business', maxMembers: 2, maxAccounts: 5, expiresAt: farExpiry() }));
    addMember(db, { name: 'Owner' });
    const extra = addMember(db, { name: 'Extra' });
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) insertAccount(db, email);

    saveLeaseToken(db, leaseToken({ plan: 'business', maxMembers: 1, maxAccounts: 5, expiresAt: farExpiry() }));
    const firstDrop = new Date();
    recordCapState(db, firstDrop);
    removeMember(db, extra.id);
    expect(checkLicenseState(db).overQuota).toBe(false);

    saveLeaseToken(db, leaseToken({ plan: 'business', maxMembers: 1, maxAccounts: 2, expiresAt: farExpiry() }));
    const secondDrop = new Date(firstDrop.getTime() + DAY_MS);
    recordCapState(db, secondDrop);
    expect(checkLicenseState(db, secondDrop).capGraceUntil).toBe(
      new Date(secondDrop.getTime() + CAP_REDUCTION_GRACE_MS).toISOString(),
    );
  });

  it('blocks right away when the instance has not recorded the lower caps yet', () => {
    const db = overCapInstance();

    expect(checkLicenseState(db).blocked).toBe(true);
  });

  it('does not carry a grace period over to a later license', () => {
    const db = overCapInstance();
    recordCapState(db);
    clearLease(db);
    saveLeaseToken(db, leaseToken({ plan: 'business', maxMembers: 1, maxAccounts: 3, expiresAt: farExpiry() }));

    expect(checkLicenseState(db).blocked).toBe(true);
  });
});

describe('instance usage telemetry', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reports the Personal plan on a fresh instance', () => {
    expect(instanceUsageProperties(openDb(':memory:'))).toEqual({
      plan: 'personal',
      account_count: 0,
      member_count: 0,
    });
  });

  it('reports the licensed plan and totals without identifiers', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, leaseToken({ plan: 'pro' }));
    const member = addMember(db, { name: 'Alice', email: 'alice@example.com' });
    insertAccount(db, 'private-a@example.com');
    insertAccount(db, 'private-b@example.com');

    const properties = instanceUsageProperties(db);

    expect(properties).toEqual({ plan: 'pro', account_count: 2, member_count: 1 });
    const serialized = JSON.stringify(properties);
    for (const secret of ['example.com', 'acct_', member.id, 'd2f7c1e0']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('reports an unrecognized plan name as other', () => {
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', keys.publicKeyB64);
    const db = openDb(':memory:');
    saveLeaseToken(db, leaseToken({ plan: 'acme-corp-custom' }));

    expect(instanceUsageProperties(db)).toEqual({ plan: 'other', account_count: 0, member_count: 0 });
  });

  it('returns no properties when the database cannot be read', () => {
    const db = {
      select: () => {
        throw new Error('private database failure');
      },
    } as unknown as ReturnType<typeof openDb>;

    expect(instanceUsageProperties(db)).toEqual({});
  });
});
