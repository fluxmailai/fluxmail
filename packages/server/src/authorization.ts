import type { Account } from '@fluxmail/core';
import { mailboxAccessFromFlags, memberCanReadMailbox } from '@fluxmail/core/access';
import type { Principal } from './auth.js';
import { hasCapability, type AdminCapability, type Capability } from './permissions.js';

type AccountAccessFields = Pick<Account, 'id' | 'ownerMemberId' | 'sharedWithAll' | 'grantedMemberIds'>;

/**
 * Whether the mailbox is owned by, shared with, or granted to the member. Callers
 * pass an authenticated member, and authentication already rejects members who
 * aren't active.
 */
export function memberCanAccessAccount(memberId: string, account: AccountAccessFields): boolean {
  return memberCanReadMailbox(
    { id: memberId, role: 'member', status: 'active' },
    {
      id: account.id,
      ownerId: account.ownerMemberId,
      access: mailboxAccessFromFlags(account.sharedWithAll, account.grantedMemberIds),
    },
  );
}

export function canAccessAccount(principal: Principal, account: Account): boolean {
  return (
    memberCanAccessAccount(principal.memberId, account) &&
    (principal.accountIds === null || principal.accountIds.includes(account.id))
  );
}

export function canSeeAccountMetadata(principal: Principal, account: Account): boolean {
  if (canAccessAccount(principal, account)) return true;
  return (
    canAdminister(principal, 'admin.accounts') &&
    (principal.accountIds === null || principal.accountIds.includes(account.id))
  );
}

export function allowsCapability(principal: Principal, capability: Capability): boolean {
  return principal.kind === 'session' || hasCapability(principal.permissions, capability);
}

export function canAdminister(principal: Principal, capability: AdminCapability): boolean {
  // OAuth grants only carry mail scopes, whatever the approving member's role.
  if (principal.kind === 'oauth') return false;
  return (
    principal.role === 'admin' && (principal.kind === 'session' || hasCapability(principal.permissions, capability))
  );
}

export function canManageOwnedAccount(principal: Principal, account: Account): boolean {
  return principal.role === 'admin' || account.ownerMemberId === principal.memberId;
}
