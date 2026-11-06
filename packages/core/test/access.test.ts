import { describe, expect, it } from 'vitest';
import {
  ACCESS_ACTION_TYPES,
  ACCESS_CONFORMANCE_CASES,
  ACCESS_DENIAL_REASONS,
  ACCESS_PRODUCTS,
  ADMIN_CAPABILITIES,
  MEMBER_ROLES,
  PREVIOUS_OWNER_ROLE,
  ROLE_CAPABILITIES,
  credentialCanReadMailbox,
  evaluateAccessAction,
  hasAdminCapability,
  mailboxAccessFromFlags,
  memberCanReadMailbox,
  type AccessAction,
  type AccessMailbox,
  type AccessMember,
  type AccessWorld,
} from '../src/access/index.js';

/** Every id the world or action names, so a product can store the world under its foreign keys. */
function unknownIds(world: AccessWorld, action: AccessAction): string[] {
  const members = new Set(world.members.map((member) => member.id));
  const mailboxes = new Set(world.mailboxes.map((mailbox) => mailbox.id));
  const credentials = new Set(world.credentials?.map((credential) => credential.id));
  const missing: string[] = [];
  const need = (set: Set<string>, id: string | null | undefined, label: string) => {
    if (id != null && !set.has(id)) missing.push(`${label} ${id}`);
  };
  for (const mailbox of world.mailboxes) {
    need(members, mailbox.ownerId, 'owner');
    if (mailbox.access.kind === 'members') for (const id of mailbox.access.memberIds) need(members, id, 'grantee');
  }
  for (const credential of world.credentials ?? []) {
    need(members, credential.ownerId, 'credential owner');
    need(members, credential.issuerId, 'credential issuer');
    for (const id of credential.mailboxIds ?? []) need(mailboxes, id, 'allowlisted mailbox');
  }
  const fields = action as Partial<Record<string, unknown>>;
  for (const field of ['actorId', 'targetId', 'ownerId', 'newOwnerId'] as const) {
    need(members, fields[field] as string | null | undefined, field);
  }
  need(mailboxes, fields.mailboxId as string | undefined, 'mailboxId');
  need(credentials, fields.credentialId as string | undefined, 'credentialId');
  if (action.type === 'issue_credential') for (const id of action.mailboxIds ?? []) need(mailboxes, id, 'mailboxIds');
  return missing;
}

describe('shared access conformance cases', () => {
  it.each(ACCESS_CONFORMANCE_CASES.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const expected = testCase.expected === true ? { allowed: true } : { allowed: false, reason: testCase.expected };
    expect(evaluateAccessAction(testCase.world, testCase.action)).toEqual(expected);
  });

  it('names each case once and lists only known products', () => {
    const names = ACCESS_CONFORMANCE_CASES.map((testCase) => testCase.name);
    expect(new Set(names).size).toBe(names.length);
    for (const testCase of ACCESS_CONFORMANCE_CASES) {
      for (const product of testCase.products) expect(ACCESS_PRODUCTS, testCase.name).toContain(product);
    }
  });

  it('covers every action and every refusal reason', () => {
    const actions = new Set(ACCESS_CONFORMANCE_CASES.map((testCase) => testCase.action.type));
    expect([...actions].sort()).toEqual([...ACCESS_ACTION_TYPES].sort());
    const reasons = new Set(ACCESS_CONFORMANCE_CASES.map((testCase) => testCase.expected));
    for (const reason of ACCESS_DENIAL_REASONS) expect(reasons, reason).toContain(reason);
  });

  it('defines every id a world or action names', () => {
    for (const testCase of ACCESS_CONFORMANCE_CASES) {
      expect(unknownIds(testCase.world, testCase.action), testCase.name).toEqual([]);
      const ids = testCase.world.members.map((member) => member.id);
      expect(new Set(ids).size, testCase.name).toBe(ids.length);
    }
    const orphaned: AccessWorld = {
      members: [],
      mailboxes: [{ id: 'box', ownerId: 'removed', access: { kind: 'private' } }],
      credentials: [{ id: 'key', ownerId: 'removed', issuerId: null, mailboxIds: ['missing'] }],
    };
    expect(unknownIds(orphaned, { type: 'read_mailbox', actorId: 'nobody', mailboxId: 'box' })).toEqual([
      'owner removed',
      'credential owner removed',
      'allowlisted mailbox missing',
      'actorId nobody',
    ]);
  });

  it('gives each product cases that allow and cases that refuse', () => {
    for (const product of ACCESS_PRODUCTS) {
      const cases = ACCESS_CONFORMANCE_CASES.filter((testCase) => testCase.products.includes(product));
      expect(
        cases.some((testCase) => testCase.expected === true),
        product,
      ).toBe(true);
      expect(
        cases.some((testCase) => testCase.expected !== true),
        product,
      ).toBe(true);
    }
  });

  it('only uses roles each product offers', () => {
    const offered = { 'self-hosted': ['admin', 'member'], cloud: ['owner', 'member'] } as const;
    for (const testCase of ACCESS_CONFORMANCE_CASES) {
      for (const product of testCase.products) {
        for (const member of testCase.world.members) {
          expect(offered[product], `${testCase.name} (${product})`).toContain(member.role);
        }
      }
    }
  });

  it('rejects worlds that name unknown mailboxes, members or credentials', () => {
    const world = { members: [], mailboxes: [] };
    expect(() => evaluateAccessAction(world, { type: 'read_mailbox', actorId: 'a', mailboxId: 'missing' })).toThrow(
      /Unknown mailbox/,
    );
    expect(() => evaluateAccessAction(world, { type: 'manage_member', actorId: 'a', targetId: 'missing' })).toThrow(
      /Unknown member/,
    );
    expect(() =>
      evaluateAccessAction(world, { type: 'credential_read_mailbox', credentialId: 'missing', mailboxId: 'x' }),
    ).toThrow(/Unknown credential/);
  });
});

