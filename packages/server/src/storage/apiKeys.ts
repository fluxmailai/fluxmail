import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { apiKeys, members, type FluxmailDb } from './db.js';
import { accessMemberLookup, getMember, type MemberRole, type MemberStatus } from './members.js';
import {
  deserializePermissionPolicy,
  DEFAULT_PERMISSION_POLICY,
  normalizePermissionPolicy,
  serializeCustomCapabilities,
  serializeSupplementalCapabilities,
  hasCapability,
  type AdminCapability,
  type Capability,
  type PermissionPolicy,
  type PermissionProfile,
} from '../permissions.js';

export interface ApiKeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Member the key was issued to. */
  memberId: string;
  permissionProfile: PermissionProfile;
  capabilities: Capability[];
  supplementalCapabilities: AdminCapability[];
  /** Additional mailbox narrowing. null means all mailboxes granted to the member. */
  accountIds: string[] | null;
  /**
   * Admin who created the key for this member, or null when the member created it.
   * The key reaches only mailboxes both members can read.
   */
  issuedByMemberId: string | null;
  /** Email address of the member who created the key, when that isn't its owner. */
  issuedByEmail: string | null;
  /** The creator's status. The key stops working while its creator isn't active. */
  issuedByStatus: MemberStatus | null;
}

function uniqueAccountIds(accountIds: readonly string[]): string[] {
  return [...new Set(accountIds)];
}

function serializeAccountIds(accountIds: readonly string[] | null): string | null {
  return accountIds === null ? null : JSON.stringify(uniqueAccountIds(accountIds));
}

function deserializeAccountIds(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('API key account scope must be a JSON array of strings.');
  }
  return uniqueAccountIds(parsed);
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Returns the plaintext key exactly once; only its hash is stored. */
export function createApiKey(
  db: FluxmailDb,
  name: string,
  memberId: string,
  permissions: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
  accountIds: readonly string[] | null = null,
  issuerMemberId: string | null = null,
): { key: string; info: ApiKeyInfo } {
  if (!memberId) throw new EmailError('invalid_request', 'A member is required when creating an API key.');
  const member = getMember(db, memberId);
  if (member.status !== 'active') {
    throw new EmailError('permission_denied', 'API keys can only be issued to active members.');
  }
  const policy = normalizePermissionPolicy(permissions);
  if (member.role !== 'admin' && policy.capabilities.some((capability) => capability.startsWith('admin.'))) {
    throw new EmailError('permission_denied', 'Administrative capabilities can only be issued to an admin member.');
  }
  const issuedByMemberId = issuerMemberId === memberId ? null : issuerMemberId;
  const issuer = issuedByMemberId === null ? null : getMember(db, issuedByMemberId);
  const id = `key_${randomBytes(8).toString('hex')}`;
  const key = `fmk_${randomBytes(32).toString('hex')}`;
  const createdAt = Date.now();
  db.insert(apiKeys)
    .values({
      id,
      name,
      keyHash: hashKey(key),
      createdAt,
      memberId,
      permissionProfile: policy.profile,
      customCapabilities: serializeCustomCapabilities(policy),
      supplementalCapabilities: serializeSupplementalCapabilities(policy),
      accountIds: serializeAccountIds(accountIds),
      issuerMemberId: issuedByMemberId,
    })
    .run();
  return {
    key,
    info: {
      id,
      name,
      createdAt,
      lastUsedAt: null,
      memberId,
      permissionProfile: policy.profile,
      capabilities: policy.capabilities,
      supplementalCapabilities: policy.supplementalCapabilities,
      accountIds: accountIds === null ? null : uniqueAccountIds(accountIds),
      issuedByMemberId,
      issuedByEmail: issuer?.email ?? null,
      issuedByStatus: issuer?.status ?? null,
    },
  };
}

export interface ApiKeyAuth {
  /** Stable key id used to scope REST idempotency records. */
  keyId: string;
  /** Member the key was issued to. */
  memberId: string;
  /** Current member role. */
  role: MemberRole;
  permissions: PermissionPolicy;
  accountIds: string[] | null;
  /** Admin who created the key for the member, or null when the member created it. */
  issuerId: string | null;
}

/**
 * Verify a key, record its use, and return its live member role and mailbox
 * narrowing. Suspended and pending members cannot authenticate with API keys,
 * and neither can a key whose issuer is no longer active.
 */
