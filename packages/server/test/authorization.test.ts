import { describe, expect, it } from 'vitest';
import type { Account } from '@fluxmail/core';
import { GMAIL_CAPABILITIES } from '@fluxmail/provider-gmail';
import type { Principal } from '../src/auth.js';
import { canAccessAccount, canAdminister, canSeeAccountMetadata } from '../src/authorization.js';
import { customPermissionPolicy, FULL_PERMISSION_POLICY } from '../src/permissions.js';

const privateAccount: Account = {
  id: 'acct_private',
  provider: 'gmail',
  email: 'owner@example.com',
  status: 'active',
  capabilities: GMAIL_CAPABILITIES,
  ownerMemberId: 'member_owner',
  sharedWithAll: false,
  grantedMemberIds: ['member_granted'],
};

function session(memberId: string, role: 'admin' | 'member' = 'member'): Principal {
  return {
    kind: 'session',
    principalId: `session_${memberId}`,
    sessionId: `session_${memberId}`,
    memberId,
    role,
    permissions: FULL_PERMISSION_POLICY,
    accountIds: null,
  };
}

function key(
  memberId: string,
  role: 'admin' | 'member' = 'member',
  accountIds: string[] | null = null,
  capabilities = ['mail.read'],
): Principal {
  return {
    kind: 'api_key',
    issuerId: null,
    principalId: `key_${memberId}`,
    keyId: `key_${memberId}`,
    memberId,
    role,
    permissions: customPermissionPolicy(capabilities),
    accountIds,
  };
}

describe('centralized account policy', () => {
  it('allows owners and explicit grants while denying unrelated members', () => {
    expect(canAccessAccount(session('member_owner'), privateAccount)).toBe(true);
    expect(canAccessAccount(session('member_granted'), privateAccount)).toBe(true);
    expect(canAccessAccount(session('member_unrelated'), privateAccount)).toBe(false);
  });

  it('shares with current and future members when sharedWithAll is enabled', () => {
    const shared = { ...privateAccount, sharedWithAll: true, grantedMemberIds: [] };
    expect(canAccessAccount(session('member_current'), shared)).toBe(true);
    expect(canAccessAccount(session('member_created_later'), shared)).toBe(true);
  });

  it('lets administrators inspect metadata without granting mailbox content', () => {
    const admin = session('member_admin', 'admin');
    expect(canSeeAccountMetadata(admin, privateAccount)).toBe(true);
    expect(canAccessAccount(admin, privateAccount)).toBe(false);

    const mailOnlyKey = key('member_admin', 'admin', null, ['mail.read']);
    expect(canSeeAccountMetadata(mailOnlyKey, privateAccount)).toBe(false);

    const accountAdminKey = key('member_admin', 'admin', null, ['mail.read', 'admin.accounts']);
    expect(canSeeAccountMetadata(accountAdminKey, privateAccount)).toBe(true);
    expect(canSeeAccountMetadata(key('member_admin', 'admin', [], ['admin.accounts']), privateAccount)).toBe(false);
  });

  it('intersects API-key mailbox allowlists with the owner’s current access', () => {
    expect(canAccessAccount(key('member_granted', 'member', ['acct_private']), privateAccount)).toBe(true);
    expect(canAccessAccount(key('member_granted', 'member', []), privateAccount)).toBe(false);
    expect(canAccessAccount(key('member_unrelated', 'member', ['acct_private']), privateAccount)).toBe(false);
  });

  it('requires both a live admin role and an explicit admin API-key capability', () => {
    expect(canAdminister(session('member_admin', 'admin'), 'admin.members')).toBe(true);
    expect(canAdminister(key('member_admin', 'admin', null, ['mail.read']), 'admin.members')).toBe(false);
    expect(canAdminister(key('member_admin', 'admin', null, ['mail.read', 'admin.members']), 'admin.members')).toBe(
      true,
    );
    expect(canAdminister(key('member_admin', 'member', null, ['mail.read', 'admin.members']), 'admin.members')).toBe(
      false,
    );
  });
});
