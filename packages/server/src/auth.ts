import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import {
  accounts,
  apiKeys,
  authRateLimits,
  instanceSettings,
  memberAuthTokens,
  memberCredentials,
  memberSessions,
  members,
  type FluxmailDb,
} from './storage/db.js';
import { authenticateApiKey } from './storage/apiKeys.js';
import { authenticateOAuthAccessToken, revokeMemberOAuthGrants } from './storage/oauth.js';
import { addMember, findMember, getMember, type MemberInfo, type MemberRole } from './storage/members.js';
import { FULL_PERMISSION_POLICY, permissionPolicyForMailCapabilities, type PermissionPolicy } from './permissions.js';
import { assertMemberLimit, getEntitlements } from './licensing/entitlements.js';

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789012345',
  'correcthorsebatterystaple',
  'letmeinletmeinletmein',
  'password',
  'passwordpassword',
  'qwertyuiop',
  'qwertyqwertyqwerty',
]);

const ARGON_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

const dummyPasswordHash = hash('fluxmail-invalid-login-padding', ARGON_OPTIONS);

export interface MemberSessionPrincipal {
  kind: 'session';
  principalId: string;
  sessionId: string;
  memberId: string;
  role: MemberRole;
  permissions: PermissionPolicy;
  accountIds: string[] | null;
}

export interface ApiKeyPrincipal {
  kind: 'api_key';
  principalId: string;
  keyId: string;
  memberId: string;
  role: MemberRole;
  permissions: PermissionPolicy;
  accountIds: string[] | null;
}

/** An MCP client authorized through OAuth. It can only use mail capabilities on /mcp. */
export interface OAuthPrincipal {
  kind: 'oauth';
  /** The grant id, which stays the same when tokens rotate. */
  principalId: string;
  grantId: string;
  clientId: string;
  memberId: string;
  role: MemberRole;
  permissions: PermissionPolicy;
  accountIds: string[] | null;
}

export type Principal = MemberSessionPrincipal | ApiKeyPrincipal | OAuthPrincipal;

export interface SessionInfo {
  id: string;
  memberId: string;
  deviceName: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
  current: boolean;
}

export type MemberAuthTokenKind = 'enrollment' | 'password_reset';

function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function normalizedEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new EmailError('invalid_request', 'Enter a valid member email address.');
  }
  return normalized;
}

function rateKey(kind: 'email' | 'ip', value: string): string {
  return `${kind}:${secretHash(value.trim().toLowerCase())}`;
}

interface ReservedLoginAttempt {
  ipWindowStartedAt: number;
}

function reserveLoginAttempt(
  db: FluxmailDb,
  emailKey: string,
  ipKey: string,
  now: number,
): ReservedLoginAttempt | null {
  return db.transaction((tx) => {
    tx.delete(authRateLimits)
      .where(lte(authRateLimits.windowStartedAt, now - RATE_WINDOW_MS))
      .run();
    const emailRow = tx.select().from(authRateLimits).where(eq(authRateLimits.key, emailKey)).get();
    const ipRow = tx.select().from(authRateLimits).where(eq(authRateLimits.key, ipKey)).get();
    if ((emailRow?.attempts ?? 0) >= 5 || (ipRow?.attempts ?? 0) >= 30) return null;

    const reserve = (key: string, row: typeof emailRow): number => {
      if (!row) {
        tx.insert(authRateLimits).values({ key, attempts: 1, windowStartedAt: now }).run();
        return now;
      }
      tx.update(authRateLimits)
        .set({ attempts: row.attempts + 1 })
        .where(eq(authRateLimits.key, key))
        .run();
      return row.windowStartedAt;
    };
    reserve(emailKey, emailRow);
    return { ipWindowStartedAt: reserve(ipKey, ipRow) };
  });
}

function releaseLoginAttempt(db: FluxmailDb, key: string, windowStartedAt: number): void {
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(authRateLimits)
      .where(and(eq(authRateLimits.key, key), eq(authRateLimits.windowStartedAt, windowStartedAt)))
      .get();
    if (!row) return;
    if (row.attempts <= 1) {
      tx.delete(authRateLimits).where(eq(authRateLimits.key, key)).run();
      return;
    }
    tx.update(authRateLimits)
      .set({ attempts: row.attempts - 1 })
      .where(and(eq(authRateLimits.key, key), eq(authRateLimits.windowStartedAt, windowStartedAt)))
      .run();
  });
}

