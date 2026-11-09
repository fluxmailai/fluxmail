import {
  canAssignRole,
  canChangeMailboxAccess,
  canChangeMailboxConnection,
  canConnectMailbox,
  canIssueCredential,
  canManageMailbox,
  canManageMember,
  canReassignMailbox,
  canRemoveMember,
  canSeeMailboxMetadata,
  canTransferOwnership,
  credentialCanReadMailbox,
  memberCanReadMailbox,
  type AccessCredential,
  type AccessDecision,
  type AccessDenialReason,
  type AccessMailbox,
  type AccessMember,
  type MailboxAccess,
  type MemberRole,
} from './rules.js';

export const ACCESS_PRODUCTS = ['self-hosted', 'cloud'] as const;
export type AccessProduct = (typeof ACCESS_PRODUCTS)[number];

/**
 * Members, mailboxes and credentials a product stores before running an action.
 * Every id a world refers to is defined in it, so a product can insert it under
 * its own foreign keys.
 */
export interface AccessWorld {
  members: readonly AccessMember[];
  mailboxes: readonly AccessMailbox[];
  credentials?: readonly AccessCredential[];
}

export type AccessAction =
  | { type: 'read_mailbox'; actorId: string; mailboxId: string }
  | { type: 'credential_read_mailbox'; credentialId: string; mailboxId: string }
  | { type: 'see_mailbox_metadata'; actorId: string; mailboxId: string }
  | { type: 'manage_mailbox'; actorId: string; mailboxId: string }
  | { type: 'change_mailbox_connection'; actorId: string; mailboxId: string }
  | { type: 'change_mailbox_access'; actorId: string; mailboxId: string; access: MailboxAccess }
  | { type: 'reassign_mailbox'; actorId: string; mailboxId: string; newOwnerId: string }
  | { type: 'connect_mailbox'; actorId: string; ownerId: string }
  | { type: 'issue_credential'; actorId: string; ownerId: string; mailboxIds: readonly string[] | null }
  | { type: 'manage_member'; actorId: string; targetId: string }
  | { type: 'remove_member'; actorId: string; targetId: string; newOwnerId: string | null }
  | { type: 'assign_role'; actorId: string; targetId: string; role: MemberRole }
  | { type: 'transfer_ownership'; actorId: string; targetId: string };

const ACTION_TYPES = {
  read_mailbox: true,
  credential_read_mailbox: true,
  see_mailbox_metadata: true,
  manage_mailbox: true,
  change_mailbox_connection: true,
  change_mailbox_access: true,
  reassign_mailbox: true,
  connect_mailbox: true,
  issue_credential: true,
  manage_member: true,
  remove_member: true,
  assign_role: true,
  transfer_ownership: true,
} as const satisfies Record<AccessAction['type'], true>;

/** Every action type, so products can check that they run each one. */
export const ACCESS_ACTION_TYPES = Object.keys(ACTION_TYPES) as AccessAction['type'][];

export interface AccessConformanceCase {
  name: string;
  /**
   * Products that offer this behavior and must pass the case. An empty list marks
   * a rule neither product offers yet, kept so a product that adds it inherits it.
   */
  products: readonly AccessProduct[];
  world: AccessWorld;
  action: AccessAction;
  /** `true`, or the reason it is refused. Read checks are refused with `no_mailbox_access`. */
  expected: true | AccessDenialReason;
}

