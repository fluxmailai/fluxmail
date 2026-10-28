---
title: 'Authentication and instances'
description: 'Log in to local and remote Fluxmail instances, enroll members, manage sessions, connect MCP clients with OAuth, and create API keys.'
updated: '2026-10-22'
---

Fluxmail uses member sessions for people, OAuth connections for HTTP MCP clients, and API keys for MCP clients, scripts, and other automation. A member session follows the member's current role and mailbox access. OAuth connections and API keys are narrower: Fluxmail also checks their permissions and optional mailbox allowlist on every request.

An *instance profile* tells your CLI which installation to use. A *member session* signs you in to that installation. A connected email *account* is a mailbox; its Google, Microsoft, or IMAP credentials are separate from your Fluxmail login.

| Task | Use |
| --- | --- |
| Create the first administrator | `fluxmail setup` once on a new instance |
| Sign in again | `fluxmail --instance <name> login` |
| Connect a local MCP client | Saved local member session plus stdio permissions |
| Connect an HTTP MCP client or app | OAuth sign-in from the client, or a named, scoped API key |
| Run scripts against REST | A named, scoped API key |

## Set up a local instance

Run this once on a fresh instance:

```bash
fluxmail setup --name "Your name" --email you@example.com
```

Fluxmail asks for a password without displaying it. The command creates the first administrator, adds a CLI profile named `local`, and saves a 90-day device session.

Passwords must contain 8 to 256 Unicode characters. Fluxmail rejects common passwords and passwords based on the member's name or email address. It does not require a mix of uppercase letters, numbers, and symbols.

## Log in to an existing local instance

List your profiles with `fluxmail instances list`, then log in with the name of the local profile you want to use:

```bash
fluxmail --instance <name> login
```

If your local profile was removed or the CLI files were lost, login can recreate the default profile named `local`:

```bash
fluxmail --instance local login
```

On a machine with no CLI profiles at all, bare `fluxmail login` recreates the `local` profile and logs in there. If other profiles exist, name the local one explicitly as above.

## Log in to a remote instance

Name the profile when you add a server:

```bash
fluxmail --instance work login --server https://mail.example.com
```

Fluxmail asks for the member email and password. After the profile exists, the server URL is no longer needed:

```bash
fluxmail --instance work login
```

Remote profiles require HTTPS. Plain HTTP is accepted only for loopback addresses such as `http://127.0.0.1:8977`. The CLI refuses redirects for authenticated remote requests so it cannot forward a session to another origin.

If a reverse proxy terminates TLS and connects to Fluxmail from a non-loopback address, set `FLUXMAIL_TRUST_PROXY=1`. Fluxmail will then use the forwarded protocol and client address for HTTPS checks and login throttling. Enable this only when the proxy overwrites forwarded headers and blocks direct access to Fluxmail.

List, select, or remove profiles with:

```bash
fluxmail instances list
fluxmail instances use work
fluxmail instances remove work
```

`--instance <name>` overrides the selected profile for one command. Removing a profile deletes its local session secret but does not change the server or its data.

## Invite and enroll a member

An administrator creates a pending member:

```bash
fluxmail members add --name "Grace Hopper" --email grace@example.com
```

The command prints a one-time enrollment code. It expires after seven days. Send it to the member through a private channel. The member enrolls with:

```bash
fluxmail --instance work login --server https://mail.example.com --enroll
```

Fluxmail asks for the code and a new password without putting either secret in shell history. If the profile already exists, omit `--server`. Administrators can replace an unused or expired code with `fluxmail members invite <member>`.

Enrollment is only needed for the first password. Members use normal login afterward.

## Manage sessions

Member sessions have a server-enforced 90-day lifetime. Logout, suspension, removal, password reset, and explicit revocation take effect immediately.

```bash
fluxmail auth sessions
fluxmail auth revoke-session <session-id>
fluxmail logout
```

Administrators can inspect or revoke another member's sessions:

```bash
fluxmail members sessions <member>
fluxmail members revoke-session <member> <session-id>
```

Password reset codes last for one hour:

```bash
fluxmail members password-reset <member>
```

The member redeems the code with `fluxmail --instance <name> login --reset`. Email delivery is not built in, so the administrator must send the code privately.

## Use API keys for automation

Create a key while logged in:

```bash
fluxmail apikey create --name research-agent --profile read-only
```

The key belongs to the current member and is shown once. It can only reach mailboxes available to that member. Use repeated `--account` options to narrow it to specific mailboxes.

Administrators can issue a key for another member with `--member <id-or-email>`. Administrative capabilities require an administrator owner and an explicit `admin.*` capability. Demoting or suspending the owner removes that authority immediately.

HTTP MCP accepts OAuth access tokens and API keys, not member sessions:

```http
Authorization: Bearer fmk_...
```

REST accepts either an API key or the `fms_...` session used by the CLI. It does not accept OAuth access tokens.

## Connect MCP clients with OAuth

An MCP client that supports OAuth only needs your server's `/mcp` URL. It registers itself, then opens a Fluxmail page where you sign in with your member email and password and choose its permissions and mailboxes. Fluxmail offers OAuth when its public URL uses HTTPS or a loopback address. See [Connect an MCP client](/docs/connect-an-mcp-client#sign-in-with-oauth) for client setup.

Each approval creates a separate connection that belongs to the member who approved it. A connection can use mail permissions only. It cannot manage members, mailboxes, keys, or the license, even when an administrator approves it. Access tokens last 15 minutes and refresh automatically. A connection ends after 90 days, or 30 days after its client last refreshed, and then the client asks you to sign in again.

```bash
fluxmail connections list
fluxmail connections accounts <connection-id> --account <account-id>
fluxmail connections revoke <connection-id>
```

Administrators see every member's connections and can revoke any of them. Suspension, removal, password reset, password change, and administrator recovery revoke the member's connections.

## Local stdio

`fluxmail stdio` uses the authenticated member session from the selected local profile. It does not accept a member override.

We recommend Full access for normal MCP use. It allows reading, sending, scheduling, drafts, organization, and moving mail into or out of Trash. It excludes permanent deletion. Choose `read-write` or `read-only` for [restricted access](/docs/permissions). Bare stdio and API-key creation without permission options remain read-only. To select Full explicitly:

```bash
fluxmail stdio --profile full
```

Without `--instance`, stdio uses the active local profile, then a local profile named `local`, then the sole local profile under any other name. If several local profiles exist and none is active or named `local`, choose one with `fluxmail --instance <name> stdio`. An explicit `--instance` must select a local profile. Stdio does not change the active profile for other CLI commands.

Stdio is local only. Use the HTTP MCP endpoint with OAuth or a scoped API key for remote MCP clients. Stdio can create schedules but does not deliver them; keep `fluxmail serve` or `fluxmail scheduled run` running with the same data directory for scheduled delivery.

## Stored CLI files

Fluxmail keeps profile metadata and session secrets in separate files under `<data dir>/cli`. Both files are readable only by their owner, and the directory uses owner-only permissions. The session file contains the bearer secret. Copying the profile file alone does not copy a login.

## Recover a local administrator

If every administrator session is unavailable, someone with filesystem access to the instance can reset an existing administrator:

```bash
fluxmail auth recover-admin <id-or-email>
```

The command is local only. It sets a new password, reactivates that administrator if needed, revokes their sessions, and writes a security audit event. It cannot create a member or bypass plan limits.

Finish `fluxmail setup` before using administrator recovery. Migrated instances must claim an existing administrator during setup first.
