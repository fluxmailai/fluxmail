import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { revokeMemberOAuthGrants } from './oauth.js';
import {
  accounts,
  apiKeys,
  instanceSettings,
  memberCredentials,
  memberSessions,
  members,
  type FluxmailDb,
} from './db.js';
import {
  assertCanIncreaseUsage,
  assertMemberLimit,
  getEntitlements,
  recordCapState,
} from '../licensing/entitlements.js';

export interface MemberInfo {
  id: string;
  name: string;
  email: string | null;
  role: MemberRole;
  status: MemberStatus;
  createdAt: number;
  /** Mailboxes owned by this member (shared mailboxes are not counted). */
  accountCount: number;
  apiKeyCount: number;
}

export type MemberRole = 'admin' | 'member';
export type MemberStatus = 'pending' | 'active' | 'suspended';

type MemberRow = typeof members.$inferSelect;

function toInfo(db: FluxmailDb, row: MemberRow): MemberInfo {
  return {
    ...row,
    role: row.role as MemberRole,
    status: row.status as MemberStatus,
    accountCount: db.select().from(accounts).where(eq(accounts.ownerMemberId, row.id)).all().length,
    apiKeyCount: db.select().from(apiKeys).where(eq(apiKeys.memberId, row.id)).all().length,
  };
}

export function addMember(
  db: FluxmailDb,
  input: {
    name: string;
    email?: string;
    role?: MemberRole;
    status?: MemberStatus;
    id?: string;
    completeBootstrap?: boolean;
  },
): MemberInfo {
  const name = input.name.trim();
  if (!name) throw new EmailError('invalid_request', 'Member name cannot be empty');
  const email = input.email?.trim().toLowerCase();
  const id = input.id ?? `member_${randomBytes(6).toString('hex')}`;
  db.transaction((tx) => {
    if (
      email &&
      tx
        .select()
        .from(members)
        .where(sql`lower(${members.email}) = ${email}`)
        .get()
    ) {
      throw new EmailError('invalid_request', `A member with email ${email} already exists`);
    }
    const memberCount = tx.select().from(members).all().length;
    assertCanIncreaseUsage(tx);
    assertMemberLimit(memberCount, getEntitlements(tx));
    const role = input.role ?? (memberCount === 0 ? 'admin' : 'member');
    const status = input.status ?? 'active';
    tx.insert(members)
      .values({ id, name, email: email ?? null, role, status, createdAt: Date.now() })
      .run();
    if (memberCount === 0) {
      tx.update(accounts)
        .set({ ownerMemberId: id })
        .where(sql`${accounts.ownerMemberId} IS NULL`)
        .run();
      if (status === 'active' && input.completeBootstrap !== false) {
        tx.insert(instanceSettings)
          .values({ key: 'bootstrap_complete', value: '1' })
          .onConflictDoUpdate({ target: instanceSettings.key, set: { value: '1' } })
          .run();
      }
    }
  });
  return getMember(db, id);
}

export function getMember(db: FluxmailDb, id: string): MemberInfo {
  const row = db.select().from(members).where(eq(members.id, id)).get();
  if (!row) throw new EmailError('not_found', `No member with id "${id}"`);
  return toInfo(db, row);
}

/** Resolve a member by id or email, for CLI --member flags. */
export function findMember(db: FluxmailDb, ref: string): MemberInfo {
  const byId = db.select().from(members).where(eq(members.id, ref)).get();
  if (byId) return toInfo(db, byId);
  const email = ref.trim().toLowerCase();
  const byEmail = db
    .select()
    .from(members)
    .where(sql`lower(${members.email}) = ${email}`)
    .get();
  if (byEmail) return toInfo(db, byEmail);
  throw new EmailError('not_found', `No member with id or email "${ref}". Run "fluxmail members list" to see members.`);
}

export function listMembers(db: FluxmailDb): MemberInfo[] {
  return db
    .select()
    .from(members)
    .all()
    .map((row) => toInfo(db, row));
}

export function setMemberRole(db: FluxmailDb, ref: string, role: MemberRole): MemberInfo {
  const member = findMember(db, ref);
  if (member.role === 'admin' && role !== 'admin') assertNotLastActiveAdmin(db, member.id);
  db.update(members).set({ role }).where(eq(members.id, member.id)).run();
  return getMember(db, member.id);
}

function assertNotLastActiveAdmin(db: FluxmailDb, memberId: string): void {
  const activeAdmins = db
    .select()
    .from(members)
    .where(sql`${members.role} = 'admin' AND ${members.status} = 'active'`)
    .all();
  if (activeAdmins.length === 1 && activeAdmins[0]!.id === memberId) {
    throw new EmailError('invalid_request', 'The last active administrator cannot be changed or removed.');
  }
}

export function updateMember(
  db: FluxmailDb,
  ref: string,
  update: { name?: string; email?: string; role?: MemberRole; status?: MemberStatus },
): MemberInfo {
  const member = findMember(db, ref);
  const name = update.name?.trim();
  const email = update.email?.trim().toLowerCase();
  if (update.name !== undefined && !name) throw new EmailError('invalid_request', 'Member name cannot be empty');
  if (email && listMembers(db).some((candidate) => candidate.id !== member.id && candidate.email === email)) {
    throw new EmailError('invalid_request', `A member with email ${email} already exists`);
  }
  if (update.status === 'active' && member.status !== 'active') {
    const loginEmail = email ?? member.email;
    const credential = db.select().from(memberCredentials).where(eq(memberCredentials.memberId, member.id)).get();
    if (!loginEmail || !credential) {
      throw new EmailError('invalid_request', 'The member must have a login email and password before activation.');
    }
    assertMemberLimit(Math.max(listMembers(db).length - 1, 0), getEntitlements(db));
  }
  if (
    member.role === 'admin' &&
    member.status === 'active' &&
    (update.role === 'member' || update.status === 'pending' || update.status === 'suspended')
  ) {
    assertNotLastActiveAdmin(db, member.id);
  }
  db.transaction((tx) => {
    tx.update(members)
      .set({
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(update.role ? { role: update.role } : {}),
        ...(update.status ? { status: update.status } : {}),
      })
      .where(eq(members.id, member.id))
      .run();
    if (update.status === 'suspended') {
      tx.update(memberSessions)
        .set({ revokedAt: Date.now() })
        .where(sql`${memberSessions.memberId} = ${member.id} AND ${memberSessions.revokedAt} IS NULL`)
        .run();
      tx.delete(apiKeys).where(eq(apiKeys.memberId, member.id)).run();
      revokeMemberOAuthGrants(tx, member.id);
    }
  });
  return getMember(db, member.id);
}

/**
 * Delete a member after every mailbox they own has been reassigned or removed.
 * Their API keys and selected sharing grants are deleted by the transaction and
 * foreign-key cascades.
 */
export function removeMember(db: FluxmailDb, id: string): { name: string; revokedApiKeys: number } {
  const info = getMember(db, id);
  if (info.role === 'admin' && info.status === 'active') assertNotLastActiveAdmin(db, info.id);
  if (info.accountCount > 0) {
    throw new EmailError(
      'invalid_request',
      `${info.name} still owns ${info.accountCount} mailbox${info.accountCount === 1 ? '' : 'es'}. Reassign or remove ${
        info.accountCount === 1 ? 'it' : 'them'
      } first.`,
    );
  }
  db.transaction((tx) => {
    tx.delete(apiKeys).where(eq(apiKeys.memberId, id)).run();
    tx.delete(members).where(eq(members.id, id)).run();
    recordCapState(tx);
  });
  return { name: info.name, revokedApiKeys: info.apiKeyCount };
}
