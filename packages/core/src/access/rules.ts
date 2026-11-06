/**
 * Member, mailbox and credential access rules shared by self-hosted Fluxmail and
 * Fluxmail Cloud. Pure functions with no storage: each product loads its own rows,
 * maps them to these types and asks for a decision.
 *
 * The promise both products keep: no workspace role can read another member's
 * private mail through Fluxmail, or give itself that ability. The one exception is
 * removing a member, which is permanent and hands their mailboxes to someone else.
 */

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Removed members are absent; a lookup for them returns undefined. Removal is
 * permanent: someone invited again gets a new member id.
 */
export const MEMBER_STATUSES = ['pending', 'active', 'suspended'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Workspace powers. None of them adds a mailbox to anyone's reach. */
export const ADMIN_CAPABILITIES = [
  'admin.accounts',
  'admin.members',
  'admin.api_keys',
  'admin.license',
  'admin.audit',
] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

/**
 * The workspace powers each role holds while active. An owner differs from an
 * admin only in that nobody can remove or demote the owner, and only the owner
 * can hand ownership to someone else.
 */
export const ROLE_CAPABILITIES: Readonly<Record<MemberRole, readonly AdminCapability[]>> = {
  owner: ADMIN_CAPABILITIES,
  admin: ADMIN_CAPABILITIES,
  member: [],
};

/** The role the previous owner takes, in the same change, when ownership moves. */
export const PREVIOUS_OWNER_ROLE: MemberRole = 'admin';

export interface AccessMember {
  id: string;
  role: MemberRole;
  status: MemberStatus;
}

export type MailboxAccess =
  | { kind: 'private' }
  /** Every active member, including members added later. */
  | { kind: 'workspace' }
  /** The owner plus these members. */
  | { kind: 'members'; memberIds: readonly string[] };

export interface AccessMailbox {
  id: string;
  ownerId: string;
  access: MailboxAccess;
}

/** An API key or OAuth grant. */
export interface AccessCredential {
  id: string;
  /** The member the credential acts as. */
  ownerId: string;
  /**
   * The member who created it, or null when the owner created it. A product must
   * revoke the credential when its issuer is removed: clearing the reference would
   * widen the credential to the owner's full reach.
   */
  issuerId: string | null;
  /** Mailbox allowlist, or null for every mailbox the credential can otherwise reach. */
  mailboxIds: readonly string[] | null;
}

export type MemberLookup = (memberId: string) => AccessMember | undefined;

export const ACCESS_DENIAL_REASONS = [
  /** The acting member is missing, pending or suspended. */
  'inactive_actor',
  'no_mailbox_access',
  'not_mailbox_owner',
  'missing_capability',
  /** The member who would own the mailbox or credential is missing or suspended. */
  'inactive_owner',
  /** A member named in a sharing list is not in the workspace. */
  'unknown_member',
  'outside_issuer_reach',
  /** Nobody can remove or demote the owner, and ownership moves only by transfer. */
  'owner_protected',
] as const;
export type AccessDenialReason = (typeof ACCESS_DENIAL_REASONS)[number];

export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessDenialReason };

const ALLOW: AccessDecision = Object.freeze({ allowed: true });
const deny = (reason: AccessDenialReason): AccessDecision => ({ allowed: false, reason });

export function isActive(member: AccessMember | undefined): member is AccessMember {
  return member?.status === 'active';
}

/**
 * Whether a member can be given a mailbox or a credential: active, or invited and
 * not enrolled yet.
 */
export function canHoldMailbox(member: AccessMember | undefined): member is AccessMember {
  return member !== undefined && member.status !== 'suspended';
}

/** Maps self-hosted's `sharedWithAll` and grant list, or Cloud's `shared` flag, to an access value. */
export function mailboxAccessFromFlags(sharedWithAll: boolean, memberIds: readonly string[] = []): MailboxAccess {
  if (sharedWithAll) return { kind: 'workspace' };
  return memberIds.length > 0 ? { kind: 'members', memberIds: [...memberIds] } : { kind: 'private' };
}

export function hasAdminCapability(member: AccessMember | undefined, capability: AdminCapability): boolean {
  return isActive(member) && ROLE_CAPABILITIES[member.role].includes(capability);
}

/** Reading depends only on ownership and sharing. Role never matters. */
export function memberCanReadMailbox(member: AccessMember | undefined, mailbox: AccessMailbox): boolean {
  if (!isActive(member)) return false;
  if (mailbox.ownerId === member.id) return true;
  switch (mailbox.access.kind) {
    case 'private':
      return false;
    case 'workspace':
      return true;
    case 'members':
      return mailbox.access.memberIds.includes(member.id);
  }
}

/**
 * A credential reaches mailboxes its owner can read, that its issuer can also
 * read, and that are on its allowlist. Checked on every request, so a credential
 * shrinks as soon as either member loses access.
 */
export function credentialCanReadMailbox(
  credential: AccessCredential,
  mailbox: AccessMailbox,
  findMember: MemberLookup,
): boolean {
  if (credential.mailboxIds !== null && !credential.mailboxIds.includes(mailbox.id)) return false;
  if (!memberCanReadMailbox(findMember(credential.ownerId), mailbox)) return false;
  if (credential.issuerId === null || credential.issuerId === credential.ownerId) return true;
  return memberCanReadMailbox(findMember(credential.issuerId), mailbox);
}

