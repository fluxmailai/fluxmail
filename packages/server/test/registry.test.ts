import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import { ImapProvider } from '@fluxmail/provider-imap';
import { AccountRegistry } from '../src/accounts/registry.js';
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_GOOGLE_CLIENT_SECRET } from '../src/accounts/defaultGoogleOAuth.js';
import { DEFAULT_MICROSOFT_CLIENT_ID } from '../src/accounts/defaultMicrosoftOAuth.js';
import { accountCredentials, accounts, members, oauthTokens, openDb } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';
import {
  CAP_REDUCTION_GRACE_MS,
  checkLicenseState,
  recordCapState,
  saveLeaseToken,
} from '../src/licensing/entitlements.js';
import { decryptString, encryptString } from '../src/storage/crypto.js';
import type { FluxmailConfig } from '../src/config.js';

function testConfig(): FluxmailConfig {
  return {
    dataDir: '/tmp',
    dbPath: ':memory:',
    encryptionKey: randomBytes(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
    google: { clientId: 'id', clientSecret: 'secret' },
    microsoft: { clientId: 'microsoft-id', tenantId: 'common' },
  };
}

const tokens = { refresh_token: 'rt_secret', access_token: 'at', expiry_date: 123 };
const microsoftCredentials = {
  accessToken: 'ms_access_secret',
  refreshToken: 'ms_refresh_secret',
  expiresAt: Date.now() + 3_600_000,
};
const imapCredentials = {
  imap: { host: 'imap.example.com', port: 993, security: 'tls' as const, user: 'me', password: 'imap_secret' },
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls' as const,
    user: 'me',
    password: 'smtp_secret',
  },
  saveSent: true,
};