describe('access rules', () => {
  const privateBox: AccessMailbox = { id: 'box', ownerId: 'owner', access: { kind: 'private' } };

  it('never lets a role read a private mailbox it does not own', () => {
    for (const role of MEMBER_ROLES) {
      const member: AccessMember = { id: 'someone', role, status: 'active' };
      expect(memberCanReadMailbox(member, privateBox), role).toBe(false);
    }
  });

  it('gives workspace powers only to active owners and admins', () => {
    expect(ROLE_CAPABILITIES.member).toEqual([]);
    for (const capability of ADMIN_CAPABILITIES) {
      expect(hasAdminCapability({ id: 'a', role: 'admin', status: 'active' }, capability)).toBe(true);
      expect(hasAdminCapability({ id: 'o', role: 'owner', status: 'active' }, capability)).toBe(true);
      expect(hasAdminCapability({ id: 'a', role: 'admin', status: 'suspended' }, capability)).toBe(false);
      expect(hasAdminCapability({ id: 'a', role: 'admin', status: 'pending' }, capability)).toBe(false);
      expect(hasAdminCapability(undefined, capability)).toBe(false);
    }
  });

  it('refuses a credential whose issuer was removed', () => {
    const shared: AccessMailbox = { id: 'box', ownerId: 'owner', access: { kind: 'workspace' } };
    const owner: AccessMember = { id: 'owner', role: 'member', status: 'active' };
    const credential = { id: 'key', ownerId: 'owner', issuerId: 'removed', mailboxIds: null };
    expect(credentialCanReadMailbox(credential, shared, (id) => (id === 'owner' ? owner : undefined))).toBe(false);
  });

  it('moves the previous owner to a role that keeps workspace powers', () => {
    expect(PREVIOUS_OWNER_ROLE).not.toBe('owner');
    expect(ROLE_CAPABILITIES[PREVIOUS_OWNER_ROLE]).toEqual(ADMIN_CAPABILITIES);
  });

  it('maps product sharing flags to an access value', () => {
    expect(mailboxAccessFromFlags(false)).toEqual({ kind: 'private' });
    expect(mailboxAccessFromFlags(false, [])).toEqual({ kind: 'private' });
    expect(mailboxAccessFromFlags(false, ['a'])).toEqual({ kind: 'members', memberIds: ['a'] });
    expect(mailboxAccessFromFlags(true, ['a'])).toEqual({ kind: 'workspace' });
    const ids = ['a'];
    const access = mailboxAccessFromFlags(false, ids);
    ids.push('b');
    expect(access).toEqual({ kind: 'members', memberIds: ['a'] });
  });
});