export function normalizeAndValidatePassword(password: string, member?: Pick<MemberInfo, 'name' | 'email'>): string {
  const normalized = password.normalize('NFC');
  const length = [...normalized].length;
  if (length < 8 || length > 256) {
    throw new EmailError('invalid_request', 'Password must contain between 8 and 256 characters.');
  }
  const lower = normalized.toLowerCase();
  const context = [member?.name, member?.email, member?.email?.split('@')[0], 'fluxmail']
    .filter((value): value is string => Boolean(value && value.length >= 3))
    .map((value) => value.toLowerCase());
  if (COMMON_PASSWORDS.has(lower.trim()) || context.some((value) => lower.includes(value))) {
    throw new EmailError('invalid_request', 'Choose a password that is not common or based on your member details.');
  }
  return normalized;
}

export async function hashPassword(password: string, member?: Pick<MemberInfo, 'name' | 'email'>): Promise<string> {
  return hash(normalizeAndValidatePassword(password, member), ARGON_OPTIONS);
}

async function passwordMatches(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password.normalize('NFC'));
  } catch {
    return false;
  }
}

export function isBootstrapComplete(db: FluxmailDb): boolean {
  return db.select().from(instanceSettings).where(eq(instanceSettings.key, 'bootstrap_complete')).get()?.value === '1';
}

function markBootstrapComplete(db: FluxmailDb): void {
  db.insert(instanceSettings)
    .values({ key: 'bootstrap_complete', value: '1' })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: '1' } })
    .run();
}

async function replacePassword(db: FluxmailDb, member: MemberInfo, password: string): Promise<void> {
  const passwordHash = await hashPassword(password, member);
  storePasswordHash(db, member.id, passwordHash);
}

function storePasswordHash(db: FluxmailDb, memberId: string, passwordHash: string): void {
  const current = db.select().from(memberCredentials).where(eq(memberCredentials.memberId, memberId)).get();
  db.insert(memberCredentials)
    .values({
      memberId,
      passwordHash,
      passwordVersion: (current?.passwordVersion ?? 0) + 1,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: memberCredentials.memberId,
      set: {
        passwordHash,
        passwordVersion: (current?.passwordVersion ?? 0) + 1,
        updatedAt: Date.now(),
      },
    })
    .run();
}

export async function setupInitialAdmin(
  db: FluxmailDb,
  input: { name?: string; email: string; password: string; existingAdmin?: string; deviceName?: string },
): Promise<{ member: MemberInfo; session: { token: string; info: SessionInfo } }> {
  if (isBootstrapComplete(db)) throw new EmailError('invalid_request', 'This instance has already been set up.');
  const existing = db.select().from(members).all();
  let member: MemberInfo;
  if (existing.length === 0) {
    if (!input.name?.trim()) throw new EmailError('invalid_request', 'Administrator name is required.');
    const email = normalizedEmail(input.email);
    const passwordHash = await hashPassword(input.password, {
      name: input.name.trim(),
      email,
    });
    member = addMember(db, {
      name: input.name,
      email,
      role: 'admin',
      status: 'pending',
      completeBootstrap: false,
    });
    storePasswordHash(db, member.id, passwordHash);
  } else {
    if (!input.existingAdmin) {
      const candidates = existing
        .filter((candidate) => candidate.role === 'admin')
        .map((candidate) => `${candidate.id} (${candidate.name}${candidate.email ? `, ${candidate.email}` : ''})`)
        .join(', ');
      throw new EmailError(
        'invalid_request',
        `Choose an existing administrator with --existing-admin. Available: ${candidates || 'none'}.`,
      );
    }
    member = findMember(db, input.existingAdmin);
    if (member.role !== 'admin')
      throw new EmailError('permission_denied', 'The claimed member must be an administrator.');
    const email = normalizedEmail(input.email);
    const passwordHash = await hashPassword(input.password, { ...member, email });
    db.update(members).set({ email, status: 'pending' }).where(eq(members.id, member.id)).run();
    storePasswordHash(db, member.id, passwordHash);
    db.update(accounts).set({ ownerMemberId: member.id }).where(isNull(accounts.ownerMemberId)).run();
    member = getMember(db, member.id);
  }
  db.update(members).set({ status: 'active' }).where(eq(members.id, member.id)).run();
  member = getMember(db, member.id);
  markBootstrapComplete(db);
  return { member, session: issueSession(db, member.id, input.deviceName ?? `CLI on ${hostname()}`) };
}

