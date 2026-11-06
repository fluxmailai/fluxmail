# Shared access contract

Self-hosted Fluxmail and Fluxmail Cloud follow the same rules for member roles, mailbox access and credential reach. `@fluxmail/core/access` holds those rules as pure functions with no storage and no runtime dependencies. Each product loads its own members, mailboxes and credentials, maps them to the contract types, and either calls the functions or enforces the same rules in its own layer. Cloud enforces mailbox reads in Postgres row-level security.

No workspace role can read another member's private mail through Fluxmail or give itself that ability. The one exception is removing a member, which is permanent and hands their mailboxes to someone else. A self-hosted server operator can still read stored credentials from the data directory and encryption key, which is outside what the contract can enforce.

## Vocabulary

- `MEMBER_ROLES`: `owner`, `admin` and `member`. Self-hosted offers `admin` and `member`. Cloud offers `owner` and `member`.
- `MEMBER_STATUSES`: `pending`, `active` and `suspended`. A removed member is absent, so a lookup returns `undefined`. Removal is permanent: someone invited again gets a new member id.
- `ADMIN_CAPABILITIES` and `ROLE_CAPABILITIES`: the workspace powers each active role holds. Owners and admins hold all five. An owner can't be removed or demoted, and ownership moves only by transfer. The previous owner becomes `PREVIOUS_OWNER_ROLE` (`admin`) in the same change, so a workspace never has two owners.
- `MailboxAccess`: `private`, `workspace` (every active member) or `members` (the owner plus listed members). `mailboxAccessFromFlags` maps self-hosted's `sharedWithAll` and grant list, or Cloud's `shared` flag.
- `AccessCredential`: an API key or OAuth grant with its owner, the member who issued it (`null` when the owner did) and an optional mailbox allowlist.

## Rules

| Function                     | Allows                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `memberCanReadMailbox`       | An active member who owns the mailbox, or with whom it is shared. Role never matters.                                                   |
| `credentialCanReadMailbox`   | Mailboxes on the allowlist that the owner can read and, for a credential someone else issued, that the issuer can also read.            |
| `canSeeMailboxMetadata`      | Members who can read the mailbox, and holders of `admin.accounts`.                                                                      |
| `canManageMailbox`           | The owner and holders of `admin.accounts`, for removing a mailbox and editing its folder mappings or allowed sender addresses.          |
| `canChangeMailboxConnection` | The active owner only, for reauthorizing and changing provider credentials or IMAP and SMTP server settings.                            |
| `canChangeMailboxAccess`     | The active owner only, sharing with members of the workspace. A member the mailbox is shared with can't re-share it.                    |
| `canReassignMailbox`         | The active owner only, to a member who is active or hasn't enrolled.                                                                    |
| `canConnectMailbox`          | Any active member for themselves. A holder of `admin.accounts` for a member who is active or hasn't enrolled.                           |
| `canIssueCredential`         | Any active member for themselves. A holder of `admin.api_keys` for another active member, with an allowlist the issuer can read.        |
| `canManageMember`            | Holders of `admin.members`, for anyone except the owner: suspend, reactivate, reset a password, and list or revoke sessions.            |
| `canRemoveMember`            | Holders of `admin.members`, for anyone except the owner. The member's mailboxes go to another member who can hold them, or are deleted. |
| `canAssignRole`              | Holders of `admin.members`, between `admin` and `member`.                                                                               |
| `canTransferOwnership`       | The owner, to another active member.                                                                                                    |

Refusals return one of `ACCESS_DENIAL_REASONS`. The reasons are stable, so products can map them to error messages and use them as telemetry enum values.

Products apply some rules as part of a larger change:

- Server settings decide where a mailbox's mail is read from and sent through, so changing them would let an admin intercept mail. That is why `canChangeMailboxConnection` is owner-only while `canManageMailbox` is open to admins.
- Removing a member moves or deletes all of their mailboxes in the same change, and revokes the credentials they own or issued. Self-hosted moves them to the member the admin names. Cloud deletes them. Removing a member is the only way an admin can move someone else's mailbox, and it can't be undone, so an admin can't borrow a mailbox and give it back.
- A credential whose issuer is removed must be revoked. Clearing the issuer reference would widen the credential to its owner's full reach.
- A credential someone else issued can't do what only the owner may do: change who can read a mailbox, hand it over, or change its connection. A credential it creates keeps the original issuer, so it can't reach further than the credential that made it.

## Conformance cases

`ACCESS_CONFORMANCE_CASES` lists each rule as a world of members, mailboxes and credentials, an action, and the expected result. The cases include the known workarounds: an admin sharing a mailbox with themselves or with a member they invited, taking over a suspended member's mailbox, changing a member's server settings, a member re-sharing a mailbox shared with them, and a key an admin creates in another member's name.

Each case lists the products that must pass it. A case with an empty list describes a rule neither product offers yet, such as an admin alongside an owner. A product that adds the feature turns those cases on. `evaluateAccessAction` runs a case against the core functions. `packages/core/test/access.test.ts` checks every case. It fails when an action type in `ACCESS_ACTION_TYPES` or a refusal reason has no case, or when a world names a member, mailbox or credential it doesn't define, so a product can store every world under its foreign keys.

Each product must run the cases for its name against its real implementation:

- Self-hosted sets up each world in a test database and calls its authorization helpers and REST routes.
- Cloud sets up each world in Postgres and runs the actions through row-level security and its SQL functions.

Read checks compare only whether access is allowed, because Cloud's row-level security hides a mailbox without giving a reason. Other actions compare the refusal reason wherever the product returns one.

## Changing the contract

Changing a rule, a case or the vocabulary affects Cloud. Release a new `@fluxmail/core` version and tell the Cloud maintainers so Cloud can bump its pin and pass its conformance test. See [the Cloud adoption prompt](cloud-access-handoff.md) for the first adoption. A change that adds a case for a product that doesn't pass it yet ships with that product's fix.
