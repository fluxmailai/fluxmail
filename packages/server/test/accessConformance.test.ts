import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ACCESS_ACTION_TYPES,
  ACCESS_CONFORMANCE_CASES,
  type AccessAction,
  type AccessConformanceCase,
  type AccessWorld,
  type MailboxAccess,
} from '@fluxmail/core/access';
import type { FluxmailConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService } from '../src/service/emailService.js';
import { createApp } from '../src/http/app.js';
import { issueSession } from '../src/auth.js';
import { ACCESS_DENIAL_ERROR_CODES } from '../src/authorization.js';
import { FULL_PERMISSION_POLICY } from '../src/permissions.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { instanceSettings, members, openDb } from '../src/storage/db.js';
import { saveLeaseToken } from '../src/licensing/entitlements.js';

const licenseKeys = generateKeyPairSync('ed25519');

/** A Business lease, so plan limits stay out of the way of the access rules. */
function businessLease(): string {
  const bytes = Buffer.from(
    JSON.stringify({
      v: 2,
      licenseId: 'd2f7c1e0-0000-4000-8000-000000000001',
      plan: 'business',
      maxMembers: 20,
      maxAccounts: 100,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  );
  return `${bytes.toString('base64url')}.${sign(null, bytes, licenseKeys.privateKey).toString('base64url')}`;
}

const STATUS_FOR_CODE: Record<string, number> = { permission_denied: 403, invalid_request: 400, not_found: 404 };

const server = (host: string, user: string) => ({ host, port: 993, security: 'tls', user, password: 'conformance' });
const imapSettings = (email: string) => ({
  email,
  imap: server('imap.example.com', email),
  smtp: { ...server('smtp.example.com', email), port: 587, security: 'starttls' },
});

function sharingBody(access: MailboxAccess) {
  if (access.kind === 'workspace') return { sharedWithAll: true, grantedMemberIds: [] };
  return { sharedWithAll: false, grantedMemberIds: access.kind === 'members' ? access.memberIds : [] };
}

/** Stores a shared access world in a fresh instance and returns a way to run actions against its REST API. */
function instance(world: AccessWorld) {
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32, 3),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 1024,
    licenseServerUrl: 'https://license.invalid',
  };
  const db = openDb(':memory:');
  db.insert(instanceSettings)
    .values({ key: 'bootstrap_complete', value: '1' })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: '1' } })
    .run();
  vi.stubEnv(
    'FLUXMAIL_LICENSE_PUBLIC_KEYS',
    licenseKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  );
  saveLeaseToken(db, businessLease());
  const registry = new AccountRegistry(db, config);
  // Provider calls are outside the access rules.
  vi.spyOn(registry, 'testImapCredentials').mockResolvedValue([]);
  vi.spyOn(registry, 'getProvider').mockReturnValue({ listFolders: async () => [] } as never);
  const app = createApp({ config, db, registry, service: new EmailService(registry, db) });

  // Members start active so sessions and keys can be issued, then take their world status.
  for (const member of world.members) {
    db.insert(members)
      .values({
        id: member.id,
        name: member.id,
        email: `${member.id}@members.example`,
        role: member.role,
        status: 'active',
        createdAt: Date.now(),
      })
      .run();
  }
  const mailboxIds = new Map<string, string>();
  for (const mailbox of world.mailboxes) {
    const settings = imapSettings(`${mailbox.id}@mail.example`);
    const account = registry.addImapAccount(
      settings.email,
      { imap: settings.imap, smtp: settings.smtp, saveSent: true, folderOverrides: {} },
      undefined,
      mailbox.ownerId,
    );
    mailboxIds.set(mailbox.id, account.id);
    registry.setAccountAccess(account.id, sharingBody(mailbox.access));
  }
  const accountId = (id: string) => mailboxIds.get(id) ?? id;
  const keys = new Map<string, string>();
  for (const credential of world.credentials ?? []) {
    const created = createApiKey(
      db,
      credential.id,
      credential.ownerId,
      FULL_PERMISSION_POLICY,
      credential.mailboxIds?.map(accountId) ?? null,
      credential.issuerId,
    );
    keys.set(credential.id, created.key);
  }
  const sessions = new Map<string, string>();
  for (const member of world.members) {
    sessions.set(member.id, issueSession(db, member.id, 'conformance').token);
    if (member.status !== 'active')
      db.update(members).set({ status: member.status }).where(eq(members.id, member.id)).run();
  }

  const call = (token: string | undefined, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const listedIds = async (response: Response): Promise<string[]> =>
    response.ok ? ((await response.json()) as { data: Array<{ id: string }> }).data.map((account) => account.id) : [];

  /** Runs the action and reports whether the server allowed it, with the error code when it didn't. */
  async function run(action: AccessAction): Promise<{ allowed: boolean; code?: string; status: number }> {
    const as = 'actorId' in action ? sessions.get(action.actorId) : undefined;
    const result = async (response: Response) => {
      if (response.ok) return { allowed: true, status: response.status };
      const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      return { allowed: false, code: body.error?.code, status: response.status };
    };
    const visible = async (response: Response, id: string) => {
      const allowed = (await listedIds(response)).includes(accountId(id));
      return { allowed, status: response.status, ...(allowed ? {} : { code: 'not_found' }) };
    };
    // Reading a mailbox goes through the same check as every mail operation.
    const read = async (token: string | undefined, id: string) =>
      result(await call(token, 'GET', `/api/v1/accounts/${accountId(id)}/folders`));

    switch (action.type) {
      case 'read_mailbox':
        return read(as, action.mailboxId);
      case 'credential_read_mailbox':
        return read(keys.get(action.credentialId), action.mailboxId);
      case 'see_mailbox_metadata': {
        const admin = await call(as, 'GET', '/api/v1/admin/accounts');
        const listed = admin.ok ? admin : await call(as, 'GET', '/api/v1/accounts');
        return visible(listed, action.mailboxId);
      }
      case 'manage_mailbox':
        return result(await call(as, 'DELETE', `/api/v1/accounts/${accountId(action.mailboxId)}/connection`));
      case 'change_mailbox_connection':
        return result(
          await call(as, 'POST', '/api/v1/accounts/connections', {
            provider: 'imap',
            reauthorizeAccountId: accountId(action.mailboxId),
            ...imapSettings(`${action.mailboxId}@mail.example`),
          }),
        );
      case 'change_mailbox_access':
        return result(
          await call(as, 'PATCH', `/api/v1/accounts/${accountId(action.mailboxId)}/access`, sharingBody(action.access)),
        );
      case 'reassign_mailbox':
        return result(
          await call(as, 'PATCH', `/api/v1/accounts/${accountId(action.mailboxId)}/access`, {
            ownerMemberId: action.newOwnerId,
          }),
        );
      case 'connect_mailbox': {
        const settings = imapSettings(`new-${action.ownerId}@mail.example`);
        return result(
          action.actorId === action.ownerId
            ? await call(as, 'POST', '/api/v1/accounts/connections', { provider: 'imap', ...settings })
            : await call(as, 'POST', '/api/v1/admin/connections', {
                provider: 'imap',
                ownerMemberId: action.ownerId,
                ...settings,
              }),
        );
      }
      case 'issue_credential': {
        const accounts = action.mailboxIds?.map(accountId) ?? null;
        return result(
          action.actorId === action.ownerId
            ? await call(as, 'POST', '/api/v1/me/api-keys', {
                name: 'conformance',
                permissionProfile: 'read-only',
                accountIds: accounts,
              })
            : await call(as, 'POST', '/api/v1/admin/api-keys', {
                name: 'conformance',
                permissionProfile: 'read-only',
                member: action.ownerId,
                accounts,
              }),
        );
      }
      case 'manage_member':
        return result(await call(as, 'PATCH', `/api/v1/admin/members/${action.targetId}`, { status: 'suspended' }));
      case 'remove_member': {
        const query = action.newOwnerId ? `?reassignTo=${action.newOwnerId}` : '';
        return result(await call(as, 'DELETE', `/api/v1/admin/members/${action.targetId}${query}`));
      }
      case 'assign_role':
        return result(await call(as, 'PATCH', `/api/v1/admin/members/${action.targetId}`, { role: action.role }));
      case 'transfer_ownership':
        throw new Error('Self-hosted has no owner role, so it runs no ownership cases.');
    }
  }

  return { run };
}