/** Runs one action against the shared rules. Products run the same world and action against their storage. */
export function evaluateAccessAction(world: AccessWorld, action: AccessAction): AccessDecision {
  const findMember = (id: string) => world.members.find((member) => member.id === id);
  const mailbox = (id: string) => {
    const found = world.mailboxes.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Unknown mailbox "${id}" in access world.`);
    return found;
  };
  const member = (id: string) => {
    const found = findMember(id);
    if (!found) throw new Error(`Unknown member "${id}" in access world.`);
    return found;
  };
  const read = (allowed: boolean): AccessDecision =>
    allowed ? { allowed: true } : { allowed: false, reason: 'no_mailbox_access' };

  switch (action.type) {
    case 'read_mailbox':
      return read(memberCanReadMailbox(findMember(action.actorId), mailbox(action.mailboxId)));
    case 'credential_read_mailbox': {
      const credential = world.credentials?.find((candidate) => candidate.id === action.credentialId);
      if (!credential) throw new Error(`Unknown credential "${action.credentialId}" in access world.`);
      return read(credentialCanReadMailbox(credential, mailbox(action.mailboxId), findMember));
    }
    case 'see_mailbox_metadata':
      return canSeeMailboxMetadata(findMember(action.actorId), mailbox(action.mailboxId));
    case 'manage_mailbox':
      return canManageMailbox(findMember(action.actorId), mailbox(action.mailboxId));
    case 'change_mailbox_connection':
      return canChangeMailboxConnection(findMember(action.actorId), mailbox(action.mailboxId));
    case 'change_mailbox_access':
      return canChangeMailboxAccess(findMember(action.actorId), mailbox(action.mailboxId), action.access, findMember);
    case 'reassign_mailbox':
      return canReassignMailbox(findMember(action.actorId), mailbox(action.mailboxId), action.newOwnerId, findMember);
    case 'connect_mailbox':
      return canConnectMailbox(findMember(action.actorId), action.ownerId, findMember);
    case 'issue_credential':
      return canIssueCredential(
        findMember(action.actorId),
        action.ownerId,
        action.mailboxIds?.map((id) => mailbox(id)) ?? null,
        findMember,
      );
    case 'manage_member':
      return canManageMember(findMember(action.actorId), member(action.targetId));
    case 'remove_member':
      return canRemoveMember(findMember(action.actorId), member(action.targetId), action.newOwnerId, findMember);
    case 'assign_role':
      return canAssignRole(findMember(action.actorId), member(action.targetId), action.role);
    case 'transfer_ownership':
      return canTransferOwnership(findMember(action.actorId), member(action.targetId));
  }
}

// Fixtures. Cloud has one owner and members, with sharing but no admins or
// suspension. Self-hosted has admins and members, with suspension and sharing.
const active = (id: string, role: MemberRole): AccessMember => ({ id, role, status: 'active' });
const olivia = active('olivia', 'owner');
const ada = active('ada', 'admin');
const grace = active('grace', 'member');
const linus = active('linus', 'member');
const sam: AccessMember = { id: 'sam', role: 'member', status: 'suspended' };
const pat: AccessMember = { id: 'pat', role: 'member', status: 'pending' };
const suspendedAda: AccessMember = { id: 'ada', role: 'admin', status: 'suspended' };

const PRIVATE: MailboxAccess = { kind: 'private' };
const WORKSPACE: MailboxAccess = { kind: 'workspace' };
const box = (id: string, ownerId: string, access: MailboxAccess = PRIVATE): AccessMailbox => ({ id, ownerId, access });
const graceBox = box('grace-box', 'grace');
const linusBox = box('linus-box', 'linus');
const samBox = box('sam-box', 'sam');
const teamBox = box('team-box', 'grace', WORKSPACE);
const sharedWithLinus = box('linus-shared', 'grace', { kind: 'members', memberIds: ['linus'] });

// Cases both products must pass use only members, which both offer.
const common: AccessWorld = { members: [grace, linus], mailboxes: [graceBox, linusBox] };
const commonShared: AccessWorld = {
  members: [grace, linus],
  mailboxes: [graceBox, linusBox, teamBox, sharedWithLinus],
};
const cloud: AccessWorld = { members: [olivia, grace, linus], mailboxes: [graceBox, linusBox] };
const selfHostedMailboxes = [graceBox, linusBox, samBox, teamBox, sharedWithLinus];
const selfHosted: AccessWorld = { members: [ada, grace, linus, sam, pat], mailboxes: selfHostedMailboxes };
const adaSuspended: AccessWorld = { members: [suspendedAda, grace, linus, sam, pat], mailboxes: selfHostedMailboxes };
const withCredentials = (world: AccessWorld, credentials: AccessCredential[]): AccessWorld => ({
  ...world,
  credentials,
});
const key = (
  id: string,
  ownerId: string,
  issuerId: string | null,
  mailboxIds: string[] | null = null,
): AccessCredential => ({ id, ownerId, issuerId, mailboxIds });
const both: AccessProduct[] = ['self-hosted', 'cloud'];
const selfHostedOnly: AccessProduct[] = ['self-hosted'];
const cloudOnly: AccessProduct[] = ['cloud'];

export const ACCESS_CONFORMANCE_CASES: readonly AccessConformanceCase[] = [
  // Reading mail
  {
    name: 'an owner reads their private mailbox',
    products: both,
    world: common,
    action: { type: 'read_mailbox', actorId: 'grace', mailboxId: 'grace-box' },
    expected: true,
  },
  {
    name: 'a member cannot read another member’s private mailbox',
    products: both,
    world: common,
    action: { type: 'read_mailbox', actorId: 'linus', mailboxId: 'grace-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'the workspace owner cannot read a member’s private mailbox',
    products: cloudOnly,
    world: cloud,
    action: { type: 'read_mailbox', actorId: 'olivia', mailboxId: 'grace-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'an admin cannot read a member’s private mailbox',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'read_mailbox', actorId: 'ada', mailboxId: 'grace-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a mailbox shared with the workspace is readable by every active member',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'read_mailbox', actorId: 'ada', mailboxId: 'team-box' },
    expected: true,
  },
  {
    name: 'a member reads a mailbox shared with the workspace',
    products: both,
    world: commonShared,
    action: { type: 'read_mailbox', actorId: 'linus', mailboxId: 'team-box' },
    expected: true,
  },
  {
    name: 'a listed member reads a mailbox shared with them',
    products: both,
    world: commonShared,
    action: { type: 'read_mailbox', actorId: 'linus', mailboxId: 'linus-shared' },
    expected: true,
  },
  {
    name: 'an admin missing from the member list cannot read the mailbox',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'read_mailbox', actorId: 'ada', mailboxId: 'linus-shared' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a suspended owner cannot read their mailbox',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'read_mailbox', actorId: 'sam', mailboxId: 'sam-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a suspended member cannot read a workspace mailbox',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'read_mailbox', actorId: 'sam', mailboxId: 'team-box' },
    expected: 'no_mailbox_access',
  },

  // Credential reach
  {
    name: 'a member’s own key reaches their mailboxes',
    products: both,
    world: withCredentials(common, [key('grace-key', 'grace', null)]),
    action: { type: 'credential_read_mailbox', credentialId: 'grace-key', mailboxId: 'grace-box' },
    expected: true,
  },
  {
    name: 'a key cannot reach a mailbox left off its allowlist',
    products: both,
    world: withCredentials(common, [key('grace-key', 'grace', null, ['linus-box'])]),
    action: { type: 'credential_read_mailbox', credentialId: 'grace-key', mailboxId: 'grace-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a key cannot reach past its owner',
    products: both,
    world: withCredentials(common, [key('grace-key', 'grace', null)]),
    action: { type: 'credential_read_mailbox', credentialId: 'grace-key', mailboxId: 'linus-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a key an admin created for a member cannot reach that member’s private mailbox',
    products: selfHostedOnly,
    world: withCredentials(selfHosted, [key('issued', 'grace', 'ada')]),
    action: { type: 'credential_read_mailbox', credentialId: 'issued', mailboxId: 'grace-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a key an admin created for a member reaches mailboxes both can read',
    products: selfHostedOnly,
    world: withCredentials(selfHosted, [key('issued', 'grace', 'ada')]),
    action: { type: 'credential_read_mailbox', credentialId: 'issued', mailboxId: 'team-box' },
    expected: true,
  },
  {
    name: 'a key stops reaching a mailbox when its issuer is suspended',
    products: selfHostedOnly,
    world: withCredentials(adaSuspended, [key('issued', 'grace', 'ada')]),
    action: { type: 'credential_read_mailbox', credentialId: 'issued', mailboxId: 'team-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a member’s key reaches a mailbox shared with them',
    products: both,
    world: withCredentials(commonShared, [key('linus-key', 'linus', null)]),
    action: { type: 'credential_read_mailbox', credentialId: 'linus-key', mailboxId: 'linus-shared' },
    expected: true,
  },
  {
    name: 'a key stops working when its owner is suspended',
    products: selfHostedOnly,
    world: withCredentials(selfHosted, [key('sam-key', 'sam', null)]),
    action: { type: 'credential_read_mailbox', credentialId: 'sam-key', mailboxId: 'sam-box' },
    expected: 'no_mailbox_access',
  },

  // Mailbox metadata and settings
  {
    name: 'an admin sees a member’s mailbox metadata',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'see_mailbox_metadata', actorId: 'ada', mailboxId: 'grace-box' },
    expected: true,
  },
  {
    name: 'a member cannot see another member’s private mailbox metadata',
    products: both,
    world: common,
    action: { type: 'see_mailbox_metadata', actorId: 'linus', mailboxId: 'grace-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a member sees metadata for a mailbox shared with them',
    products: both,
    world: commonShared,
    action: { type: 'see_mailbox_metadata', actorId: 'linus', mailboxId: 'team-box' },
    expected: true,
  },
  {
    name: 'an owner manages their own mailbox',
    products: both,
    world: common,
    action: { type: 'manage_mailbox', actorId: 'grace', mailboxId: 'grace-box' },
    expected: true,
  },
  {
    name: 'an admin removes a member’s mailbox or edits its folders and senders',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'manage_mailbox', actorId: 'ada', mailboxId: 'grace-box' },
    expected: true,
  },
  {
    name: 'a member cannot manage another member’s mailbox',
    products: both,
    world: common,
    action: { type: 'manage_mailbox', actorId: 'linus', mailboxId: 'grace-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a member a mailbox is shared with cannot manage it',
    products: both,
    world: commonShared,
    action: { type: 'manage_mailbox', actorId: 'linus', mailboxId: 'linus-shared' },
    expected: 'missing_capability',
  },

  // Changing a mailbox's connection
  {
    name: 'an owner reauthorizes their mailbox',
    products: both,
    world: common,
    action: { type: 'change_mailbox_connection', actorId: 'grace', mailboxId: 'grace-box' },
    expected: true,
  },
  {
    name: 'a member cannot reauthorize another member’s private mailbox',
    products: both,
    world: common,
    action: { type: 'change_mailbox_connection', actorId: 'linus', mailboxId: 'grace-box' },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a member a mailbox is shared with cannot reauthorize it',
    products: both,
    world: commonShared,
    action: { type: 'change_mailbox_connection', actorId: 'linus', mailboxId: 'team-box' },
    expected: 'not_mailbox_owner',
  },
  {
    name: 'an admin cannot change a member’s mailbox server settings',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'change_mailbox_connection', actorId: 'ada', mailboxId: 'grace-box' },
    expected: 'not_mailbox_owner',
  },
  {
    name: 'an admin cannot reauthorize a suspended member’s mailbox',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'change_mailbox_connection', actorId: 'ada', mailboxId: 'sam-box' },
    expected: 'not_mailbox_owner',
  },

  // Changing who can read a mailbox
  {
    name: 'an owner shares their mailbox with the workspace',
    products: both,
    world: common,
    action: { type: 'change_mailbox_access', actorId: 'grace', mailboxId: 'grace-box', access: WORKSPACE },
    expected: true,
  },
  {
    name: 'an owner shares their mailbox with chosen members',
    products: both,
    world: common,
    action: {
      type: 'change_mailbox_access',
      actorId: 'grace',
      mailboxId: 'grace-box',
      access: { kind: 'members', memberIds: ['linus'] },
    },
    expected: true,
  },
  {
    name: 'an owner makes a shared mailbox private again',
    products: both,
    world: commonShared,
    action: { type: 'change_mailbox_access', actorId: 'grace', mailboxId: 'team-box', access: PRIVATE },
    expected: true,
  },
  {
    name: 'an owner cannot share their mailbox with someone outside the workspace',
    products: both,
    world: common,
    action: {
      type: 'change_mailbox_access',
      actorId: 'grace',
      mailboxId: 'grace-box',
      access: { kind: 'members', memberIds: ['linus', 'outsider'] },
    },
    expected: 'unknown_member',
  },
  {
    name: 'an admin cannot share a member’s mailbox with themselves',
    products: selfHostedOnly,
    world: selfHosted,
    action: {
      type: 'change_mailbox_access',
      actorId: 'ada',
      mailboxId: 'grace-box',
      access: { kind: 'members', memberIds: ['ada'] },
    },
    expected: 'not_mailbox_owner',
  },
  {
    name: 'an admin cannot share a member’s mailbox with a member they invited',
    products: selfHostedOnly,
    world: selfHosted,
    action: {
      type: 'change_mailbox_access',
      actorId: 'ada',
      mailboxId: 'grace-box',
      access: { kind: 'members', memberIds: ['pat'] },
    },
    expected: 'not_mailbox_owner',
  },
  {
    name: 'a member cannot share another member’s private mailbox',
    products: both,
    world: common,
    action: { type: 'change_mailbox_access', actorId: 'linus', mailboxId: 'grace-box', access: WORKSPACE },
    expected: 'no_mailbox_access',
  },
  {
    name: 'a member a mailbox is shared with cannot re-share it',
    products: both,
    world: commonShared,
    action: { type: 'change_mailbox_access', actorId: 'linus', mailboxId: 'linus-shared', access: WORKSPACE },
    expected: 'not_mailbox_owner',
  },
  {
    name: 'an admin cannot share a suspended member’s mailbox',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'change_mailbox_access', actorId: 'ada', mailboxId: 'sam-box', access: WORKSPACE },
    expected: 'not_mailbox_owner',
  },

  // Handing a mailbox to someone else
  {
    name: 'an owner hands their mailbox to another member',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'reassign_mailbox', actorId: 'grace', mailboxId: 'grace-box', newOwnerId: 'linus' },
    expected: true,
  },
  {
    name: 'an owner hands their mailbox to a member who has not enrolled',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'reassign_mailbox', actorId: 'grace', mailboxId: 'grace-box', newOwnerId: 'pat' },
    expected: true,
  },
  {
    name: 'a mailbox cannot go to a suspended member',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'reassign_mailbox', actorId: 'grace', mailboxId: 'grace-box', newOwnerId: 'sam' },
    expected: 'inactive_owner',
  },
  {
    name: 'an admin cannot take over an active member’s mailbox',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'reassign_mailbox', actorId: 'ada', mailboxId: 'grace-box', newOwnerId: 'ada' },
    expected: 'not_mailbox_owner',
  },
  {
    name: 'an admin cannot hand an active member’s mailbox to someone else',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'reassign_mailbox', actorId: 'ada', mailboxId: 'grace-box', newOwnerId: 'linus' },
    expected: 'not_mailbox_owner',
  },
  {
    name: 'an admin cannot take over a suspended member’s mailbox',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'reassign_mailbox', actorId: 'ada', mailboxId: 'sam-box', newOwnerId: 'ada' },
    expected: 'not_mailbox_owner',
  },

  // Connecting a mailbox
  {
    name: 'a member connects their own mailbox',
    products: both,
    world: common,
    action: { type: 'connect_mailbox', actorId: 'grace', ownerId: 'grace' },
    expected: true,
  },
  {
    name: 'an admin connects a mailbox for a member who has not enrolled',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'connect_mailbox', actorId: 'ada', ownerId: 'pat' },
    expected: true,
  },
  {
    name: 'an admin cannot connect a mailbox for a suspended member',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'connect_mailbox', actorId: 'ada', ownerId: 'sam' },
    expected: 'inactive_owner',
  },
  {
    name: 'a member cannot connect a mailbox for someone else',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'connect_mailbox', actorId: 'linus', ownerId: 'grace' },
    expected: 'missing_capability',
  },

  // Creating credentials
  {
    name: 'a member creates a key for themselves',
    products: both,
    world: common,
    action: { type: 'issue_credential', actorId: 'grace', ownerId: 'grace', mailboxIds: ['grace-box'] },
    expected: true,
  },
  {
    name: 'an admin cannot create a key for a mailbox they cannot read',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'issue_credential', actorId: 'ada', ownerId: 'grace', mailboxIds: ['grace-box'] },
    expected: 'outside_issuer_reach',
  },
  {
    name: 'an admin creates a key for a member on a mailbox both can read',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'issue_credential', actorId: 'ada', ownerId: 'grace', mailboxIds: ['team-box'] },
    expected: true,
  },
  {
    name: 'an admin cannot create a key for a suspended member',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'issue_credential', actorId: 'ada', ownerId: 'sam', mailboxIds: null },
    expected: 'inactive_owner',
  },
  {
    name: 'a member cannot create a key for someone else',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'issue_credential', actorId: 'linus', ownerId: 'grace', mailboxIds: null },
    expected: 'missing_capability',
  },

  // Managing members
  {
    name: 'an admin suspends a member',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'manage_member', actorId: 'ada', targetId: 'grace' },
    expected: true,
  },
  {
    name: 'a member cannot manage other members',
    products: both,
    world: common,
    action: { type: 'manage_member', actorId: 'linus', targetId: 'grace' },
    expected: 'missing_capability',
  },
  {
    name: 'a suspended admin cannot manage members',
    products: selfHostedOnly,
    world: adaSuspended,
    action: { type: 'manage_member', actorId: 'ada', targetId: 'grace' },
    expected: 'inactive_actor',
  },

  // Removing members
  {
    name: 'an admin removes a member and hands their mailboxes to a replacement who has not enrolled',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'remove_member', actorId: 'ada', targetId: 'sam', newOwnerId: 'pat' },
    expected: true,
  },
  {
    name: 'a removed member’s mailboxes cannot go back to that member',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'remove_member', actorId: 'ada', targetId: 'sam', newOwnerId: 'sam' },
    expected: 'inactive_owner',
  },
  {
    name: 'a removed member’s mailboxes cannot go to a suspended member',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'remove_member', actorId: 'ada', targetId: 'grace', newOwnerId: 'sam' },
    expected: 'inactive_owner',
  },
  {
    name: 'the workspace owner removes a member and their mailboxes',
    products: cloudOnly,
    world: cloud,
    action: { type: 'remove_member', actorId: 'olivia', targetId: 'grace', newOwnerId: null },
    expected: true,
  },
  {
    name: 'a member cannot remove other members',
    products: both,
    world: common,
    action: { type: 'remove_member', actorId: 'linus', targetId: 'grace', newOwnerId: null },
    expected: 'missing_capability',
  },
  {
    name: 'the workspace owner cannot be removed',
    products: cloudOnly,
    world: cloud,
    action: { type: 'remove_member', actorId: 'olivia', targetId: 'olivia', newOwnerId: null },
    expected: 'owner_protected',
  },
  {
    name: 'an admin cannot remove the workspace owner',
    products: [],
    world: { members: [olivia, ada], mailboxes: [] },
    action: { type: 'remove_member', actorId: 'ada', targetId: 'olivia', newOwnerId: 'ada' },
    expected: 'owner_protected',
  },

  // Roles and ownership
  {
    name: 'an admin promotes a member to admin',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'assign_role', actorId: 'ada', targetId: 'grace', role: 'admin' },
    expected: true,
  },
  {
    name: 'a member cannot promote themselves',
    products: selfHostedOnly,
    world: selfHosted,
    action: { type: 'assign_role', actorId: 'grace', targetId: 'grace', role: 'admin' },
    expected: 'missing_capability',
  },
  {
    name: 'nobody becomes the owner by a role change',
    products: [],
    world: { members: [olivia, grace], mailboxes: [] },
    action: { type: 'assign_role', actorId: 'olivia', targetId: 'grace', role: 'owner' },
    expected: 'owner_protected',
  },
  {
    name: 'the owner transfers ownership to an active member',
    products: [],
    world: { members: [olivia, grace], mailboxes: [] },
    action: { type: 'transfer_ownership', actorId: 'olivia', targetId: 'grace' },
    expected: true,
  },
  {
    name: 'an admin cannot transfer ownership',
    products: [],
    world: { members: [olivia, ada, grace], mailboxes: [] },
    action: { type: 'transfer_ownership', actorId: 'ada', targetId: 'grace' },
    expected: 'owner_protected',
  },
  {
    name: 'ownership cannot go to a member who has not enrolled',
    products: [],
    world: { members: [olivia, pat], mailboxes: [] },
    action: { type: 'transfer_ownership', actorId: 'olivia', targetId: 'pat' },
    expected: 'inactive_owner',
  },
];