export function issueMemberAuthToken(
  db: FluxmailDb,
  input: { memberId: string; kind: MemberAuthTokenKind; createdByMemberId?: string },
): { token: string; expiresAt: number } {
  const member = getMember(db, input.memberId);
  if (member.status === 'suspended')
    throw new EmailError('permission_denied', 'Suspended members cannot enroll or reset passwords.');
  if (input.kind === 'enrollment') {
    if (member.status !== 'pending') {
      throw new EmailError('invalid_request', 'Enrollment codes can only be issued to pending members.');
    }
    if (!member.email) {
      throw new EmailError('invalid_request', 'Set the member email before issuing an enrollment code.');
    }
  } else if (member.status !== 'active') {
    throw new EmailError('invalid_request', 'Password resets can only be issued to active members.');
  }
  const now = Date.now();
  const expiresAt = now + (input.kind === 'enrollment' ? ENROLLMENT_TTL_MS : PASSWORD_RESET_TTL_MS);
  const token = `fmt_${randomBytes(32).toString('hex')}`;
  db.transaction((tx) => {
    tx.delete(memberAuthTokens)
      .where(and(eq(memberAuthTokens.memberId, member.id), eq(memberAuthTokens.kind, input.kind)))
      .run();
    tx.insert(memberAuthTokens)
      .values({
        id: `token_${randomBytes(8).toString('hex')}`,
        memberId: member.id,
        kind: input.kind,
        tokenHash: secretHash(token),
        createdByMemberId: input.createdByMemberId ?? null,
        createdAt: now,
        expiresAt,
      })
      .run();
  });
  return { token, expiresAt };
}

async function consumeMemberAuthToken(
  db: FluxmailDb,
  input: { token: string; kind: MemberAuthTokenKind; password: string; deviceName: string },
): Promise<{ member: MemberInfo; session: { token: string; info: SessionInfo } }> {
  const now = Date.now();
  const row = db
    .select()
    .from(memberAuthTokens)
    .where(
      and(
        eq(memberAuthTokens.tokenHash, secretHash(input.token)),
        eq(memberAuthTokens.kind, input.kind),
        isNull(memberAuthTokens.usedAt),
        gt(memberAuthTokens.expiresAt, now),
      ),
    )
    .get();
  if (!row) throw new EmailError('auth_expired', 'The enrollment or reset code is invalid, expired, or already used.');
  let member = getMember(db, row.memberId);
  if (member.status === 'suspended') throw new EmailError('permission_denied', 'This member is suspended.');
  if (input.kind === 'enrollment' && member.status !== 'pending') {
    throw new EmailError('auth_expired', 'The enrollment or reset code is invalid, expired, or already used.');
  }
  if (input.kind === 'password_reset' && member.status !== 'active') {
    throw new EmailError('auth_expired', 'The enrollment or reset code is invalid, expired, or already used.');
  }
  if (input.kind === 'enrollment') {
    assertMemberLimit(Math.max(db.select().from(members).all().length - 1, 0), getEntitlements(db));
  }
  const passwordHash = await hashPassword(input.password, member);
  const claimedAt = Date.now();
  db.transaction((tx) => {
    const claimed = tx
      .update(memberAuthTokens)
      .set({ usedAt: claimedAt })
      .where(
        and(
          eq(memberAuthTokens.id, row.id),
          isNull(memberAuthTokens.usedAt),
          gt(memberAuthTokens.expiresAt, claimedAt),
        ),
      )
      .run();
    if (claimed.changes !== 1) {
      throw new EmailError('auth_expired', 'The enrollment or reset code is invalid, expired, or already used.');
    }
    const credential = tx.select().from(memberCredentials).where(eq(memberCredentials.memberId, member.id)).get();
    tx.insert(memberCredentials)
      .values({
        memberId: member.id,
        passwordHash,
        passwordVersion: (credential?.passwordVersion ?? 0) + 1,
        updatedAt: claimedAt,
      })
      .onConflictDoUpdate({
        target: memberCredentials.memberId,
        set: {
          passwordHash,
          passwordVersion: (credential?.passwordVersion ?? 0) + 1,
          updatedAt: claimedAt,
        },
      })
      .run();
    tx.update(memberSessions)
      .set({ revokedAt: claimedAt })
      .where(and(eq(memberSessions.memberId, member.id), isNull(memberSessions.revokedAt)))
      .run();
    revokeMemberOAuthGrants(tx, member.id, claimedAt);
    if (input.kind === 'enrollment') {
      tx.update(members).set({ status: 'active' }).where(eq(members.id, member.id)).run();
    }
  });
  member = getMember(db, member.id);
  return { member, session: issueSession(db, member.id, input.deviceName) };
}

