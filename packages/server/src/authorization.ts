import { EmailError, type Account, type EmailErrorCode } from '@fluxmail/core';
import {
  canChangeMailboxConnection,
  canManageMailbox,
  mailboxAccessFromFlags,
  memberCanReadMailbox,
  type AccessDecision,
  type AccessDenialReason,
  type AccessMailbox,
  type AccessMember,
} from '@fluxmail/core/access';
import type { Principal } from './auth.js';
import { hasCapability, type AdminCapability, type Capability } from './permissions.js';

type AccountAccessFields = Pick<Account, 'id' | 'ownerMemberId' | 'sharedWithAll' | 'grantedMemberIds'>;

/** The shared access contract's view of a mailbox. */
export function accessMailbox(account: AccountAccessFields): AccessMailbox {
  return {
    id: account.id,
    ownerId: account.ownerMemberId,
    access: mailboxAccessFromFlags(account.sharedWithAll, account.grantedMemberIds),
  };
}

/**
 * The shared access contract's view of the caller. Authentication already rejects
 * members who aren't active. A credential counts as an admin only for decisions
 * that need a capability it holds.
 */
export function accessActor(principal: Principal, capability?: AdminCapability): AccessMember {
  const admin = capability ? canAdminister(principal, capability) : principal.role === 'admin';
  return { id: principal.memberId, role: admin ? 'admin' : 'member', status: 'active' };
}

/**
 * Whether the mailbox is owned by, shared with, or granted to the member. Callers
 * pass an authenticated member, and authentication already rejects members who
 * aren't active.
 */
export function memberCanAccessAccount(memberId: string, account: AccountAccessFields): boolean {
  return memberCanReadMailbox({ id: memberId, role: 'member', status: 'active' }, accessMailbox(account));
}

/**
 * A key created by someone other than its owner reaches only mailboxes both can
 * read. Authentication rejects the key while its issuer isn't active.
 */
export function canAccessAccount(principal: Principal, account: Account): boolean {
  if (principal.accountIds !== null && !principal.accountIds.includes(account.id)) return false;
  if (!memberCanAccessAccount(principal.memberId, account)) return false;
  const issuerId = delegatingIssuer(principal);
  return issuerId === null || memberCanAccessAccount(issuerId, account);
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

/**
 * Throws unless the caller may remove the mailbox or edit its folder mappings or
 * allowed sender addresses. A caller who can't see the mailbox gets "not found".
 */
export function requireManageAccount(principal: Principal, account: AccountAccessFields, message: string): void {
  requireAccess(canManageMailbox(accessActor(principal, 'admin.accounts'), accessMailbox(account)), {
    missing_capability: message,
  });
}

/**
 * The member who created the calling key for its owner, or null when the caller
 * is the owner's own session, key or OAuth connection. A key someone else created
 * reaches only mailboxes both can read, and can't act as the owner.
 */
export function delegatingIssuer(principal: Principal): string | null {
  return principal.kind === 'api_key' && principal.issuerId !== principal.memberId ? principal.issuerId : null;
}

const DELEGATED_OWNER_ACTION =
  'A key someone else created for you cannot change who can access a mailbox, hand it over, or change its connection.';

/**
 * Owner-only mailbox changes: sharing, handing it over, and its connection. A key
 * someone else created for the owner is refused, because it would otherwise let
 * its creator act as the owner.
 */
export function requireOwnerAction(principal: Principal): void {
  if (delegatingIssuer(principal) !== null) {
    throw new EmailError('permission_denied', DELEGATED_OWNER_ACTION, { accessReason: 'not_mailbox_owner' });
  }
}

/**
 * Throws unless the caller may reauthorize the mailbox or change its server settings.
 * Set `byAddress` when the mailbox was found by the address the caller is connecting.
 * They named that address themselves, so a mailbox they can't see is refused as
 * another member's instead of reported missing.
 */
export function requireConnectionChange(
  principal: Principal,
  account: AccountAccessFields,
  { byAddress = false }: { byAddress?: boolean } = {},
): void {
  requireOwnerAction(principal);
  const decision = canChangeMailboxConnection(accessActor(principal), accessMailbox(account));
  const hidden = !decision.allowed && decision.reason === 'no_mailbox_access';
  requireAccess(byAddress && hidden ? { allowed: false, reason: 'not_mailbox_owner' } : decision, {
    not_mailbox_owner: 'Only the mailbox owner can reauthorize it or change its server settings.',
  });
}

/** The error code each refusal reason surfaces as. */
export const ACCESS_DENIAL_ERROR_CODES: Readonly<Record<AccessDenialReason, EmailErrorCode>> = {
  inactive_actor: 'permission_denied',
  no_mailbox_access: 'not_found',
  not_mailbox_owner: 'permission_denied',
  missing_capability: 'permission_denied',
  inactive_owner: 'invalid_request',
  unknown_member: 'invalid_request',
  outside_issuer_reach: 'permission_denied',
  owner_protected: 'permission_denied',
};

const ACCESS_DENIAL_MESSAGES: Readonly<Record<AccessDenialReason, string>> = {
  inactive_actor: 'Your membership is not active.',
  no_mailbox_access: 'Mailbox not found.',
  not_mailbox_owner: 'Only the mailbox owner can do this.',
  missing_capability: 'Administrator access is required.',
  inactive_owner: 'That member is suspended or no longer in this instance.',
  unknown_member: 'Every member a mailbox is shared with must belong to this instance.',
  outside_issuer_reach: 'You can only create keys for mailboxes you can read yourself.',
  owner_protected: 'The owner cannot be changed this way.',
};

/** Throws the EmailError for a refused decision. `messages` overrides the default wording. */
export function requireAccess(
  decision: AccessDecision,
  messages: Partial<Record<AccessDenialReason, string>> = {},
): void {
  if (decision.allowed) return;
  const { reason } = decision;
  throw new EmailError(ACCESS_DENIAL_ERROR_CODES[reason], messages[reason] ?? ACCESS_DENIAL_MESSAGES[reason], {
    accessReason: reason,
  });
}