/** Address, provider, owner and status: for seat counts and offboarding, never content. */
export function canSeeMailboxMetadata(actor: AccessMember | undefined, mailbox: AccessMailbox): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (memberCanReadMailbox(actor, mailbox) || hasAdminCapability(actor, 'admin.accounts')) return ALLOW;
  return deny('no_mailbox_access');
}

/**
 * Remove a mailbox, change its folder mappings, or edit its allowed sender
 * addresses. None of these sends mail anywhere new, so admins may do them on any
 * mailbox.
 */
export function canManageMailbox(actor: AccessMember | undefined, mailbox: AccessMailbox): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (actor.id === mailbox.ownerId || hasAdminCapability(actor, 'admin.accounts')) return ALLOW;
  return deny('missing_capability');
}

/**
 * Reauthorize a mailbox or change its provider credentials or IMAP and SMTP
 * server settings. Whoever controls these controls where the mailbox's mail is
 * read from and sent through, so only the active owner may change them.
 */
export function canChangeMailboxConnection(actor: AccessMember | undefined, mailbox: AccessMailbox): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  return actor.id === mailbox.ownerId ? ALLOW : deny('not_mailbox_owner');
}

/**
 * Only the active owner decides who else can read a mailbox. Grantees cannot
 * re-share it, and every listed member must belong to the workspace.
 */
export function canChangeMailboxAccess(
  actor: AccessMember | undefined,
  mailbox: AccessMailbox,
  access: MailboxAccess,
  findMember: MemberLookup,
): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (actor.id !== mailbox.ownerId) return deny('not_mailbox_owner');
  if (access.kind === 'members' && access.memberIds.some((id) => findMember(id) === undefined)) {
    return deny('unknown_member');
  }
  return ALLOW;
}

/**
 * Only the active owner can hand a mailbox to another member. Admins move a
 * mailbox only by removing its owner with {@link canRemoveMember}, which is
 * permanent, so they cannot borrow a mailbox and quietly give it back.
 */
export function canReassignMailbox(
  actor: AccessMember | undefined,
  mailbox: AccessMailbox,
  newOwnerId: string,
  findMember: MemberLookup,
): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (actor.id !== mailbox.ownerId) return deny('not_mailbox_owner');
  return canHoldMailbox(findMember(newOwnerId)) ? ALLOW : deny('inactive_owner');
}

/**
 * Whoever supplies a new mailbox's provider credentials can choose its owner and
 * initial access: they already hold the credentials, so this grants nothing new.
 * Connecting for someone else needs `admin.accounts` and an owner who is active or
 * has not enrolled yet.
 */
export function canConnectMailbox(
  actor: AccessMember | undefined,
  ownerId: string,
  findMember: MemberLookup,
): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (actor.id === ownerId) return ALLOW;
  if (!hasAdminCapability(actor, 'admin.accounts')) return deny('missing_capability');
  return canHoldMailbox(findMember(ownerId)) ? ALLOW : deny('inactive_owner');
}

/**
 * Members create credentials for themselves. An admin can create one for another
 * active member only when its allowlist stays inside mailboxes the admin can read.
 * A credential without an allowlist is still limited to the issuer's reach at
 * request time by {@link credentialCanReadMailbox}.
 */
export function canIssueCredential(
  actor: AccessMember | undefined,
  ownerId: string,
  mailboxes: readonly AccessMailbox[] | null,
  findMember: MemberLookup,
): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (actor.id === ownerId) return ALLOW;
  if (!hasAdminCapability(actor, 'admin.api_keys')) return deny('missing_capability');
  if (!isActive(findMember(ownerId))) return deny('inactive_owner');
  if (mailboxes?.some((mailbox) => !memberCanReadMailbox(actor, mailbox))) return deny('outside_issuer_reach');
  return ALLOW;
}

/** Suspend, reactivate, reset a password, or list and revoke sessions. */
export function canManageMember(actor: AccessMember | undefined, target: AccessMember): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (target.role === 'owner') return deny('owner_protected');
  return hasAdminCapability(actor, 'admin.members') ? ALLOW : deny('missing_capability');
}

/**
 * Remove a member permanently. Their mailboxes go to `newOwnerId` in the same
 * change, or are deleted when it is null. Credentials they own or issued are
 * revoked. This is the only way an admin can move another member's mailbox.
 */
export function canRemoveMember(
  actor: AccessMember | undefined,
  target: AccessMember,
  newOwnerId: string | null,
  findMember: MemberLookup,
): AccessDecision {
  const managed = canManageMember(actor, target);
  if (!managed.allowed || newOwnerId === null) return managed;
  if (newOwnerId === target.id || !canHoldMailbox(findMember(newOwnerId))) return deny('inactive_owner');
  return ALLOW;
}

/**
 * Change a member's role between admin and member. Nobody can make someone the
 * owner this way; use {@link canTransferOwnership}.
 */
export function canAssignRole(actor: AccessMember | undefined, target: AccessMember, role: MemberRole): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (role === 'owner') return deny('owner_protected');
  return canManageMember(actor, target);
}

/**
 * The owner hands ownership to another active member. In the same change the
 * product makes the target the owner and moves the previous owner to
 * {@link PREVIOUS_OWNER_ROLE}, so a workspace never has two owners.
 */
export function canTransferOwnership(actor: AccessMember | undefined, target: AccessMember): AccessDecision {
  if (!isActive(actor)) return deny('inactive_actor');
  if (actor.role !== 'owner' || actor.id === target.id) return deny('owner_protected');
  return isActive(target) ? ALLOW : deny('inactive_owner');
}
