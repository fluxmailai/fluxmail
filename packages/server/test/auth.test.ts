import { describe, expect, it, vi } from 'vitest';
import { EmailError } from '@fluxmail/core';
import type { FluxmailConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { EmailService } from '../src/service/emailService.js';
import { createApp } from '../src/http/app.js';
import {
  authenticateBearer,
  enrollMember,
  hashPassword,
  issueMemberAuthToken,
  isBootstrapComplete,
  loginWithPassword,
  normalizeAndValidatePassword,
  recoverAdminPassword,
  resetPassword,
  setupInitialAdmin,
} from '../src/auth.js';
import {
  adminAuditEvents,
  authRateLimits,
  instanceSettings,
  memberAuthTokens,
  memberCredentials,
  memberSessions,
  openDb,
} from '../src/storage/db.js';
import { addMember, updateMember } from '../src/storage/members.js';
import { eq } from 'drizzle-orm';
import type { Telemetry } from '../src/telemetry.js';
import type { Logger } from '../src/logging.js';
import { identityOperationRoutes } from '../src/http/identity.js';
import { adminOperationRoutes } from '../src/http/admin.js';

const strongPassword = 'Ocean lantern signal violet 2026!';

function fixture(telemetry?: Telemetry, logger?: Logger) {
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32, 1),
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
  const app = createApp({ config, db, registry, service: new EmailService(registry, db), telemetry, logger });
  return { app, db, registry };
}

