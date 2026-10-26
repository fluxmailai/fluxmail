---
title: 'Troubleshooting'
description: 'Fix common Fluxmail installation, mailbox connection, and authentication problems.'
updated: '2026-10-22'
---

Start by checking the service and connected mailboxes:

```bash
fluxmail status
fluxmail accounts list
```

Show recent warnings and errors with:

```bash
fluxmail logs --level warn
```

For Docker, prefix each command with `docker compose exec fluxmail`.

## The fluxmail command is not found

Check whether your shell can find the command:

```bash
which fluxmail
```

If that prints nothing, install Fluxmail globally or run it through `npx`:

```bash
npm install -g fluxmail
npx -y fluxmail@latest status
```

Some apps use a limited `PATH`. Run `which fluxmail` in your terminal and use the returned absolute path in the app's configuration.

## The browser cannot finish connecting a mailbox

Local OAuth connections listen for the browser redirect on port 8976 of the computer running the CLI. If your browser runs on another computer, the page fails to load after you approve access. Copy the full URL from the address bar and paste it into the terminal where the command is waiting, or forward the port with `ssh -L 8976:127.0.0.1:8976 you@server`. Pasting needs an interactive terminal. If another program is using port 8976 and you run the command in one, Fluxmail asks you to paste the URL instead. When Docker Compose is using the port, run the command inside the container with `docker compose exec fluxmail fluxmail accounts add gmail` or `outlook` so the mailbox is saved there.

The command stops waiting after 10 minutes. If it times out, run it again to get a new authorization URL.

A remote server needs `FLUXMAIL_PUBLIC_URL` set to its public HTTPS address. Gmail also needs your own Google Web client, and Outlook needs your own Microsoft Entra app with a client secret. Follow [Deploy with Docker](/docs/deploy-with-docker) and the setup guide for [Gmail](/docs/connect-gmail-to-mcp) or [Outlook](/docs/connect-outlook-to-mcp).

## A mailbox needs to be reconnected

Run `fluxmail status` to confirm which mailbox needs attention. Then follow the reconnection steps for [Gmail](/docs/connect-gmail-to-mcp), [Outlook](/docs/connect-outlook-to-mcp), or [IMAP/SMTP](/docs/connect-an-imap-mailbox).

Reconnecting updates the saved credentials without changing the mailbox owner or access rules.

## MCP or REST returns 401

An MCP client that uses OAuth has to sign in again when its connection was revoked or expired. Start sign-in from the client, such as `claude mcp login fluxmail` or `codex mcp login fluxmail`. If the client never opens a Fluxmail sign-in page, check that `FLUXMAIL_PUBLIC_URL` uses HTTPS and matches the URL the client connects to. `fluxmail serve` prints whether OAuth is available.

Clients that use an API key must send it as a bearer token. REST accepts API keys and member sessions but not OAuth access tokens.

```text
Authorization: Bearer fmk_...
```

Fluxmail shows an API key only when you create it. If the key was lost or revoked, create a new one and update the client.

## MCP or REST returns 403

The OAuth connection or API key does not have permission for the requested operation or mailbox. Check its permissions and mailbox allowlist:

```bash
fluxmail connections list
fluxmail apikey list
```

See [Permissions](/docs/permissions) to change the profile or mailbox scope.

## A Docker server does not respond

Check the container status and recent logs:

```bash
docker compose ps
docker compose logs --tail=100 fluxmail
docker compose exec fluxmail fluxmail logs --level warn
```

Confirm that port 8977 is reachable and that your reverse proxy forwards requests to it. See [Deploy with Docker](/docs/deploy-with-docker) for the expected public URL and authentication settings.

## A configuration import fails

`fluxmail config migrate` preserves the source file whether the command succeeds or fails. Read the error before changing any files. A key mismatch means the configured key differs from `<data dir>/encryption.key` or cannot decrypt the existing database. Restore the key that was used with the database, then retry the command.

Do not replace the key just to clear the error. Provider credentials and encrypted instance settings cannot be decrypted with a different key.

If `config.toml` already exists, move it aside only when the env file should replace its deployment settings. After a successful import, run `fluxmail config show` and `fluxmail oauth status` before removing the old file.

## An OAuth application cannot be changed

Run `fluxmail oauth status` and check the source. An application with an `environment` or `environment-file` source is controlled by deployment overrides. Remove the complete provider override group, restart Fluxmail, then run `fluxmail oauth configure` or `fluxmail oauth reset` again.
