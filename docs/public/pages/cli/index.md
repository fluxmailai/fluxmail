---
title: 'CLI reference'
description: 'Work with email and manage the Fluxmail server from the command line.'
updated: '2026-07-15'
---

The Fluxmail CLI reads and manages email through a selected local or remote instance. It also starts MCP and REST servers and handles instance administration. Run `fluxmail setup` for a new local instance, or use `fluxmail login` to add an existing instance. See [Authentication and instances](/docs/authentication-and-instances) for profiles, sessions, and remote URL rules.

See [Use the CLI](/docs/use-the-cli) for email, setup, and administration workflows. This page is the complete command reference.

## Install the CLI

Install Fluxmail globally:

```bash
npm install -g fluxmail
```

To run a command without a global installation, replace `fluxmail` with `npx -y fluxmail@latest`. Pin an exact version instead of `@latest` to stay on one release.

If Fluxmail runs under Docker, prefix each command with `docker compose exec fluxmail`. For example:

```bash
docker compose exec fluxmail fluxmail accounts list
```

## Command reference

<!-- BEGIN GENERATED:cli-command-reference -->
| Command | Description |
| --- | --- |
| [`fluxmail setup`](/docs/cli/setup) | Create the first local administrator or claim a migrated administrator |
| [`fluxmail login`](/docs/cli/login) | Log in to a local or remote instance |
| [`fluxmail logout`](/docs/cli/logout) | Revoke the current CLI session |
| [`fluxmail instances`](/docs/cli/instances) | Manage local and remote CLI instances |
| [`fluxmail instances list`](/docs/cli/instances-list) | List configured instances |
| [`fluxmail instances use`](/docs/cli/instances-use) | Select the default instance |
| [`fluxmail instances remove`](/docs/cli/instances-remove) | Remove a CLI profile and its local session |
| [`fluxmail auth`](/docs/cli/auth) | Manage interactive authentication |
| [`fluxmail auth recover-admin`](/docs/cli/auth-recover-admin) | Reset an administrator password using local filesystem access |
| [`fluxmail auth sessions`](/docs/cli/auth-sessions) | List sessions for the current member |
| [`fluxmail auth revoke-session`](/docs/cli/auth-revoke-session) | Revoke one of the current member's sessions |
| [`fluxmail serve`](/docs/cli/serve) | Run the HTTP server (MCP at /mcp and REST at /api/v1) |
| [`fluxmail stdio`](/docs/cli/stdio) | Run as a stdio MCP server (for Claude Desktop / Claude Code local config) |
| [`fluxmail accounts`](/docs/cli/accounts) | Manage connected email accounts |
| [`fluxmail accounts send-as`](/docs/cli/accounts-send-as) | Manage sender addresses |
| [`fluxmail accounts send-as list`](/docs/cli/accounts-send-as-list) | List available sender addresses |
| [`fluxmail accounts send-as add`](/docs/cli/accounts-send-as-add) | Add a configured Outlook or IMAP sender address |
| [`fluxmail accounts send-as remove`](/docs/cli/accounts-send-as-remove) | Remove a configured Outlook or IMAP sender address |
| [`fluxmail accounts add`](/docs/cli/accounts-add) | Connect a Gmail, Outlook, or IMAP account |
| [`fluxmail accounts configure`](/docs/cli/accounts-configure) | Set special folder paths for an IMAP account |
| [`fluxmail accounts list`](/docs/cli/accounts-list) | List connected accounts |
| [`fluxmail accounts remove`](/docs/cli/accounts-remove) | Disconnect an account and delete its stored tokens |
| [`fluxmail accounts assign`](/docs/cli/accounts-assign) | Change mailbox ownership |
| [`fluxmail accounts access`](/docs/cli/accounts-access) | Set who can access a mailbox |
| [`fluxmail members`](/docs/cli/members) | Manage members (people using this instance) |
| [`fluxmail members add`](/docs/cli/members-add) | Add a member (subject to your plan's member limit) |
| [`fluxmail members list`](/docs/cli/members-list) | List members with their mailbox and API key counts |
| [`fluxmail members remove`](/docs/cli/members-remove) | Remove a member after reassigning or removing their mailboxes |
| [`fluxmail members role`](/docs/cli/members-role) | Change a member role |
| [`fluxmail members status`](/docs/cli/members-status) | Activate or suspend a member |
| [`fluxmail members invite`](/docs/cli/members-invite) | Issue a new enrollment code |
| [`fluxmail members password-reset`](/docs/cli/members-password-reset) | Issue a password reset code |
| [`fluxmail members sessions`](/docs/cli/members-sessions) | List sessions for a member |
| [`fluxmail members revoke-session`](/docs/cli/members-revoke-session) | Revoke a member session |
| [`fluxmail apikey`](/docs/cli/apikey) | Manage API keys for the HTTP MCP and REST APIs |
| [`fluxmail apikey capabilities`](/docs/cli/apikey-capabilities) | List capabilities for API key permission policies |
| [`fluxmail apikey create`](/docs/cli/apikey-create) | Create an API key (shown once) |
| [`fluxmail apikey list`](/docs/cli/apikey-list) | List API keys |
| [`fluxmail apikey accounts`](/docs/cli/apikey-accounts) | Replace or clear an API key mailbox allowlist |
| [`fluxmail apikey permissions`](/docs/cli/apikey-permissions) | Change the permissions for an API key |
| [`fluxmail apikey revoke`](/docs/cli/apikey-revoke) | Revoke an API key |
| [`fluxmail connections`](/docs/cli/connections) | Manage MCP clients connected with OAuth |
| [`fluxmail connections list`](/docs/cli/connections-list) | List OAuth connections |
| [`fluxmail connections accounts`](/docs/cli/connections-accounts) | Change the mailboxes one of your OAuth connections can use |
| [`fluxmail connections revoke`](/docs/cli/connections-revoke) | Disconnect an MCP client and revoke its tokens |
| [`fluxmail license`](/docs/cli/license) | Manage the paid-tier license |
| [`fluxmail license activate`](/docs/cli/license-activate) | Store a license key and validate it with the license server |
| [`fluxmail license status`](/docs/cli/license-status) | Show the configured license and cached lease |
| [`fluxmail license deactivate`](/docs/cli/license-deactivate) | Release the license from this instance and remove the stored key and cached lease |
| [`fluxmail config`](/docs/cli/config) | Inspect and initialize deployment configuration |
| [`fluxmail config init`](/docs/cli/config-init) | Create config.toml in the Fluxmail data directory |
| [`fluxmail config show`](/docs/cli/config-show) | Show effective configuration, sources, paths, and restart requirements |
| [`fluxmail config migrate`](/docs/cli/config-migrate) | Import settings from an env file without deleting it |
| [`fluxmail oauth`](/docs/cli/oauth) | Manage OAuth applications |
| [`fluxmail oauth status`](/docs/cli/oauth-status) | Show OAuth application status without secrets |
| [`fluxmail oauth configure`](/docs/cli/oauth-configure) | Configure an OAuth application |
| [`fluxmail oauth configure google`](/docs/cli/oauth-configure-google) | Configure a custom Google OAuth application |
| [`fluxmail oauth configure outlook`](/docs/cli/oauth-configure-outlook) | Configure a custom Microsoft OAuth application |
| [`fluxmail oauth reset`](/docs/cli/oauth-reset) | Remove a stored OAuth application |
| [`fluxmail logs`](/docs/cli/logs) | Show recent local log entries |
| [`fluxmail telemetry`](/docs/cli/telemetry) | Manage anonymous usage telemetry |
| [`fluxmail telemetry disable`](/docs/cli/telemetry-disable) | Stop sending anonymous usage telemetry |
| [`fluxmail telemetry enable`](/docs/cli/telemetry-enable) | Allow anonymous usage telemetry |
| [`fluxmail telemetry status`](/docs/cli/telemetry-status) | Show whether anonymous usage telemetry is enabled |
| [`fluxmail folders`](/docs/cli/folders) | Work with navigable mailbox folders |
| [`fluxmail folders list`](/docs/cli/folders-list) | List folders in an email account |
| [`fluxmail labels`](/docs/cli/labels) | Work with Gmail labels and Outlook categories |
| [`fluxmail labels list`](/docs/cli/labels-list) | List Gmail user labels or Outlook categories |
| [`fluxmail emails`](/docs/cli/emails) | Read, send, and organize email |
| [`fluxmail emails list`](/docs/cli/emails-list) | List and filter messages |
| [`fluxmail emails search`](/docs/cli/emails-search) | Search messages |
| [`fluxmail emails search-batch`](/docs/cli/emails-search-batch) | Search multiple email accounts |
| [`fluxmail emails get`](/docs/cli/emails-get) | Get a complete message |
| [`fluxmail emails send`](/docs/cli/emails-send) | Send or schedule a message |
| [`fluxmail emails preview`](/docs/cli/emails-preview) | Preview sender, recipients, and attachments |
| [`fluxmail emails forward`](/docs/cli/emails-forward) | Forward a message |
| [`fluxmail emails delivery-status`](/docs/cli/emails-delivery-status) | Check a send or forward outcome |
| [`fluxmail emails modify`](/docs/cli/emails-modify) | Apply one action to one or more messages |
| [`fluxmail threads`](/docs/cli/threads) | Read email threads |
| [`fluxmail threads get`](/docs/cli/threads-get) | Get a complete thread |
| [`fluxmail drafts`](/docs/cli/drafts) | Create and manage drafts |
| [`fluxmail drafts get`](/docs/cli/drafts-get) | Read a draft |
| [`fluxmail drafts create`](/docs/cli/drafts-create) | Create a draft |
| [`fluxmail drafts update`](/docs/cli/drafts-update) | Replace the content of a draft |
| [`fluxmail drafts delete`](/docs/cli/drafts-delete) | Delete a draft |
| [`fluxmail scheduled`](/docs/cli/scheduled) | Manage scheduled sends |
| [`fluxmail scheduled list`](/docs/cli/scheduled-list) | List scheduled sends |
| [`fluxmail scheduled cancel`](/docs/cli/scheduled-cancel) | Cancel a scheduled send and keep its draft |
| [`fluxmail scheduled run`](/docs/cli/scheduled-run) | Run scheduled delivery for this local instance without HTTP or MCP |
| [`fluxmail attachments`](/docs/cli/attachments) | Download message attachments |
| [`fluxmail attachments download`](/docs/cli/attachments-download) | Download an attachment |
| [`fluxmail status`](/docs/cli/status) | Show mailbox and provider status for the selected instance |
<!-- END GENERATED:cli-command-reference -->

Add `--help` to a command to view its usage in the terminal. For example, run `fluxmail accounts add --help`.

## Gmail and Outlook connections

Fluxmail uses the hosted browser flow when `FLUXMAIL_PUBLIC_URL` is a non-loopback address. Otherwise, it uses the local loopback flow. Hosted links expire after 10 minutes and work once.

The `--hosted` and `--local` options override the automatic choice. You cannot combine them or use them with an IMAP account. The provider name `microsoft` is an alias for `outlook`.

## IMAP account options

`fluxmail accounts add imap` accepts separate settings for incoming and outgoing mail. Without a password environment variable, Fluxmail prompts for the password in an interactive terminal.

See [Connect IMAP/SMTP](/docs/connect-an-imap-mailbox) for a complete setup example and help with folder detection.

## MCP permission options

The named profiles are `read-only`, `read-write`, and `full`. Use repeated `--allow` options to build a custom policy, or combine `--profile` and `--allow` to add capabilities to a named profile. For example, `--profile full --allow mail.delete` adds permanent deletion where the provider supports it.

Permissions passed to `fluxmail stdio` apply to that process. API key permissions are stored with the key and can be changed with `fluxmail apikey permissions`. See [Permissions](/docs/permissions) for the capability list and workflow requirements.
