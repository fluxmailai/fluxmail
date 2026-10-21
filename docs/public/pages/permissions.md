---
title: 'Permissions'
description: 'Give each MCP or REST connection only the Fluxmail email permissions it needs.'
updated: '2026-10-20'
---

Fluxmail can limit the email actions available to each MCP or REST connection. Give a research client read-only access, or let an inbox organizer manage messages without granting send or permanent-delete access.

Permissions control which MCP tools Fluxmail exposes and which REST routes or message actions a key can call.

Mailbox scope is separate from permissions. The member and optional mailbox allowlist decide which mailboxes a connection can reach. The permission profile decides what it can do with those mailboxes. Fluxmail applies both checks to every connection.

## Choose a permission profile

<!-- BEGIN GENERATED:permission-profiles -->
| Profile | What it allows | Capabilities |
| --- | --- | --- |
| `read-only` | Read and search mail, inspect folders, labels, and scheduled sends, and download attachments. | `mail.read` |
| `read-write` | Read mail, manage drafts, organize messages, and move messages to or from Trash. | `mail.read`, `mail.drafts`, `mail.organize`, `mail.trash` |
| `full` | Use every Fluxmail email capability except permanent deletion, including sending mail. | `mail.read`, `mail.drafts`, `mail.organize`, `mail.trash`, `mail.send` |
<!-- END GENERATED:permission-profiles -->

Fluxmail uses `read-only` when you do not choose a profile. Choose a broader profile or a [custom policy](#build-a-custom-policy) for clients that draft, organize, or send mail.

No profile allows permanent deletion. To let a client permanently delete messages, add `mail.delete` to its profile:

```bash
fluxmail stdio --profile full --allow mail.delete
```

## Limit a local stdio connection

Pass a profile when your MCP client launches Fluxmail:

```bash
fluxmail stdio --profile read-only
```

For a client config file, put the profile in the argument list:

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "fluxmail",
      "args": [
        "stdio",
        "--profile",
        "read-only"
      ]
    }
  }
}
```

## Limit an HTTP connection

HTTP permissions belong to the API key. Each key also belongs to a member. Create a separate key for each MCP or REST client so you can change or revoke one connection without affecting the others.

```bash
fluxmail apikey create \
  --name research-agent \
  --profile read-only
fluxmail apikey create \
  --name inbox-agent \
  --profile read-write
```

The key is shown once. `fluxmail apikey list` shows each key ID and permission profile without revealing the secret.

Change an existing key by its ID:

```bash
fluxmail apikey permissions <key-id> --profile read-only
```

Keys created without permission options use `read-only`. Existing keys keep the profile they were created with. HTTP MCP requests always require an API key. REST accepts either a member session or an API key, except for its public login, enrollment, reset redemption, discovery, and health routes.

## Administrative capabilities

Administrative access is separate from mail access:

| Capability | What it allows |
| --- | --- |
| `admin.accounts` | Connect and reauthorize mailboxes, test IMAP and SMTP settings, update IMAP folder mappings, and configure Outlook or IMAP sender addresses. |
| `admin.members` | Invite, suspend, activate, promote, demote, and remove members. It also permits session revocation. |
| `admin.api_keys` | Create, update, list, and revoke API keys. |
| `admin.license` | Read, activate, and deactivate the instance license. |
| `admin.audit` | Read security audit events. |

Add administrative capabilities to a named mail profile with repeated `--admin` options:

```bash
fluxmail apikey create \
  --name account-operator \
  --profile read-only \
  --admin admin.accounts
```

When changing an existing key, `--admin` keeps its current named mail profile and replaces its administrative capabilities. A custom policy has no separate administrative list, so pass every allowed capability with `--allow` instead.

For a custom policy, put both mail and administrative capabilities in repeated `--allow` options. Fluxmail rejects administrative capabilities for non-admin members. It also checks the owner's current role and mailbox grants on every request.

Treat `admin.api_keys` as sensitive authority. Administrator sessions remain the recovery path if an administrative key is revoked or narrowed.

## Build a custom policy

Use repeated `--allow` options when the named profiles are too broad. Combine them with `--profile` to add capabilities to a profile; the result is saved as a custom policy. List the available capabilities first:

```bash
fluxmail apikey capabilities
```

<!-- BEGIN GENERATED:permission-capabilities -->
| Capability | Actions |
| --- | --- |
| `mail.read` | List, search, and read mail; inspect status, folders, labels, and sender addresses; list scheduled sends; download attachments. |
| `mail.drafts` | Create, update, and delete drafts; cancel scheduled sends. |
| `mail.organize` | Mark read or unread, star, archive, move, and manage labels or Outlook categories. |
| `mail.trash` | Move messages to or from Trash. |
| `mail.delete` | Permanently delete messages. |
| `mail.send` | Send or schedule messages. |
<!-- END GENERATED:permission-capabilities -->

The `move_emails` MCP tool and the `move` action in REST and the CLI cannot target Trash or Archive by folder ID, role, or display name. They also cannot move messages out of Trash. To move messages into Trash, use `trash_emails` or the `trash` action. To restore them, use `restore_emails` or `untrash`. To archive messages that are not in Trash, use `archive_emails` or `archive`. These restrictions keep Trash access behind the `mail.trash` capability.

Create a custom HTTP key like this:

```bash
fluxmail apikey create \
  --name drafting-agent \
  --allow mail.read \
  --allow mail.drafts
```

The same options work with stdio:

```bash
fluxmail stdio \
  --allow mail.read \
  --allow mail.organize
```

Some workflows need more than one capability. Reply drafts need `mail.drafts` and `mail.read`; replies need `mail.send` and `mail.read`; forwarding also needs `mail.send` and `mail.read`.

Draft lookup needs `mail.drafts`. Send preview and delivery status need `mail.send`; previewing an existing draft also needs `mail.drafts`, and previewing a reply needs `mail.read`. Body continuation and attachment resources need `mail.read`. The same mailbox access rules apply to these operations.
