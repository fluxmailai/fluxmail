import type { Account } from '@fluxmail/core';
import type { Principal } from './auth.js';
import { hasCapability, type AdminCapability, type Capability } from './permissions.js';

/** Whether the mailbox is owned by, shared with, or granted to the member. */
export function memberCanAccessAccount(memberId: string, account: Account): boolean {
  return account.ownerMemberId === memberId || account.sharedWithAll || account.grantedMemberIds.includes(memberId);
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
