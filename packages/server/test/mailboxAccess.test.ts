import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { FluxmailConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService } from '../src/service/emailService.js';
import { createApp } from '../src/http/app.js';
import { authenticateBearer, issueSession, setupInitialAdmin } from '../src/auth.js';
import { canAccessAccount } from '../src/authorization.js';
import { FULL_PERMISSION_POLICY, permissionPolicyForProfile } from '../src/permissions.js';
import { createApiKey, listApiKeys } from '../src/storage/apiKeys.js';
import { adminAuditEvents, members, openDb } from '../src/storage/db.js';
import { removeMember } from '../src/storage/members.js';
import type { Telemetry } from '../src/telemetry.js';

const strongPassword = 'Harbor maple quartz evening 2026!';

function fixture(telemetry?: Telemetry) {
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32, 5),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 1024,
    licenseServerUrl: 'https://license.invalid',
  };
  const db = openDb(':memory:');
  const registry = new AccountRegistry(db, config);
  const app = createApp({ config, db, registry, service: new EmailService(registry, db), telemetry });
  return { app, db, registry };
}

function insertMember(db: ReturnType<typeof openDb>, id: string, role: 'admin' | 'member' = 'member') {
  db.insert(members)
    .values({ id, name: id, email: `${id}@members.example`, role, status: 'active', createdAt: Date.now() })
    .run();
}

const imap = (email: string, password: string) => ({
  imap: { host: 'imap.example.com', port: 993, security: 'tls' as const, user: email, password },
  smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' as const, user: email, password },
  saveSent: true,
  folderOverrides: {},
});