export function enrollMember(
  db: FluxmailDb,
  input: { token: string; password: string; deviceName: string },
): Promise<{ member: MemberInfo; session: { token: string; info: SessionInfo } }> {
  return consumeMemberAuthToken(db, { ...input, kind: 'enrollment' });
}

export function resetPassword(
  db: FluxmailDb,
  input: { token: string; password: string; deviceName: string },
): Promise<{ member: MemberInfo; session: { token: string; info: SessionInfo } }> {
  return consumeMemberAuthToken(db, { ...input, kind: 'password_reset' });
}

export function issueSession(
  db: FluxmailDb,
  memberId: string,
  deviceName: string,
): { token: string; info: SessionInfo } {
  const member = getMember(db, memberId);
  if (member.status !== 'active') throw new EmailError('permission_denied', 'This member is not active.');
  const now = Date.now();
  const id = `session_${randomBytes(8).toString('hex')}`;
  const token = `fms_${randomBytes(32).toString('hex')}`;
  const info: SessionInfo = {
    id,
    memberId,
    deviceName: deviceName.trim() || 'Unknown device',
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastUsedAt: now,
    current: true,
  };
  db.insert(memberSessions)
    .values({
      id: info.id,
      memberId: info.memberId,
      deviceName: info.deviceName,
      createdAt: info.createdAt,
      expiresAt: info.expiresAt,
      lastUsedAt: info.lastUsedAt,
      tokenHash: secretHash(token),
      revokedAt: null,
    })
    .run();
  return { token, info };
}

export async function loginWithPassword(
  db: FluxmailDb,
  input: { email: string; password: string; deviceName: string; ipAddress: string },
): Promise<{ member: MemberInfo; session: { token: string; info: SessionInfo } }> {
  const member = await verifyMemberPassword(db, input);
  return { member, session: issueSession(db, member.id, input.deviceName) };
}

/**
 * Check a member's email and password under the login throttles without
 * issuing a session. OAuth approval uses this to identify the member.
 */
export async function verifyMemberPassword(
  db: FluxmailDb,
  input: { email: string; password: string; ipAddress: string },
): Promise<MemberInfo> {
  if (!isBootstrapComplete(db)) throw new EmailError('permission_denied', 'This instance has not finished setup.');
  const email = normalizedEmail(input.email);
  const now = Date.now();
  const emailKey = rateKey('email', email);
  const ipKey = rateKey('ip', input.ipAddress || 'unknown');
  const reservation = reserveLoginAttempt(db, emailKey, ipKey, now);
  if (!reservation) {
    throw new EmailError('rate_limited', 'Too many login attempts. Try again later.');
  }
  const memberRow = db
    .select()
    .from(members)
    .where(sql`lower(${members.email}) = ${email}`)
    .get();
  const credential = memberRow
    ? db.select().from(memberCredentials).where(eq(memberCredentials.memberId, memberRow.id)).get()
    : undefined;
  const matches = await passwordMatches(credential?.passwordHash ?? (await dummyPasswordHash), input.password);
  if (!memberRow || !credential || !matches || memberRow.status !== 'active') {
    throw new EmailError('permission_denied', 'Email or password is incorrect.');
  }
  db.delete(authRateLimits).where(eq(authRateLimits.key, emailKey)).run();
  releaseLoginAttempt(db, ipKey, reservation.ipWindowStartedAt);
  return getMember(db, memberRow.id);
}

