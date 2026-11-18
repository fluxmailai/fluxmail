---
title: 'Connect IMAP/SMTP'
description: 'Connect any mailbox with IMAP and SMTP access, set its security options, and correct special-folder mappings.'
updated: '2026-11-16'
---

Fluxmail can connect to email providers that offer IMAP for reading mail and SMTP for sending it.

## 1. Find your provider settings

Before you start, find the IMAP and SMTP settings from your email provider. Some providers require an app password instead of your usual email password.

Fluxmail defaults to IMAP over TLS on port 993 and SMTP with STARTTLS on port 587. It uses the mailbox address as the username for both connections. You can override each of these settings when you connect the mailbox.

## 2. Connect the mailbox

Choose the setup that matches how you run Fluxmail.

For a fresh local instance, create the first administrator and log in:

```bash
fluxmail setup --name "Your name" --email you@example.com
```

### Local terminal

Run:

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

Fluxmail prompts for the password without showing it on screen.

If your provider uses different settings, pass the matching options:

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --display-name 'Your Name' \
  --imap-host imap.example.com \
  --imap-port 143 \
  --imap-security starttls \
  --imap-user your-username \
  --smtp-host smtp.example.com \
  --smtp-port 465 \
  --smtp-security tls \
  --smtp-user your-username
```

Both security options accept `tls` or `starttls`. Fluxmail checks both connections before saving the mailbox. Mailbox passwords are encrypted at rest with AES-256-GCM in Fluxmail's local SQLite database.

### Docker

For an interactive setup, run the same command inside the container. Enter the password at the private prompt:

```bash
docker compose exec fluxmail \
  fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

### Scripts and non-interactive environments

Load the app password into `IMAP_PASSWORD` through your secret store or a private prompt, then pass the variable name to Fluxmail. Avoid typing the secret into a shell command that will be saved in history:

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --imap-password-env IMAP_PASSWORD
```

Fluxmail uses the IMAP password for SMTP too. If they differ, load a second variable and pass its name with `--smtp-password-env`.

For Docker, pass the existing variable into the container:

```bash
docker compose exec -e IMAP_PASSWORD fluxmail \
  fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --imap-password-env IMAP_PASSWORD
```

## 3. Verify the connection

List the connected mailboxes, then use the IMAP account ID to fetch its folders:

```bash
fluxmail accounts list
fluxmail --mail-account <account-id> folders list
```

For Docker, prefix both commands with `docker compose exec fluxmail`. The folder call checks provider access without reading message bodies or changing mail. Continue with [MCP setup](/docs/connect-an-mcp-client) or [REST](/docs/build-with-rest) to verify access through your client as well.

## If a special folder is missing or incorrect

Fluxmail looks for Sent, Drafts, Trash, Archive, and Spam folders using the server's special-use flags first, then common folder names such as `Sent Items` and `Junk Mail`. It prints a warning when a folder is missing or ambiguous, but still connects the mailbox.

Fluxmail does not create a missing folder or guess when several folders match. An action that needs an unresolved folder returns an error. This prevents an archive or trash command from moving mail to the wrong place.

Set the right folder path with the account ID from `fluxmail accounts list`:

```bash
fluxmail accounts configure <account-id> --sent-folder 'Sent Items'
fluxmail accounts configure <account-id> --trash-folder 'Deleted Messages'
```

You can configure `--sent-folder`, `--drafts-folder`, `--trash-folder`, `--archive-folder`, and `--spam-folder`. Pass `auto` to remove an override and let Fluxmail detect that folder again:

```bash
fluxmail accounts configure <account-id> --trash-folder auto
```

## Optional: avoid duplicate Sent messages

Fluxmail normally saves an SMTP submission in the resolved Sent folder. Some mail services already save SMTP submissions themselves. If yours does, add `--no-save-sent` when you connect the mailbox so each message appears only once:

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --no-save-sent
```

## Connect through REST

An administrative client can test settings without saving them at `POST /api/v1/admin/imap/tests`, then connect the mailbox at `POST /api/v1/admin/connections`. The API key needs `admin.accounts`.

```bash
curl "$FLUXMAIL_PUBLIC_URL/api/v1/admin/connections" \
  -X POST \
  -H "Authorization: Bearer $FLUXMAIL_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "provider": "imap",
    "ownerMemberId": "you@example.com",
    "email": "you@example.com",
    "imap": {
      "host": "imap.example.com",
      "port": 993,
      "security": "tls",
      "user": "you@example.com",
      "password": "app-password"
    },
    "smtp": {
      "host": "smtp.example.com",
      "port": 587,
      "security": "starttls",
      "user": "you@example.com",
      "password": "app-password"
    },
    "saveSent": true
  }'
```

Fluxmail tests IMAP and SMTP within 30 seconds before it saves the mailbox. The response does not echo either password. Reauthorization keeps the existing `saveSent` value and folder overrides when those fields are omitted.

Mailbox owners can update folder mappings with `PATCH /api/v1/accounts/:accountId/imap/folders`. Administrators can use `PATCH /api/v1/admin/accounts/:accountId/imap/folders` for any mailbox. A string sets a folder path. `null` removes an override and restores automatic detection. Fluxmail validates every requested path before saving any of them.

## How Fluxmail works with IMAP

If the SMTP account has aliases, an administrator can register those existing addresses in Fluxmail. The selected address is used in both the From header and SMTP envelope. Your SMTP server must allow it. See [Send from another address](/docs/send-as-addresses).

Fluxmail uses IMAP to read and organize the mailbox, and SMTP to send messages. The available behavior depends partly on the mail server:

- Each message lives in a folder. Fluxmail can move messages between folders, but IMAP mailboxes do not support label actions.
- Fluxmail can create folders. Mail servers separate subfolder levels with their own character, so write a subfolder path the way the folder list shows existing ones, such as `Projects/2026` or `INBOX.Projects.2026`. If the server keeps every folder under a prefix such as `INBOX.` and the name leaves it out, Fluxmail adds it.
- Fluxmail deletes a folder only when it has no messages and no subfolders. IMAP deletes a folder's messages along with it, so Fluxmail counts them right before the delete. A message that another mail app or a server filter files into the folder at that moment is deleted with it.
- Fluxmail can rename a folder, and its subfolders and messages stay in it. A folder's ID is its path, so the folder and its subfolders get new IDs. List the folders again before you use a folder ID from before the rename. Message IDs normally stay the same. If the mail server renumbers the folder's messages, list the folder again to get their new IDs.
- Fluxmail builds threads from the standard `References`, `In-Reply-To`, and `Message-ID` headers.
- Searches run through the IMAP server, so results depend on what that server can index.
- List and search results omit previews by default. Pass `includeSnippet=true` to fetch a short preview from the preferred text part without downloading attachments or complete messages. The `snippets: false` capability means IMAP has no preview available without a body read. It does not disable requested previews.
- Pass `includeSearchContext=true` with a literal text query to fetch an excerpt around the match. Fluxmail scans at most 256 KiB from the preferred text part. If you also request a snippet, both values come from one partial, non-marking body read.

Through MCP or REST, Fluxmail can read and search mail, work with attachments and drafts, send or schedule messages, reply, forward, and organize messages into folders.

Continue with [Connect an MCP client](/docs/connect-an-mcp-client), [Build with REST](/docs/build-with-rest), or [Use the CLI](/docs/use-the-cli).
