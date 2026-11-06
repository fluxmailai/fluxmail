---
title: 'Teams & plans'
description: 'Add members, set mailbox access, and raise the limits on a self-hosted Fluxmail instance.'
updated: '2026-11-06'
---

## Members and mailbox access

Every Fluxmail instance has at least one **member**. A personal instance uses one member to identify its owner. Business and Enterprise instances can add more people and decide which mailboxes each person can reach.

```bash
# A fresh instance starts with one logged-in administrator
fluxmail setup --name "Ada Lovelace" --email ada@example.com

# Administrators invite more people
fluxmail members add --name "Grace Hopper" --email grace@example.com
fluxmail members list

# Members connect mailboxes they own
fluxmail accounts add gmail

# Owners choose who else can reach their mailbox
fluxmail accounts access <account-id> --owner-only
fluxmail accounts access <account-id> --shared
fluxmail accounts access <account-id> --share-with ada@example.com

# Owners can hand a mailbox to another member
fluxmail accounts assign <account-id> --owner grace@example.com

# Administrators remove a member and hand their mailboxes to someone else
fluxmail members remove grace@example.com --reassign-to ada@example.com
```

`fluxmail members add` prints an enrollment code once. Send it to the new member through a private channel. They add the instance and set their password with `fluxmail login --instance <name> --server <url> --enroll`.

`--owner-only` makes a mailbox private to its owner. `--shared` makes it available to every active member, including members added later. Repeat `--share-with` to give selected members access. Only a mailbox's owner can change who can reach it, hand it to someone else, reauthorize it, or change its IMAP and SMTP server settings. A member the mailbox is shared with can't share it further.

Administrators manage members, licenses, keys and mailbox metadata. They can also connect mailboxes for other members, remove mailboxes, and edit folder mappings and sender addresses. They can't read another member's private mail or give themselves access to it. An administrator can move someone else's mailbox only by removing that member with `--reassign-to`, and removal can't be undone. Two more limits apply:

- A key an administrator creates for another member reaches only mailboxes both of them can read, and it can't change that member's sharing or mailbox connections.
- An administrator who issues a password reset code sees the code, so they could use it to sign in as that member. Redeeming a code signs the member out of every session, and Fluxmail records each code an administrator issues in the audit log.

Anyone who can read the server's data directory and encryption key can read the stored mailbox credentials. Give server access only to people you trust with every mailbox on the instance.

Stdio uses the member logged in to the selected local instance. You can limit a connection to selected mailboxes that member can already reach:

```bash
# Local connection for the logged-in member, limited to one mailbox
fluxmail stdio --account <account-id>

# HTTP connection for the logged-in member, limited to one mailbox and read-only actions
fluxmail apikey create \
  --name "ada laptop" \
  --account <account-id> \
  --profile read-only
```

Update an HTTP key's mailbox allowlist without replacing the key:

```bash
fluxmail apikey accounts <key-id> --account <account-id>
fluxmail apikey accounts <key-id> --all-accounts
```

Member and mailbox scope control which mailboxes a connection can reach. Its [permission profile](/docs/permissions) separately controls which email actions the client can take. Use one key per client so you can change its scope, change its permissions, or revoke it without interrupting other connections.

## Plans and licensing

Self-hosting is free on the **Personal** plan: 3 connected mailboxes and 1 member. Pro raises the mailbox limit for one person. Each member included in your Business plan raises the mailbox limit by 20. The limit applies to the instance, so one person can connect every allotted mailbox. You choose which members can access each mailbox. Contact us about Enterprise if you need more than 100 members. See [pricing](/pricing) for current limits.

You can buy Pro or Business from the pricing page. Stripe returns you to Fluxmail after payment and shows your license key. Copy it then, and keep it private.

Use **Manage subscription** on the pricing page or license screen to update your card, view invoices, change plans or your member limit, or cancel. Stripe asks for the email used at checkout and sends a one-time passcode before opening billing details. Stripe billing emails also include the same portal link.

Unlock a paid plan with your license key:

```bash
fluxmail license activate
fluxmail license status
```

Fluxmail prompts for the key without displaying it. For automation, use `fluxmail license activate --key-file /absolute/path/to/license`, or pass `-` to read from stdin.

An administrative REST client can read the same status from `GET /api/v1/admin/license`, activate a key with `POST /api/v1/admin/license/activate`, and deactivate it with `DELETE /api/v1/admin/license`. An API key needs `admin.license`; an administrator's member session can call the routes directly. The status response never includes the configured license key. REST cannot replace or remove a key supplied through `FLUXMAIL_LICENSE_KEY`.

One license activates one instance, and enforcement keeps working offline. If you schedule a cancellation, the paid plan works until the end of the billing period. After the subscription ends or a payment fails, the instance drops back to Personal limits. Deactivating, downgrading, or lapsing never deletes mailboxes or data.

Lowering the member limit takes effect at the end of the billing period. If the instance then has more mailboxes or members than the new limits allow, Fluxmail keeps working for 7 days and warns administrators in the CLI, `fluxmail license status`, and MCP tool results. You can't add mailboxes or members during that time. Remove the extras or increase your member limit before the date in the warning. After that, email tools stop working until usage fits the plan. The CLI keeps working so you can remove mailboxes or members.

The `send_feedback` MCP tool remains available after a subscription ends, including when email tools are blocked by plan limits. It requires authentication and does not count against mail usage or hourly mail quotas. See [sending feedback](/docs/tools#send-feedback).

## Software license

Fluxmail is source available under the [Elastic License 2.0](https://github.com/fluxmailai/fluxmail/blob/main/LICENSE.md). You may use, modify, create derivative works, and redistribute it subject to that license. A fork does not need a paid Fluxmail subscription merely because it is a fork. Without a valid paid key, Fluxmail uses the Personal plan with 3 mailboxes and 1 member.

Official Pro, Business, and Enterprise entitlements require a valid Fluxmail license key. ELv2 does not allow you to change or circumvent license key functionality or remove functionality protected by a key. It also does not allow you to provide Fluxmail to third parties as a hosted or managed service that exposes a substantial set of its features.

The software license does not grant rights to Fluxmail names or logos beyond applicable law. Their use is subject to the [Fluxmail Terms of Service](https://fluxmail.ai/terms).