export function authenticateBearer(db: FluxmailDb, token: string): Principal | null {
  if (token.startsWith('fmk_')) {
    const auth = authenticateApiKey(db, token);
    if (!auth) return null;
    return {
      kind: 'api_key',
      principalId: auth.keyId,
      keyId: auth.keyId,
      memberId: auth.memberId,
      role: auth.role,
      permissions: auth.permissions,
      accountIds: auth.accountIds,
    };
  }
  if (token.startsWith('fmo_')) {
    const auth = authenticateOAuthAccessToken(db, token);
    if (!auth) return null;
    return {
      kind: 'oauth',
      principalId: auth.grantId,
      grantId: auth.grantId,
      clientId: auth.clientId,
      memberId: auth.memberId,
      role: auth.role,
      permissions: permissionPolicyForMailCapabilities(auth.scopes),
      accountIds: auth.accountIds,
    };
  }
  if (!token.startsWith('fms_')) return null;
  const now = Date.now();
  const row = db
    .select()
    .from(memberSessions)
    .where(eq(memberSessions.tokenHash, secretHash(token)))
    .get();
  if (!row || row.revokedAt !== null || row.expiresAt <= now) return null;
  const member = getMember(db, row.memberId);
  if (member.status !== 'active') return null;
  if (now - row.lastUsedAt >= SESSION_TOUCH_INTERVAL_MS) {
    db.update(memberSessions).set({ lastUsedAt: now }).where(eq(memberSessions.id, row.id)).run();
  }
  return {
    kind: 'session',
    principalId: row.id,
    sessionId: row.id,
    memberId: member.id,
    role: member.role,
    permissions: FULL_PERMISSION_POLICY,
    accountIds: null,
  };
}

export function listMemberSessions(db: FluxmailDb, memberId: string, currentSessionId?: string): SessionInfo[] {
  const now = Date.now();
  return db
    .select()
    .from(memberSessions)
    .where(eq(memberSessions.memberId, memberId))
    .all()
    .filter((row) => row.revokedAt === null && row.expiresAt > now)
    .map((row) => ({
      id: row.id,
      memberId: row.memberId,
      deviceName: row.deviceName,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      current: row.id === currentSessionId,
    }));
}

export function revokeSession(db: FluxmailDb, memberId: string, sessionId: string): boolean {
  return (
    db
      .update(memberSessions)
      .set({ revokedAt: Date.now() })
      .where(
        and(eq(memberSessions.id, sessionId), eq(memberSessions.memberId, memberId), isNull(memberSessions.revokedAt)),
      )
      .run().changes > 0
  );
}

export async function changePassword(
  db: FluxmailDb,
  input: { memberId: string; currentPassword: string; newPassword: string; keepSessionId: string },
): Promise<void> {
  const member = getMember(db, input.memberId);
  const credential = db.select().from(memberCredentials).where(eq(memberCredentials.memberId, member.id)).get();
  if (!credential || !(await passwordMatches(credential.passwordHash, input.currentPassword))) {
    throw new EmailError('permission_denied', 'Current password is incorrect.');
  }
  await replacePassword(db, member, input.newPassword);
  db.update(memberSessions)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(memberSessions.memberId, member.id),
        sql`${memberSessions.id} != ${input.keepSessionId}`,
        isNull(memberSessions.revokedAt),
      ),
    )
    .run();
  revokeMemberOAuthGrants(db, member.id);
}

export async function recoverAdminPassword(db: FluxmailDb, ref: string, password: string): Promise<MemberInfo> {
  if (!isBootstrapComplete(db)) {
    throw new EmailError('invalid_request', 'Finish instance setup before using administrator recovery.');
  }
  const member = findMember(db, ref);
  if (member.role !== 'admin')
    throw new EmailError('permission_denied', 'Break-glass recovery is limited to administrators.');
  if (!member.email) {
    throw new EmailError('invalid_request', 'Claim this administrator with setup before using break-glass recovery.');
  }
  const passwordHash = await hashPassword(password, member);
  storePasswordHash(db, member.id, passwordHash);
  if (member.status !== 'active') db.update(members).set({ status: 'active' }).where(eq(members.id, member.id)).run();
  db.update(memberSessions)
    .set({ revokedAt: Date.now() })
    .where(and(eq(memberSessions.memberId, member.id), isNull(memberSessions.revokedAt)))
    .run();
  revokeMemberOAuthGrants(db, member.id);
  markBootstrapComplete(db);
  return getMember(db, member.id);
}

export function deleteAllApiKeys(db: FluxmailDb): number {
  return db.delete(apiKeys).run().changes;
}