function businessLease(privateKey: KeyObject, maxAccounts: number, maxMembers: number): string {
  const payload = {
    v: 2,
    licenseId: 'd2f7c1e0-0000-4000-8000-000000000000',
    plan: 'business',
    maxAccounts,
    maxMembers,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  return `${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`;
}

describe('AccountRegistry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('adds an account and stores tokens encrypted', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });

    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    expect(account.provider).toBe('gmail');
    expect(account.status).toBe('active');

    const row = db.select().from(accountCredentials).get();
    expect(row?.encryptedCredentials).not.toContain('rt_secret');
    expect(JSON.parse(decryptString(config.encryptionKey, row!.encryptedCredentials))).toMatchObject({
      refresh_token: 'rt_secret',
      fluxmailOAuthClient: { clientId: 'id', clientSecret: 'secret' },
    });
    expect(row?.revision).toBe(1);
    expect(db.select().from(oauthTokens).get()).toMatchObject({
      encryptedTokens: row?.encryptedCredentials,
      updatedAt: row?.updatedAt,
    });
  });

  it('keeps each Gmail account on the OAuth client that issued its refresh token', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const owner = addMember(db, { name: 'Owner' });
    const account = new AccountRegistry(db, config).addGmailAccount('me@example.com', tokens, undefined, owner.id);

    const changedConfig = {
      ...config,
      google: { clientId: 'replacement-id', clientSecret: 'replacement-secret' },
    };
    const provider = new AccountRegistry(db, changedConfig).getProvider(account.id) as unknown as {
      auth: { _clientId?: string; _clientSecret?: string };
    };

    expect(provider.auth).toMatchObject({ _clientId: 'id', _clientSecret: 'secret' });
  });

  it('leaves legacy Gmail credentials unchanged and uses the configured custom client', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const encryptedLegacyTokens = encryptString(config.encryptionKey, JSON.stringify(tokens));
    db.update(accountCredentials)
      .set({ encryptedCredentials: encryptedLegacyTokens })
      .where(eq(accountCredentials.accountId, account.id))
      .run();
    db.update(oauthTokens)
      .set({ encryptedTokens: encryptedLegacyTokens })
      .where(eq(oauthTokens.accountId, account.id))
      .run();

    const provider = new AccountRegistry(db, config).getProvider(account.id) as unknown as {
      auth: { _clientId?: string; _clientSecret?: string };
    };

    expect(provider.auth).toMatchObject({ _clientId: 'id', _clientSecret: 'secret' });
    expect(db.select().from(accountCredentials).get()).toMatchObject({
      encryptedCredentials: encryptedLegacyTokens,
    });
    expect(db.select().from(oauthTokens).get()).toMatchObject({
      encryptedTokens: encryptedLegacyTokens,
    });
  });

  it('rejects legacy Gmail credentials when only the built-in client is configured', () => {
    const config = {
      ...testConfig(),
      google: { clientId: DEFAULT_GOOGLE_CLIENT_ID, clientSecret: DEFAULT_GOOGLE_CLIENT_SECRET },
    };
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const encryptedLegacyTokens = encryptString(config.encryptionKey, JSON.stringify(tokens));
    db.update(accountCredentials)
      .set({ encryptedCredentials: encryptedLegacyTokens })
      .where(eq(accountCredentials.accountId, account.id))
      .run();
    db.update(oauthTokens)
      .set({ encryptedTokens: encryptedLegacyTokens })
      .where(eq(oauthTokens.accountId, account.id))
      .run();

    expect(() => new AccountRegistry(db, config).getProvider(account.id)).toThrow(
      /Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.*or reconnect the account/,
    );
    expect(db.select().from(accountCredentials).get()).toMatchObject({
      encryptedCredentials: encryptedLegacyTokens,
    });
    expect(db.select().from(oauthTokens).get()).toMatchObject({
      encryptedTokens: encryptedLegacyTokens,
    });
  });

  it('enforces the Personal-plan mailbox limit', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    registry.addGmailAccount('one@example.com', tokens, undefined, owner.id);
    registry.addGmailAccount('two@example.com', tokens, undefined, owner.id);
    registry.addGmailAccount('three@example.com', tokens, undefined, owner.id);
    try {
      registry.addGmailAccount('four@example.com', tokens, undefined, owner.id);
      expect.unreachable();
    } catch (err) {
      expect((err as EmailError).code).toBe('entitlement_exceeded');
      expect((err as EmailError).message).toMatch(/Personal plan allows 3 connected mailboxes/);
    }
  });

  it('blocks new mailboxes while only the member cap is exceeded', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    saveLeaseToken(db, businessLease(privateKey, 3, 2));
    const owner = addMember(db, { name: 'Owner' });
    addMember(db, { name: 'Second member' });
    saveLeaseToken(db, businessLease(privateKey, 3, 1));
    recordCapState(db);

    expect(() => registry.assertCanAddAccount()).toThrow(/exceeds its plan limits/);
    expect(() => registry.addGmailAccount('new@example.com', tokens, undefined, owner.id)).toThrow(
      /exceeds its plan limits/,
    );
  });

  it('clears the deadline when removing the extra mailbox', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    vi.stubEnv('FLUXMAIL_LICENSE_PUBLIC_KEYS', publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    saveLeaseToken(db, businessLease(privateKey, 2, 2));
    const owner = addMember(db, { name: 'Owner' });
    registry.addGmailAccount('one@example.com', tokens, undefined, owner.id);
    const extra = registry.addGmailAccount('two@example.com', tokens, undefined, owner.id);
    saveLeaseToken(db, businessLease(privateKey, 1, 2));
    const firstDrop = new Date();
    recordCapState(db, firstDrop);
    expect(() => addMember(db, { name: 'Second member' })).toThrow(/exceeds its plan limits/);

    registry.removeAccount(extra.id);
    expect(checkLicenseState(db).overQuota).toBe(false);
    addMember(db, { name: 'Second member' });

    saveLeaseToken(db, businessLease(privateKey, 1, 1));
    const secondDrop = new Date(firstDrop.getTime() + 24 * 60 * 60 * 1000);
    recordCapState(db, secondDrop);
    expect(checkLicenseState(db, secondDrop).capGraceUntil).toBe(
      new Date(secondDrop.getTime() + CAP_REDUCTION_GRACE_MS).toISOString(),
    );
  });

  it('adds an IMAP account with encrypted credentials and IMAP capabilities', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('me@example.com', imapCredentials, undefined, owner.id);

    expect(account).toMatchObject({
      provider: 'imap',
      capabilities: { labels: false, serverThreads: false, serverSearch: 'basic', snippets: false },
    });
    const row = db.select().from(accountCredentials).get();
    expect(row?.encryptedCredentials).not.toContain('imap_secret');
    expect(JSON.parse(decryptString(config.encryptionKey, row!.encryptedCredentials))).toEqual(imapCredentials);
  });

  it('closes every cached provider during shutdown', async () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('me@example.com', imapCredentials, undefined, owner.id);
    registry.getProvider(account.id);
    const close = vi.spyOn(ImapProvider.prototype, 'close').mockResolvedValue();

    await registry.close();
    await registry.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it('adds an Outlook account with encrypted Graph credentials and Outlook capabilities', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });

    const account = registry.addOutlookAccount('me@example.com', microsoftCredentials, 'Example User', owner.id);

    expect(account).toMatchObject({
      provider: 'outlook',
      displayName: 'Example User',
      capabilities: { labels: true, serverThreads: true, serverSearch: 'rich', snippets: true },
    });
    const row = db.select().from(accountCredentials).get();
    expect(row?.encryptedCredentials).not.toContain('ms_refresh_secret');
    expect(JSON.parse(decryptString(config.encryptionKey, row!.encryptedCredentials))).toEqual(microsoftCredentials);
    expect(db.select().from(oauthTokens).get()?.encryptedTokens).toBe(row?.encryptedCredentials);
  });

  it('asks for the custom Entra app when an unpinned Outlook account meets the built-in app', () => {
    const config = { ...testConfig(), microsoft: { clientId: DEFAULT_MICROSOFT_CLIENT_ID, tenantId: 'common' } };
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addOutlookAccount('me@example.com', microsoftCredentials, undefined, owner.id);

    expect(() => registry.getProvider(account.id)).toThrow(
      expect.objectContaining({
        code: 'auth_expired',
        message: expect.stringMatching(/custom Microsoft Entra app\. Set MICROSOFT_CLIENT_ID/),
      }),
    );
  });

  it('reauthorizes an Outlook account without changing its id or owner', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const first = registry.addOutlookAccount('me@example.com', microsoftCredentials, undefined, owner.id);

    const second = registry.addOutlookAccount(
      'ME@example.com',
      { ...microsoftCredentials, refreshToken: 'rotated-refresh' },
      'Updated Name',
      undefined,
      first.id,
    );

    expect(second).toMatchObject({ id: first.id, ownerMemberId: owner.id, displayName: 'Updated Name' });
    expect(registry.listAccounts()).toHaveLength(1);
  });

  it('refreshes and persists expired Outlook credentials', async () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addOutlookAccount(
      'me@example.com',
      { ...microsoftCredentials, expiresAt: 0 },
      undefined,
      owner.id,
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) {
        return new Response(
          JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 'user-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await registry.getProvider(account.id).testConnection();

    const stored = JSON.parse(
      decryptString(config.encryptionKey, db.select().from(accountCredentials).get()!.encryptedCredentials),
    );
    expect(stored).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
  });

  it('does not let a stale token refresh overwrite newer credentials', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-refresh-race-'));
    const config = {
      ...testConfig(),
      dataDir,
      dbPath: path.join(dataDir, 'fluxmail.db'),
    };
    const firstDb = openDb(config.dbPath);
    const firstRegistry = new AccountRegistry(firstDb, config);
    const owner = addMember(firstDb, { name: 'Owner' });
    const account = firstRegistry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const secondDb = openDb(config.dbPath);
    const secondRegistry = new AccountRegistry(secondDb, config);
    const firstProvider = firstRegistry.getProvider(account.id) as unknown as {
      auth: { emit(event: string, credentials: object): void };
    };
    const secondProvider = secondRegistry.getProvider(account.id) as unknown as {
      auth: { emit(event: string, credentials: object): void };
    };

    firstProvider.auth.emit('tokens', { access_token: 'fresh-access-1', refresh_token: 'fresh-refresh-1' });
    secondProvider.auth.emit('tokens', { access_token: 'fresh-access-2', refresh_token: 'fresh-refresh-2' });

    const row = firstDb.select().from(accountCredentials).get()!;
    expect(row.revision).toBe(2);
    expect(JSON.parse(decryptString(config.encryptionKey, row.encryptedCredentials))).toMatchObject({
      access_token: 'fresh-access-1',
      refresh_token: 'fresh-refresh-1',
      fluxmailOAuthClient: { clientId: 'id', clientSecret: 'secret' },
    });
  });

  it('rolls back refreshed credentials when the legacy token mirror cannot be updated', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const provider = registry.getProvider(account.id) as unknown as {
      auth: { emit(event: string, credentials: object): void };
    };
    const before = db.select().from(accountCredentials).get()!;
    const sqlite = (db as unknown as { $client: { exec(sql: string): void } }).$client;
    sqlite.exec(`
      CREATE TRIGGER reject_legacy_token_update
      BEFORE UPDATE ON oauth_tokens
      BEGIN
        SELECT RAISE(ABORT, 'legacy token write failed');
      END;
    `);

    expect(() =>
      provider.auth.emit('tokens', {
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
      }),
    ).toThrow(/legacy token write failed/);

    expect(db.select().from(accountCredentials).get()).toEqual(before);
    expect(db.select().from(oauthTokens).get()).toMatchObject({
      encryptedTokens: before.encryptedCredentials,
      updatedAt: before.updatedAt,
    });
  });

  it('updates IMAP folder configuration and evicts the cached provider', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('me@example.com', imapCredentials, undefined, owner.id);
    const firstProvider = registry.getProvider(account.id);
    const updated = { ...imapCredentials, folderOverrides: { sent: 'Sent Items', drafts: 'Drafts' } };

    registry.saveImapCredentials(account.id, updated);

    expect(registry.loadImapCredentials(account.id)).toEqual(updated);
    expect(registry.getProvider(account.id)).not.toBe(firstProvider);
  });

  it('validates IMAP folder overrides without testing SMTP', async () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    const warnings = [
      { role: 'sent' as const, reason: 'stale_override' as const, message: 'sent override does not exist' },
    ];
    const folderCheck = vi.spyOn(ImapProvider.prototype, 'getFolderWarnings').mockResolvedValue(warnings);
    const fullCheck = vi.spyOn(ImapProvider.prototype, 'testConnection').mockRejectedValue(new Error('SMTP offline'));
    const close = vi.spyOn(ImapProvider.prototype, 'close').mockResolvedValue();

    await expect(registry.testImapFolderOverrides('me@example.com', imapCredentials)).resolves.toEqual(warnings);
    expect(folderCheck).toHaveBeenCalledOnce();
    expect(fullCheck).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('reauthorizes an IMAP account without changing its id or owner', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice' });
    const first = registry.addImapAccount('me@example.com', imapCredentials, 'Old Name', member.id);
    const updated = {
      ...imapCredentials,
      imap: { ...imapCredentials.imap, password: 'new_imap_secret' },
    };

    const second = registry.addImapAccount('me@example.com', updated, 'New Name', undefined, first.id);

    expect(second).toMatchObject({ id: first.id, ownerMemberId: member.id, displayName: 'New Name' });
    expect(registry.loadImapCredentials(first.id)).toEqual(updated);
  });

  it('rejects reauthorization for a different IMAP mailbox', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('me@example.com', imapCredentials, undefined, owner.id);
    expect(() =>
      registry.addImapAccount('other@example.com', imapCredentials, undefined, owner.id, account.id),
    ).toThrow(/does not match IMAP mailbox/);
  });

  it('migrates legacy Gmail OAuth rows into generic credentials', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-credentials-'));
    const dbPath = path.join(dataDir, 'fluxmail.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE oauth_tokens (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        encrypted_tokens TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES ('acct_legacy', 'gmail', 'legacy@example.com', 'active', 1);
      INSERT INTO oauth_tokens VALUES ('acct_legacy', 'encrypted-value', 2);
    `);
    sqlite.close();

    const db = openDb(dbPath);
    expect(db.select().from(accountCredentials).get()).toMatchObject({
      accountId: 'acct_legacy',
      encryptedCredentials: 'encrypted-value',
      updatedAt: 2,
    });
  });

  it('keeps Gmail and cascades cleanup for legacy cross-provider duplicates', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-deduplicate-'));
    const dbPath = path.join(dataDir, 'fluxmail.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE account_credentials (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        encrypted_credentials TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES ('acct_imap', 'imap', 'Me@example.com', NULL, 'active', 1);
      INSERT INTO accounts VALUES ('acct_gmail', 'gmail', 'me@example.com', NULL, 'active', 2);
      INSERT INTO account_credentials VALUES ('acct_imap', 'imap-secret', 1);
      INSERT INTO account_credentials VALUES ('acct_gmail', 'gmail-secret', 2);
    `);
    sqlite.close();

    const db = openDb(dbPath);
    const owner = addMember(db, { name: 'Owner' });
    expect(new AccountRegistry(db, testConfig()).listAccounts().map((account) => account.id)).toEqual(['acct_gmail']);
    expect(
      db
        .select()
        .from(accountCredentials)
        .all()
        .map((row) => row.accountId),
    ).toEqual(['acct_gmail']);
    expect(() =>
      db
        .insert(accounts)
        .values({
          id: 'acct_duplicate',
          provider: 'imap',
          email: 'ME@EXAMPLE.COM',
          status: 'active',
          createdAt: 3,
          ownerMemberId: owner.id,
          sharedWithAll: true,
        })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('detects the mailbox limit before starting an OAuth flow', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    registry.addGmailAccount('one@example.com', tokens, undefined, owner.id);
    registry.addGmailAccount('two@example.com', tokens, undefined, owner.id);
    registry.addGmailAccount('three@example.com', tokens, undefined, owner.id);

    expect(() => registry.assertCanAddAccount()).toThrow(
      /Personal plan allows 3 connected mailboxes.*--reauthorize <account-id>/,
    );
  });

  it('stores and reports the owning member of a mailbox', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice', email: 'alice@example.com' });

    const account = registry.addGmailAccount('one@example.com', tokens, undefined, member.id);
    expect(account.ownerMemberId).toBe(member.id);
    expect(account.sharedWithAll).toBe(false);
    expect(account.grantedMemberIds).toEqual([]);
    expect(registry.listAccounts()[0]?.ownerMemberId).toBe(member.id);
  });

  it('replaces private, global, and selected mailbox access', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    db.insert(members)
      .values({ id: 'member_guest', name: 'Guest', email: null, role: 'member', createdAt: Date.now() + 1 })
      .run();
    const account = registry.addGmailAccount('one@example.com', tokens, undefined, owner.id);

    expect(registry.setAccountAccess(account.id, { sharedWithAll: true }).sharedWithAll).toBe(true);
    expect(
      registry.setAccountAccess(account.id, { sharedWithAll: false, grantedMemberIds: ['member_guest'] }),
    ).toMatchObject({ sharedWithAll: false, grantedMemberIds: ['member_guest'] });
    expect(registry.setAccountAccess(account.id, { sharedWithAll: false })).toMatchObject({
      sharedWithAll: false,
      grantedMemberIds: [],
    });
  });

  it('treats mailbox addresses as case-insensitive across providers', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const first = registry.addGmailAccount('Me@Example.com', tokens, undefined, owner.id);
    expect(registry.addGmailAccount('me@example.com', tokens, undefined, owner.id).id).toBe(first.id);
    expect(() => registry.addImapAccount('ME@example.com', imapCredentials, undefined, owner.id)).toThrow(
      /already connected through gmail/,
    );
    expect(registry.findAccount('mE@EXAMPLE.com').id).toBe(first.id);
  });

  it('rejects an unknown member when adding a mailbox', () => {
    const registry = new AccountRegistry(openDb(':memory:'), testConfig());
    expect(() => registry.addGmailAccount('one@example.com', tokens, undefined, 'member_nope')).toThrow(
      /No member with id/,
    );
  });

  it('requires an owner during creation and reassignment', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice' });
    expect(() => registry.addGmailAccount('one@example.com', tokens)).toThrow(/owner is required/i);
    const account = registry.addGmailAccount('one@example.com', tokens, undefined, member.id);

    expect(registry.assignAccountOwner(account.id, member.id).ownerMemberId).toBe(member.id);
    expect(() => registry.assignAccountOwner(account.id, '')).toThrow(/No member with id/i);
  });

  it('re-authenticating keeps the existing owner', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const member = addMember(db, { name: 'Alice' });
    const first = registry.addGmailAccount('me@example.com', tokens, undefined, member.id);

    const second = registry.addGmailAccount('me@example.com', { ...tokens, refresh_token: 'rt_new' });
    expect(second.id).toBe(first.id);
    expect(second.ownerMemberId).toBe(member.id);
  });

  it('rolls back the account when storing its tokens fails', () => {
    const db = openDb(':memory:');
    const sqlite = (db as unknown as { $client: { exec(sql: string): void } }).$client;
    sqlite.exec(`
      CREATE TRIGGER reject_account_credentials
      BEFORE INSERT ON account_credentials
      BEGIN
        SELECT RAISE(ABORT, 'token write failed');
      END;
    `);
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });

    expect(() => registry.addGmailAccount('me@example.com', tokens, undefined, owner.id)).toThrow(/token write failed/);
    expect(registry.listAccounts()).toEqual([]);
  });

  it('re-adding the same address re-authenticates instead of erroring', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const first = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const second = registry.addGmailAccount('me@example.com', { ...tokens, refresh_token: 'rt_new' });
    expect(second.id).toBe(first.id);
    expect(registry.listAccounts()).toHaveLength(1);
  });

  it('reloads a cached provider when another process updates its tokens', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-registry-'));
    const config = {
      ...testConfig(),
      dataDir,
      dbPath: path.join(dataDir, 'fluxmail.db'),
    };
    const firstDb = openDb(config.dbPath);
    const firstRegistry = new AccountRegistry(firstDb, config);
    const owner = addMember(firstDb, { name: 'Owner' });
    const account = firstRegistry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const cachedProvider = firstRegistry.getProvider(account.id);

    const secondRegistry = new AccountRegistry(openDb(config.dbPath), config);
    secondRegistry.addGmailAccount('me@example.com', { ...tokens, refresh_token: 'rt_new' });

    expect(firstRegistry.getProvider(account.id)).not.toBe(cachedProvider);
  });

  it('reloads credentials written without changing the revision', () => {
    const config = testConfig();
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const cachedProvider = registry.getProvider(account.id);
    const current = JSON.parse(
      decryptString(config.encryptionKey, db.select().from(accountCredentials).get()!.encryptedCredentials),
    );
    const legacyCredentials = encryptString(
      config.encryptionKey,
      JSON.stringify({ ...current, refresh_token: 'legacy-refresh' }),
    );

    db.update(accountCredentials).set({ encryptedCredentials: legacyCredentials, updatedAt: Date.now() }).run();

    expect(registry.getProvider(account.id)).not.toBe(cachedProvider);
  });

  it('imports a newer credential written only to the legacy token table', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-legacy-token-'));
    const config = { ...testConfig(), dataDir, dbPath: path.join(dataDir, 'fluxmail.db') };
    const db = openDb(config.dbPath);
    const registry = new AccountRegistry(db, config);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    const before = db.select().from(accountCredentials).get()!;
    const legacyCredentials = encryptString(
      config.encryptionKey,
      JSON.stringify({ ...tokens, refresh_token: 'legacy-only-refresh' }),
    );
    db.update(oauthTokens)
      .set({ encryptedTokens: legacyCredentials, updatedAt: before.updatedAt + 1 })
      .where(eq(oauthTokens.accountId, account.id))
      .run();

    const reopened = openDb(config.dbPath);
    const imported = reopened.select().from(accountCredentials).get()!;

    expect(imported.revision).toBe(before.revision + 1);
    expect(JSON.parse(decryptString(config.encryptionKey, imported.encryptedCredentials))).toMatchObject({
      refresh_token: 'legacy-only-refresh',
    });
  });

  it('resolveAccountId defaults to the sole account and errors when ambiguous or empty', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    expect(() => registry.resolveAccountId()).toThrow(/No email accounts/);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    expect(registry.resolveAccountId()).toBe(account.id);
    expect(registry.resolveAccountId(account.id)).toBe(account.id);
    expect(() => registry.resolveAccountId('acct_nope')).toThrow(EmailError);
  });

  it('removeAccount deletes the account', () => {
    const db = openDb(':memory:');
    const registry = new AccountRegistry(db, testConfig());
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addGmailAccount('me@example.com', tokens, undefined, owner.id);
    registry.removeAccount(account.id);
    expect(registry.listAccounts()).toHaveLength(0);
  });
});