describe('member authentication', () => {
  it('sets up the first admin and supports normal password login without another invitation', async () => {
    const { db } = fixture();
    expect(isBootstrapComplete(db)).toBe(false);

    const setup = await setupInitialAdmin(db, {
      name: 'Alice Admin',
      email: 'Alice@example.com',
      password: strongPassword,
      deviceName: 'Setup CLI',
    });

    expect(isBootstrapComplete(db)).toBe(true);
    expect(setup.member).toMatchObject({ email: 'alice@example.com', role: 'admin', status: 'active' });
    expect(authenticateBearer(db, setup.session.token)).toMatchObject({
      kind: 'session',
      memberId: setup.member.id,
      role: 'admin',
    });

    const login = await loginWithPassword(db, {
      email: 'ALICE@example.com',
      password: strongPassword,
      deviceName: 'Second CLI',
      ipAddress: '127.0.0.1',
    });
    expect(login.session.token).toMatch(/^fms_/);
    expect(login.session.info.expiresAt - login.session.info.createdAt).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('enrolls a pending member once and rejects reused enrollment codes', async () => {
    const { db } = fixture();
    const member = addMember(db, {
      name: 'New Member',
      email: 'member@example.com',
      role: 'member',
      status: 'pending',
    });
    const invitation = issueMemberAuthToken(db, {
      memberId: member.id,
      kind: 'enrollment',
    });

    const enrolled = await enrollMember(db, {
      token: invitation.token,
      password: 'Meadow compass riverstone 2026!',
      deviceName: 'Member CLI',
    });
    expect(enrolled.member.status).toBe('active');
    await expect(
      enrollMember(db, {
        token: invitation.token,
        password: 'Another member password 2026!',
        deviceName: 'Other CLI',
      }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('allows only one concurrent redemption of a one-time enrollment code', async () => {
    const { db } = fixture();
    const member = addMember(db, {
      name: 'Concurrent Member',
      email: 'concurrent@example.com',
      status: 'pending',
    });
    const invitation = issueMemberAuthToken(db, { memberId: member.id, kind: 'enrollment' });
    const attempts = await Promise.allSettled([
      enrollMember(db, {
        token: invitation.token,
        password: 'Meadow compass first password 2026!',
        deviceName: 'First CLI',
      }),
      enrollMember(db, {
        token: invitation.token,
        password: 'Meadow compass second password 2026!',
        deviceName: 'Second CLI',
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
  });

  it('invalidates expired sessions and credentials owned by suspended members', async () => {
    const { db } = fixture();
    const second = addMember(db, {
      name: 'Second Member',
      email: 'second@example.com',
      role: 'member',
      status: 'pending',
    });
    const secondEnrollment = issueMemberAuthToken(db, {
      memberId: second.id,
      kind: 'enrollment',
    });
    const secondLogin = await enrollMember(db, {
      token: secondEnrollment.token,
      password: 'Cedar administrator riverstone 2026!',
      deviceName: 'Second CLI',
    });
    db.insert(instanceSettings)
      .values({ key: 'bootstrap_complete', value: '1' })
      .onConflictDoUpdate({ target: instanceSettings.key, set: { value: '1' } })
      .run();

    db.update(memberSessions)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(memberSessions.id, secondLogin.session.info.id))
      .run();
    expect(authenticateBearer(db, secondLogin.session.token)).toBeNull();

    const fresh = await loginWithPassword(db, {
      email: 'second@example.com',
      password: 'Cedar administrator riverstone 2026!',
      deviceName: 'Fresh CLI',
      ipAddress: '127.0.0.2',
    });
    updateMember(db, second.id, { status: 'suspended' });
    expect(authenticateBearer(db, fresh.session.token)).toBeNull();
  });

  it('exposes login, current-member, and logout through the REST control plane', async () => {
    const { app, db } = fixture();
    await setupInitialAdmin(db, {
      name: 'Admin',
      email: 'admin@example.com',
      password: strongPassword,
    });

    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: strongPassword, deviceName: 'REST test' }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('cache-control')).toBe('no-store');
    const body = (await login.json()) as { data: { token: string } };
    const headers = { authorization: `Bearer ${body.data.token}` };
    expect((await app.request('/api/v1/me', { headers })).status).toBe(200);
    const invalidKey = await app.request('/api/v1/me/api-keys', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'invalid key', permissionProfile: 'read-onyl' }),
    });
    expect(invalidKey.status).toBe(400);
    await expect(invalidKey.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    const keyResponse = await app.request('/api/v1/me/api-keys', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test key' }),
    });
    expect(keyResponse.status).toBe(201);
    const keyBody = (await keyResponse.json()) as { data: { key: string } };
    const keyHeaders = { authorization: `Bearer ${keyBody.data.key}`, 'content-type': 'application/json' };
    expect((await app.request('/api/v1/me/api-keys', { headers: keyHeaders })).status).toBe(403);
    expect(
      (
        await app.request('/api/v1/me', {
          method: 'PATCH',
          headers: keyHeaders,
          body: JSON.stringify({ name: 'Changed by key' }),
        })
      ).status,
    ).toBe(403);
    expect((await app.request('/api/v1/auth/logout', { method: 'POST', headers })).status).toBe(200);
    expect((await app.request('/api/v1/me', { headers })).status).toBe(401);
  });

  it('rejects oversized public authentication requests before parsing credentials', async () => {
    const { app, db } = fixture();
    await setupInitialAdmin(db, {
      name: 'Admin',
      email: 'admin@example.com',
      password: strongPassword,
    });

    const response = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'x'.repeat(70 * 1024),
        deviceName: 'Oversized request',
      }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'request_too_large' } });
  });

  it('records one audit event for an administrative identity mutation', async () => {
    const { app, db } = fixture();
    const setup = await setupInitialAdmin(db, {
      name: 'Admin',
      email: 'admin@example.com',
      password: strongPassword,
    });
    const response = await app.request(`/api/v1/admin/members/${setup.member.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Admin' }),
    });

    expect(response.status).toBe(200);
    expect(db.select().from(adminAuditEvents).all()).toEqual([
      expect.objectContaining({ operation: 'member.update', outcome: 'success', actorMemberId: setup.member.id }),
    ]);
  });

  it('records sanitized telemetry for every identity route and pre-handler failure', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, db } = fixture(telemetry);
    const privateEmail = 'telemetry-admin@example.com';
    const privatePassword = 'Telemetry lantern riverstone 2026!';
    const setup = await setupInitialAdmin(db, {
      name: 'Telemetry Admin',
      email: privateEmail,
      password: privatePassword,
    });

    const document = (await (await app.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const trackedRoutes = [...identityOperationRoutes, ...Object.values(adminOperationRoutes)];
    for (const route of trackedRoutes) {
      expect(document.paths[route.path]?.[route.method]?.operationId).toBe(route.operationId);
    }
    const selfAccountPaths = new Set([
      '/api/v1/accounts/connections',
      '/api/v1/accounts/{accountId}/connection',
      '/api/v1/accounts/{accountId}/imap/folders',
    ]);
    for (const [path, methods] of Object.entries(document.paths)) {
      const controlPlaneRoute =
        path === '/api/v1/auth' ||
        path.startsWith('/api/v1/auth/') ||
        path === '/api/v1/me' ||
        path.startsWith('/api/v1/me/') ||
        path === '/api/v1/admin' ||
        path.startsWith('/api/v1/admin/') ||
        selfAccountPaths.has(path);
      if (!controlPlaneRoute) continue;
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation.operationId) continue;
        expect(
          trackedRoutes.some(
            (route) => route.path === path && route.method === method && route.operationId === operation.operationId,
          ),
        ).toBe(true);
      }
    }

    const invalidLogin = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: privateEmail, password: 'wrong private password', deviceName: 'Private device' }),
    });
    expect(invalidLogin.status).toBe(403);

    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: privateEmail, password: privatePassword, deviceName: 'Private device' }),
    });
    const loginBody = (await login.json()) as { data: { token: string } };
    const auth = { authorization: `Bearer ${loginBody.data.token}` };
    expect((await app.request('/api/v1/me')).status).toBe(401);
    expect((await app.request('/api/v1/me', { headers: auth })).status).toBe(200);
    expect((await app.request('/api/v1/admin/members', { headers: auth })).status).toBe(200);
    expect(
      (
        await app.request(`/api/v1/admin/members/${setup.member.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Private new name' }),
        })
      ).status,
    ).toBe(401);

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'login',
        outcome: 'error',
        error_code: 'permission_denied',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'login', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'getCurrentMember',
        outcome: 'error',
        error_code: 'unauthorized',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'listMembers', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'updateMember',
        outcome: 'error',
        error_code: 'unauthorized',
      }),
    );

    const serialized = JSON.stringify(capture.mock.calls);
    for (const privateValue of [
      privateEmail,
      privatePassword,
      'wrong private password',
      'Private device',
      'Private new name',
      setup.member.id,
      loginBody.data.token,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }

    capture.mockClear();
    expect((await app.request('/api/v1/me/not-a-route', { headers: auth })).status).toBe(404);
    expect(capture).not.toHaveBeenCalled();
  });

  it('normalizes passwords and stores the required Argon2id parameters', async () => {
    const { db } = fixture();
    expect(normalizeAndValidatePassword('eight888')).toBe('eight888');
    expect(() => normalizeAndValidatePassword('short7')).toThrow(/between 8 and 256/);
    expect(() => normalizeAndValidatePassword('password')).toThrow(/not common/);
    expect(() => normalizeAndValidatePassword('passwordpassword')).toThrow(/not common/);
    expect(() =>
      normalizeAndValidatePassword('Alice has a very long password', {
        name: 'Alice',
        email: 'alice@example.com',
      }),
    ).toThrow(/member details/);
    const setup = await setupInitialAdmin(db, {
      name: 'Hash Admin',
      email: 'hash@example.com',
      password: strongPassword,
    });
    const credential = db.select().from(memberCredentials).where(eq(memberCredentials.memberId, setup.member.id)).get();
    expect(credential?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(credential?.passwordHash).not.toContain(strongPassword);
    await expect(hashPassword('short7')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('uses generic login failures and persistently throttles repeated attempts', async () => {
    const { db } = fixture();
    await setupInitialAdmin(db, {
      name: 'Rate Admin',
      email: 'rate@example.com',
      password: strongPassword,
    });
    const attempt = (email: string) =>
      loginWithPassword(db, {
        email,
        password: 'Incorrect meadow compass 2026!',
        deviceName: 'Test CLI',
        ipAddress: '198.51.100.10',
      });
    const unknown = await attempt('unknown@example.com').catch((error: Error) => error);
    const incorrect = await attempt('rate@example.com').catch((error: Error) => error);
    expect(unknown.message).toBe('Email or password is incorrect.');
    expect(incorrect.message).toBe(unknown.message);
    for (let attemptNumber = 2; attemptNumber <= 5; attemptNumber += 1) {
      await expect(attempt('rate@example.com')).rejects.toMatchObject({ code: 'permission_denied' });
    }
    await expect(attempt('rate@example.com')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('reserves login attempts before password verification and removes expired throttle rows', async () => {
    const { db } = fixture();
    await setupInitialAdmin(db, {
      name: 'Concurrent Rate Admin',
      email: 'concurrent-rate@example.com',
      password: strongPassword,
    });
    db.insert(authRateLimits)
      .values({ key: 'expired-entry', attempts: 30, windowStartedAt: Date.now() - 16 * 60 * 1000 })
      .run();

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        loginWithPassword(db, {
          email: 'concurrent-rate@example.com',
          password: 'Incorrect meadow compass 2026!',
          deviceName: 'Concurrent test',
          ipAddress: '198.51.100.20',
        }).catch((error: { code: string }) => error.code),
      ),
    );

    expect(attempts.filter((code) => code === 'permission_denied')).toHaveLength(5);
    expect(attempts.filter((code) => code === 'rate_limited')).toHaveLength(5);
    expect(db.select().from(authRateLimits).where(eq(authRateLimits.key, 'expired-entry')).get()).toBeUndefined();
  });

  it('rejects expired reset codes and revokes sessions after a password reset', async () => {
    const { db } = fixture();
    const setup = await setupInitialAdmin(db, {
      name: 'Reset Admin',
      email: 'reset@example.com',
      password: strongPassword,
    });
    const expired = issueMemberAuthToken(db, { memberId: setup.member.id, kind: 'password_reset' });
    db.update(memberAuthTokens)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(memberAuthTokens.memberId, setup.member.id))
      .run();
    await expect(
      resetPassword(db, { token: expired.token, password: 'Cedar riverstone meadow 2026!', deviceName: 'CLI' }),
    ).rejects.toMatchObject({ code: 'auth_expired' });

    const secondLogin = await loginWithPassword(db, {
      email: 'reset@example.com',
      password: strongPassword,
      deviceName: 'Second CLI',
      ipAddress: '127.0.0.3',
    });
    const reset = issueMemberAuthToken(db, {
      memberId: setup.member.id,
      kind: 'password_reset',
      createdByMemberId: setup.member.id,
    });
    const redeemed = await resetPassword(db, {
      token: reset.token,
      password: 'Granite compass orchard 2026!',
      deviceName: 'Reset CLI',
    });
    expect(authenticateBearer(db, setup.session.token)).toBeNull();
    expect(authenticateBearer(db, secondLogin.session.token)).toBeNull();
    expect(authenticateBearer(db, redeemed.session.token)).toMatchObject({ memberId: setup.member.id });
    await expect(
      loginWithPassword(db, {
        email: 'reset@example.com',
        password: strongPassword,
        deviceName: 'Old password',
        ipAddress: '127.0.0.4',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('supports local break-glass recovery without creating another member', async () => {
    const { db } = fixture();
    const setup = await setupInitialAdmin(db, {
      name: 'Recovery Admin',
      email: 'recovery@example.com',
      password: strongPassword,
    });
    const recovered = await recoverAdminPassword(db, setup.member.id, 'Harbor granite compass 2026!');
    expect(recovered.id).toBe(setup.member.id);
    expect(authenticateBearer(db, setup.session.token)).toBeNull();
    await expect(
      loginWithPassword(db, {
        email: 'recovery@example.com',
        password: 'Harbor granite compass 2026!',
        deviceName: 'Recovered CLI',
        ipAddress: '127.0.0.5',
      }),
    ).resolves.toMatchObject({ member: { id: setup.member.id } });
  });

  it('supports profile and owned IMAP folder updates through the member API', async () => {
    const { app, db, registry } = fixture();
    const setup = await setupInitialAdmin(db, {
      name: 'Mailbox Owner',
      email: 'owner@example.com',
      password: strongPassword,
    });
    const account = registry.addImapAccount(
      'owner@example.com',
      {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'owner', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'owner', password: 'secret' },
        saveSent: true,
        folderOverrides: {},
      },
      undefined,
      setup.member.id,
    );
    vi.spyOn(registry, 'testImapFolderOverrides').mockResolvedValue([]);
    const headers = { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' };
    const profile = await app.request('/api/v1/me', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Updated Owner' }),
    });
    expect(profile.status).toBe(200);
    await expect(profile.json()).resolves.toMatchObject({ data: { name: 'Updated Owner' } });

    const folders = await app.request(`/api/v1/accounts/${account.id}/imap/folders`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sent: 'Sent Items' }),
    });
    expect(folders.status).toBe(200);
    expect(registry.loadImapCredentials(account.id).folderOverrides).toEqual({ sent: 'Sent Items' });
  });

  it('records the provider and mailbox totals when a member connects and removes a mailbox', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, db, registry } = fixture(telemetry);
    const setup = await setupInitialAdmin(db, {
      name: 'Mailbox Owner',
      email: 'owner@example.com',
      password: strongPassword,
    });
    vi.spyOn(registry, 'testImapCredentials').mockResolvedValue([]);
    const headers = { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' };
    const privateMailbox = 'private@example.com';
    const privateSecret = 'private-imap-password';
    const connectionBody = JSON.stringify({
      provider: 'imap',
      email: privateMailbox,
      imap: { host: 'imap.example.com', port: 993, security: 'tls', user: privateMailbox, password: privateSecret },
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        security: 'starttls',
        user: privateMailbox,
        password: privateSecret,
      },
    });

    const connection = await app.request('/api/v1/accounts/connections', {
      method: 'POST',
      headers,
      body: connectionBody,
    });
    expect(connection.status).toBe(201);
    const accountId = ((await connection.json()) as { data: { account: { id: string } } }).data.account.id;

    const reconnect = await app.request('/api/v1/accounts/connections', {
      method: 'POST',
      headers,
      body: connectionBody,
    });
    expect(reconnect.status).toBe(201);

    // This instance has no Google application, so the hosted flow cannot start.
    const gmail = await app.request('/api/v1/accounts/connections', {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'gmail' }),
    });
    expect(gmail.status).toBe(400);

    const removal = await app.request(`/api/v1/accounts/${accountId}/connection`, { method: 'DELETE', headers });
    expect(removal.status).toBe(200);

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'connectOwnAccount',
        outcome: 'success',
        provider: 'imap',
        connection_flow: 'imap_credentials',
        connection_stage: 'complete',
        provider_timeout_ms: 30_000,
        http_status: 201,
        reauthorize: false,
        account_count: 1,
        imap_account_count: 1,
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'connectOwnAccount',
        outcome: 'success',
        provider: 'imap',
        connection_flow: 'imap_credentials',
        connection_stage: 'complete',
        provider_timeout_ms: 30_000,
        http_status: 201,
        reauthorize: true,
        account_count: 1,
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'connectOwnAccount',
        outcome: 'error',
        error_code: 'invalid_request',
        provider: 'gmail',
        connection_flow: 'hosted',
        connection_stage: 'oauth_prepare',
        http_status: 400,
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'removeOwnAccount',
        outcome: 'success',
        provider: 'imap',
        account_count: 0,
        imap_account_count: 0,
      }),
    );
    const captured = JSON.stringify(capture.mock.calls);
    expect(captured).not.toContain(privateMailbox);
    expect(captured).not.toContain(privateSecret);
    expect(captured).not.toContain(accountId);
    expect(captured).not.toContain('imap.example.com');
  });

  it('returns 503 for provider failures on member-managed IMAP routes', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const { app, db, registry } = fixture(telemetry, logger);
    const setup = await setupInitialAdmin(db, {
      name: 'Mailbox Owner',
      email: 'owner@example.com',
      password: strongPassword,
    });
    const headers = { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' };
    vi.spyOn(registry, 'testImapCredentials').mockRejectedValueOnce(
      new EmailError('provider_unavailable', 'The IMAP server is unavailable.'),
    );
    const requestId = '4c32a2bb-2221-4a2a-905a-a48862125a00';

    const connection = await app.request('/api/v1/accounts/connections', {
      method: 'POST',
      headers: { ...headers, 'x-request-id': requestId },
      body: JSON.stringify({
        provider: 'imap',
        email: 'new@example.com',
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'new', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'new', password: 'secret' },
      }),
    });
    expect(connection.status).toBe(503);
    await expect(connection.json()).resolves.toEqual({
      error: {
        code: 'provider_unavailable',
        message: 'The IMAP server is unavailable.',
        requestId,
        diagnostics: { connectionStage: 'provider_check' },
      },
    });
    expect(connection.headers.get('x-request-id')).toBe(requestId);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'connectOwnAccount',
        outcome: 'error',
        error_code: 'provider_unavailable',
        provider: 'imap',
        connection_flow: 'imap_credentials',
        connection_stage: 'provider_check',
        failure_kind: 'provider_error',
        provider_timeout_ms: 30_000,
        http_status: 503,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'rest.operation_failed',
      expect.any(String),
      expect.any(Error),
      expect.objectContaining({
        details: { request_id: requestId, connection_stage: 'provider_check' },
      }),
    );
    const captured = JSON.stringify(capture.mock.calls);
    expect(captured).not.toContain(requestId);
    expect(captured).not.toContain('new@example.com');
    expect(captured).not.toContain('imap.example.com');
    expect(captured).not.toContain('secret');

    const account = registry.addImapAccount(
      'owner@example.com',
      {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'owner', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'owner', password: 'secret' },
        saveSent: true,
        folderOverrides: {},
      },
      undefined,
      setup.member.id,
    );
    vi.spyOn(registry, 'testImapFolderOverrides').mockRejectedValueOnce(
      new EmailError('provider_unavailable', 'The IMAP server is unavailable.'),
    );
    const folders = await app.request(`/api/v1/accounts/${account.id}/imap/folders`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sent: 'Sent Items' }),
    });
    expect(folders.status).toBe(503);
    await expect(folders.json()).resolves.toEqual({
      error: { code: 'provider_unavailable', message: 'The IMAP server is unavailable.' },
    });
  });
  it('records thrown account setup failures with the eventual server status', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, db } = fixture(telemetry);
    const setup = await setupInitialAdmin(db, {
      name: 'Mailbox Owner',
      email: 'owner@example.com',
      password: strongPassword,
    });
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('private database failure');
    });

    const response = await app.request('/api/v1/accounts/connections', {
      method: 'POST',
      headers: { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'imap' }),
    });

    expect(response.status).toBe(500);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'connectOwnAccount',
        outcome: 'error',
        error_code: 'internal',
        http_status: 500,
        failure_kind: 'server_error',
      }),
    );
  });

  it('records malformed account setup JSON as a client validation failure', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    const { app, db } = fixture(telemetry);
    const setup = await setupInitialAdmin(db, {
      name: 'Mailbox Owner',
      email: 'owner@example.com',
      password: strongPassword,
    });

    const response = await app.request('/api/v1/accounts/connections', {
      method: 'POST',
      headers: { authorization: `Bearer ${setup.session.token}`, 'content-type': 'application/json' },
      body: '{"provider":',
    });

    expect(response.status).toBe(400);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'connectOwnAccount',
        outcome: 'error',
        error_code: 'invalid_request',
        http_status: 400,
        failure_kind: 'validation_error',
      }),
    );
  });
});