const selfHostedCases = ACCESS_CONFORMANCE_CASES.filter((testCase) => testCase.products.includes('self-hosted'));

describe('shared access conformance cases', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('runs every shared action that self-hosted offers', () => {
    const run = new Set(selfHostedCases.map((testCase) => testCase.action.type));
    const notOffered = ACCESS_ACTION_TYPES.filter((type) => !run.has(type));
    expect(notOffered).toEqual(['transfer_ownership']);
  });

  it.each(selfHostedCases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase: AccessConformanceCase) => {
      const { run } = instance(testCase.world);
      const outcome = await run(testCase.action);
      if (testCase.expected === true) {
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true });
        return;
      }
      const code = ACCESS_DENIAL_ERROR_CODES[testCase.expected];
      expect(outcome.allowed, JSON.stringify(outcome)).toBe(false);
      // An inactive member or a key whose owner or issuer is inactive can't sign in at all.
      if (testCase.expected === 'inactive_actor' || outcome.status === 401) {
        expect(['inactive_actor', 'no_mailbox_access']).toContain(testCase.expected);
        expect(outcome.status).toBe(401);
        return;
      }
      expect(outcome.code, JSON.stringify(outcome)).toBe(code);
      if (testCase.action.type === 'see_mailbox_metadata') return;
      expect(outcome.status).toBe(STATUS_FOR_CODE[code]);
    },
  );
});