describe('mailbox access changes', () => {
  it('records owner sharing changes without mailbox or member details', async () => {
    const capture = vi.fn();
    const { app, db, registry } = fixture({ capture, shutdown: vi.fn().mockResolvedValue(undefined) });
    const setup = await setupInitialAdmin(db, { name: 'Owner', email: 'owner@example.com', password: strongPassword });
    const privateMailbox = 'private-mailbox@example.com';
    const account = registry.addImapAccount(privateMailbox, imap(privateMailbox, 'secret'), undefined, setup.member.id);
    const headers = { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' };

    const shared = await app.request(`/api/v1/accounts/${account.id}/access`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sharedWithAll: true }),
    });
    expect(shared.status).toBe(200);
    expect(registry.getAccount(account.id).sharedWithAll).toBe(true);

    const privateGrantee = 'unknown-grantee@example.com';
    const unknown = await app.request(`/api/v1/accounts/${account.id}/access`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sharedWithAll: false, grantedMemberIds: [privateGrantee] }),
    });
    expect(unknown.status).toBe(400);
    expect(registry.getAccount(account.id)).toMatchObject({ sharedWithAll: true, grantedMemberIds: [] });

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'updateOwnAccountAccess',
        outcome: 'success',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'updateOwnAccountAccess',
        outcome: 'error',
        error_code: 'invalid_request',
      }),
    );
    const captured = JSON.stringify(capture.mock.calls);
    expect(captured).not.toContain(account.id);
    expect(captured).not.toContain(privateMailbox);
    expect(captured).not.toContain(privateGrantee);
  });

  it('keeps an admin from saving new server settings over a member’s IMAP mailbox', async () => {
    const { app, db, registry } = fixture();
    const setup = await setupInitialAdmin(db, { name: 'Admin', email: 'admin@example.com', password: strongPassword });
    insertMember(db, 'grace');
    const email = 'grace@mail.example';
    const account = registry.addImapAccount(email, imap(email, 'grace-password'), undefined, 'grace');
    const testCredentials = vi.spyOn(registry, 'testImapCredentials').mockResolvedValue([]);
    const headers = { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' };
    const relay = { host: 'relay.attacker.example', port: 587, security: 'starttls', user: email, password: 'x' };

    for (const [path, body] of [
      ['/api/v1/admin/connections', { provider: 'imap', ownerMemberId: setup.member.id }],
      ['/api/v1/accounts/connections', { provider: 'imap' }],
      ['/api/v1/accounts/connections', { provider: 'imap', reauthorizeAccountId: account.id }],
    ] as const) {
      const response = await app.request(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, email, imap: { ...relay, port: 993, security: 'tls' }, smtp: relay }),
      });
      expect(response.status, path).toBe(403);
    }
    expect(testCredentials).not.toHaveBeenCalled();
    expect(registry.loadImapCredentials(account.id).smtp.host).toBe('smtp.example.com');
  });

  it('refuses a member who connects another member’s private address without calling it missing', async () => {
    const { app, db, registry } = fixture();
    await setupInitialAdmin(db, { name: 'Admin', email: 'admin@example.com', password: strongPassword });
    insertMember(db, 'grace');
    insertMember(db, 'linus');
    const email = 'grace@mail.example';
    const account = registry.addImapAccount(email, imap(email, 'grace-password'), undefined, 'grace');
    const testCredentials = vi.spyOn(registry, 'testImapCredentials').mockResolvedValue([]);
    const headers = {
      authorization: `Bearer ${issueSession(db, 'linus', 'test').token}`,
      'content-type': 'application/json',
    };
    const server = { host: 'imap.linus.example', port: 993, security: 'tls', user: email, password: 'x' };
    const connect = (body: Record<string, unknown>) =>
      app.request('/api/v1/accounts/connections', {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider: 'imap', email, imap: server, smtp: { ...server, port: 587 }, ...body }),
      });

    // Linus typed the address, so he hears that it belongs to someone else.
    const byAddress = await connect({});
    expect(byAddress.status).toBe(403);
    expect(await byAddress.json()).toMatchObject({
      error: { code: 'permission_denied', message: expect.stringContaining('Only the mailbox owner') },
    });
    // An ID he can't see stays hidden.
    const byId = await connect({ reauthorizeAccountId: account.id });
    expect(byId.status).toBe(404);
    expect(testCredentials).not.toHaveBeenCalled();
    expect(registry.loadImapCredentials(account.id).imap.host).toBe('imap.example.com');
  });

  it('limits a key an admin creates to mailboxes both members can read', async () => {
    const { app, db, registry } = fixture();
    const setup = await setupInitialAdmin(db, { name: 'Admin', email: 'admin@example.com', password: strongPassword });
    insertMember(db, 'grace');
    const graceBox = registry.addImapAccount('grace@mail.example', imap('grace@mail.example', 'p'), undefined, 'grace');
    const teamBox = registry.addImapAccount('team@mail.example', imap('team@mail.example', 'p'), undefined, 'grace');
    registry.setAccountAccess(teamBox.id, { sharedWithAll: true, grantedMemberIds: [] });
    const headers = { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' };

    const refused = await app.request('/api/v1/admin/api-keys', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'grace', member: 'grace', permissionProfile: 'read-only', accounts: [graceBox.id] }),
    });
    expect(refused.status).toBe(403);

    const created = await app.request('/api/v1/admin/api-keys', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'grace', member: 'grace', permissionProfile: 'read-only' }),
    });
    expect(created.status).toBe(201);
    const key = ((await created.json()) as { data: { key: string; issuedByMemberId: string } }).data;
    expect(key.issuedByMemberId).toBe(setup.member.id);

    // This instance is over the Personal plan, so check reach directly rather than through mail routes.
    const principal = authenticateBearer(db, key.key)!;
    expect(canAccessAccount(principal, registry.getAccount(teamBox.id))).toBe(true);
    expect(canAccessAccount(principal, registry.getAccount(graceBox.id))).toBe(false);
    expect(authenticateBearer(db, key.key)).toMatchObject({ kind: 'api_key', issuerId: setup.member.id });
  });

  it('keeps a key created for another admin from acting as that admin', async () => {
    const { app, db, registry } = fixture();
    await setupInitialAdmin(db, { name: 'Ada', email: 'ada@example.com', password: strongPassword });
    const ada = db.select().from(members).all()[0]!.id;
    insertMember(db, 'alan', 'admin');
    const alanBox = registry.addImapAccount('alan@mail.example', imap('alan@mail.example', 'p'), undefined, 'alan');
    const delegated = createApiKey(
      db,
      'for-alan',
      'alan',
      permissionPolicyForProfile('read-only', ['admin.api_keys', 'admin.accounts']),
      null,
      ada,
    );
    const headers = { authorization: `Bearer ${delegated.key}`, 'content-type': 'application/json' };

    // A new key for Alan made through it keeps Ada as its creator.
    const minted = await app.request('/api/v1/admin/api-keys', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'alan-self', member: 'alan', permissionProfile: 'read-only' }),
    });
    expect(minted.status).toBe(201);
    const mintedKey = ((await minted.json()) as { data: { key: string; issuedByMemberId: string } }).data;
    expect(mintedKey.issuedByMemberId).toBe(ada);
    expect(canAccessAccount(authenticateBearer(db, mintedKey.key)!, registry.getAccount(alanBox.id))).toBe(false);
    const scoped = await app.request('/api/v1/admin/api-keys', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'alan-box',
        member: 'alan',
        permissionProfile: 'read-only',
        accounts: [alanBox.id],
      }),
    });
    expect(scoped.status).toBe(403);

    // It can't share Alan's mailbox or change its server settings.
    const shared = await app.request(`/api/v1/admin/accounts/${alanBox.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ grantedMemberIds: [ada] }),
    });
    expect(shared.status).toBe(403);
    vi.spyOn(registry, 'testImapCredentials').mockResolvedValue([]);
    const relay = { host: 'relay.attacker.example', port: 587, security: 'starttls', user: 'alan', password: 'x' };
    const reconnected = await app.request('/api/v1/admin/connections', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'imap',
        reauthorizeAccountId: alanBox.id,
        email: 'alan@mail.example',
        imap: { ...relay, port: 993, security: 'tls' },
        smtp: relay,
      }),
    });
    expect(reconnected.status).toBe(403);
    expect(registry.getAccount(alanBox.id).grantedMemberIds).toEqual([]);
    expect(registry.loadImapCredentials(alanBox.id).smtp.host).toBe('smtp.example.com');
  });

  it('revokes keys an admin created for others when that admin is removed', () => {
    const { db } = fixture();
    insertMember(db, 'ada', 'admin');
    insertMember(db, 'alan', 'admin');
    insertMember(db, 'grace');
    createApiKey(db, 'issued', 'grace', FULL_PERMISSION_POLICY, null, 'ada');
    createApiKey(db, 'own', 'grace', FULL_PERMISSION_POLICY);

    expect(removeMember(db, 'ada')).toMatchObject({ revokedApiKeys: 1 });
    expect(listApiKeys(db).map((key) => key.name)).toEqual(['own']);
  });

  it('hands a removed member’s mailboxes to the member named in the same change', async () => {
    const { app, db, registry } = fixture();
    const setup = await setupInitialAdmin(db, { name: 'Admin', email: 'admin@example.com', password: strongPassword });
    insertMember(db, 'sam');
    insertMember(db, 'pat');
    const box = registry.addImapAccount('sam@mail.example', imap('sam@mail.example', 'p'), undefined, 'sam');
    const headers = { authorization: `Bearer ${setup.session.token}` };

    const blocked = await app.request('/api/v1/admin/members/sam', { method: 'DELETE', headers });
    expect(blocked.status).toBe(400);

    const removed = await app.request('/api/v1/admin/members/sam?reassignTo=pat', { method: 'DELETE', headers });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      data: { removed: 'sam', reassignedAccounts: 1, newOwnerMemberId: 'pat' },
    });
    expect(registry.getAccount(box.id).ownerMemberId).toBe('pat');
    expect(
      db
        .select()
        .from(adminAuditEvents)
        .all()
        .filter((event) => event.operation === 'account.owner.reassign')
        .map((event) => [event.resourceId, event.actorMemberId]),
    ).toEqual([[box.id, setup.member.id]]);
  });

  it('adds the key issuer column when a format 7 store opens', () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-issuer-migration-')), 'fluxmail.db');
    const first = openDb(dbPath);
    insertMember(first, 'ada', 'admin');
    insertMember(first, 'grace');
    createApiKey(first, 'existing', 'grace', FULL_PERMISSION_POLICY);
    const client = (first as unknown as { $client: Database.Database }).$client;
    // Rebuild api_keys as format 7 left it.
    client.pragma('foreign_keys = OFF');
    client.exec(`
      CREATE TABLE api_keys_v7 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        permission_profile TEXT NOT NULL DEFAULT 'full',
        custom_capabilities TEXT,
        supplemental_capabilities TEXT NOT NULL DEFAULT '[]',
        account_ids TEXT
      );
      INSERT INTO api_keys_v7 SELECT id, name, key_hash, created_at, last_used_at, member_id, permission_profile,
        custom_capabilities, supplemental_capabilities, account_ids FROM api_keys;
      DROP TABLE api_keys;
      ALTER TABLE api_keys_v7 RENAME TO api_keys;
    `);
    client.pragma('user_version = 7');
    client.close();

    const reopened = openDb(dbPath);
    const reopenedClient = (reopened as unknown as { $client: Database.Database }).$client;
    expect(reopenedClient.pragma('user_version', { simple: true })).toBe(8);
    createApiKey(reopened, 'issued', 'grace', FULL_PERMISSION_POLICY, null, 'ada');
    expect(listApiKeys(reopened).map((key) => [key.name, key.issuedByMemberId])).toEqual([
      ['existing', null],
      ['issued', 'ada'],
    ]);
    reopenedClient.close();
  });
});