export function authenticateApiKey(db: FluxmailDb, key: string): ApiKeyAuth | null {
  const row = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashKey(key)))
    .get();
  if (!row) return null;
  let permissions: PermissionPolicy;
  try {
    permissions = deserializePermissionPolicy(
      row.permissionProfile,
      row.customCapabilities,
      row.supplementalCapabilities,
    );
    const accountIds = deserializeAccountIds(row.accountIds);
    // Status and role only: this runs on every request made with a key.
    const findMember = accessMemberLookup(db);
    const member = findMember(row.memberId);
    if (member?.status !== 'active') return null;
    if (row.issuerMemberId !== null && findMember(row.issuerMemberId)?.status !== 'active') return null;
    db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id)).run();
    return {
      keyId: row.id,
      memberId: row.memberId,
      role: member.role as MemberRole,
      permissions,
      accountIds,
      issuerId: row.issuerMemberId,
    };
  } catch {
    return null;
  }
}

export function verifyApiKey(db: FluxmailDb, key: string): boolean {
  return authenticateApiKey(db, key) !== null;
}

export function listApiKeys(db: FluxmailDb): ApiKeyInfo[] {
  const issuers = new Map(
    db
      .select({ id: members.id, email: members.email, status: members.status })
      .from(members)
      .all()
      .map((member) => [member.id, member]),
  );
  return db
    .select()
    .from(apiKeys)
    .all()
    .map((r) => {
      const issuer = r.issuerMemberId === null ? undefined : issuers.get(r.issuerMemberId);
      const permissions = deserializePermissionPolicy(
        r.permissionProfile,
        r.customCapabilities,
        r.supplementalCapabilities,
      );
      const accountIds = deserializeAccountIds(r.accountIds);
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        memberId: r.memberId,
        permissionProfile: permissions.profile,
        capabilities: permissions.capabilities,
        supplementalCapabilities: permissions.supplementalCapabilities,
        accountIds,
        issuedByMemberId: r.issuerMemberId,
        issuedByEmail: issuer?.email ?? null,
        issuedByStatus: (issuer?.status as MemberStatus | undefined) ?? null,
      };
    });
}

export function updateApiKeyAccounts(db: FluxmailDb, id: string, accountIds: readonly string[] | null): boolean {
  const result = db
    .update(apiKeys)
    .set({ accountIds: serializeAccountIds(accountIds) })
    .where(eq(apiKeys.id, id))
    .run();
  return result.changes > 0;
}

export function updateApiKeyPermissions(db: FluxmailDb, id: string, permissions: PermissionPolicy): boolean {
  const policy = normalizePermissionPolicy(permissions);
  const existing = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!existing) return false;
  const member = getMember(db, existing.memberId);
  if (member.role !== 'admin' && policy.capabilities.some((capability) => capability.startsWith('admin.'))) {
    throw new EmailError('permission_denied', 'Administrative capabilities can only be issued to an admin member.');
  }
  const result = db
    .update(apiKeys)
    .set({
      permissionProfile: policy.profile,
      customCapabilities: serializeCustomCapabilities(policy),
      supplementalCapabilities: serializeSupplementalCapabilities(policy),
    })
    .where(eq(apiKeys.id, id))
    .run();
  return result.changes > 0;
}

export interface ApiKeyUpdate {
  permissions?: PermissionPolicy;
  accountIds?: readonly string[] | null;
}

/** Replace requested key fields in one write after all validation succeeds. */
export function updateApiKey(db: FluxmailDb, id: string, update: ApiKeyUpdate): ApiKeyInfo | undefined {
  const existing = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!existing) return undefined;
  const policy = update.permissions ? normalizePermissionPolicy(update.permissions) : undefined;
  const member = getMember(db, existing.memberId);
  if (policy && member.role !== 'admin' && policy.capabilities.some((item) => item.startsWith('admin.'))) {
    throw new EmailError('permission_denied', 'Administrative capabilities can only be issued to an admin member.');
  }
  db.update(apiKeys)
    .set({
      ...(policy
        ? {
            permissionProfile: policy.profile,
            customCapabilities: serializeCustomCapabilities(policy),
            supplementalCapabilities: serializeSupplementalCapabilities(policy),
          }
        : {}),
      ...(update.accountIds !== undefined ? { accountIds: serializeAccountIds(update.accountIds) } : {}),
    })
    .where(eq(apiKeys.id, id))
    .run();
  return listApiKeys(db).find((key) => key.id === id);
}

export function isUsableRootKey(db: FluxmailDb, id: string): boolean {
  const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!row) return false;
  try {
    const permissions = deserializePermissionPolicy(
      row.permissionProfile,
      row.customCapabilities,
      row.supplementalCapabilities,
    );
    if (!hasCapability(permissions, 'admin.api_keys')) return false;
    const member = getMember(db, row.memberId);
    return member.status === 'active' && member.role === 'admin';
  } catch {
    return false;
  }
}

export function countUsableRootKeys(db: FluxmailDb, excludingId?: string): number {
  return db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .all()
    .filter((row) => row.id !== excludingId && isUsableRootKey(db, row.id)).length;
}

export function revokeApiKey(db: FluxmailDb, id: string): boolean {
  const result = db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  return result.changes > 0;
}
