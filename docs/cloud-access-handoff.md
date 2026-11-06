# Cloud access contract adoption

Use this prompt in fluxmailai/fluxmail-web after an `@fluxmail/core` release that includes `@fluxmail/core/access` is published:

> Adopt the shared access contract from `@fluxmail/core/access` in `services/cloud`. Bump the service's pinned `@fluxmail/core` (currently `0.24.0` in `services/cloud/package.json`) to the published release that exports `./access`. See `docs/access-contract.md` in fluxmailai/fluxmail for the rules.
>
> Cloud already follows the rules that apply to it, so this change adds a test and shared types and should not change behavior. Cloud offers the `owner` and `member` roles. Every mailbox is private to its owner, enforced by row-level security on `cloud.mailbox` (`shared OR owner_id = current user`). Keys belong to one user, with mail scopes and an optional `agent_key_mailbox` allowlist. Only the workspace owner manages invitations and members (`cloud.manage_member`, `cloud.manage_invitation`), the owner can't be removed, and removing a member cascades to their mailboxes and keys.
>
> Add an integration test under `services/cloud/src/__integration__/` that runs every case in `ACCESS_CONFORMANCE_CASES` whose `products` includes `'cloud'` against Postgres. For each case, insert the case's `world`: the owner member becomes the tenant (`tenant.id` is the owner's user id), the other members get `membership` rows with role `member`, each mailbox gets a `mailbox` row with `owner_id` and `shared = false` (Cloud cases use only private mailboxes), and each credential gets an `agent_key` row (`issuerId` is always null in Cloud cases) with `all_mailboxes` set when `mailboxIds` is null and `agent_key_mailbox` rows otherwise. Then run the action through Cloud's real paths:
>
> - `read_mailbox` and `credential_read_mailbox`: query `cloud.mailbox` under the user or key settings RLS uses (`cloud.user_id`, `cloud.key_id`, `cloud.key_hash`) and compare only whether the row is visible.
> - `see_mailbox_metadata`: the mailbox list the dashboard uses (`CloudStore.mailboxes`).
> - `manage_mailbox` and `change_mailbox_connection`: the mailbox removal and reconnect paths, as the acting user.
> - `connect_mailbox` and `issue_credential`: the connect and key-creation paths, as the acting user.
> - `manage_member` and `remove_member`: `cloud.manage_member` and the membership routes. Removal with `newOwnerId: null` must delete the member's mailboxes.
>
> Map each refusal to `ACCESS_DENIAL_REASONS` where Cloud returns an error, for example `Workspace owner required` to `missing_capability`, or to `owner_protected` when the target is the owner. Fail the test when a Cloud case has no runner, using `ACCESS_ACTION_TYPES`, so new shared actions can't be skipped silently.
>
> Import `MEMBER_ROLES`, `ADMIN_CAPABILITIES` and `AccessDenialReason` types where owner checks live instead of string literals, without changing messages or error codes. Don't add sharing, an `admin` role, ownership transfer or mailbox reassignment in this change. Cases for those are marked self-hosted only or have an empty `products` list. Leave the unused `mailbox.shared` column in place and note it in the PR as a follow-up decision: drop it, or replace it with the shared `MailboxAccess` model when Cloud ships owner-controlled sharing.
>
> No MCP tool, scope, preset or provider-adapter behavior changes. Run the integration suite against a local Postgres only.
