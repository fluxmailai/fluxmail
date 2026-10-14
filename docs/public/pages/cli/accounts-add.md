---
title: 'fluxmail accounts add'
description: 'Connect a Gmail, Outlook, or IMAP account'
updated: '2026-07-15'
---

<!-- This page is generated from the CLI command definitions. Run pnpm docs:generate to update it. -->

`fluxmail accounts add`

Connect a Gmail, Outlook, or IMAP account

## Usage

```bash
fluxmail accounts add <provider> [options]
```

## Arguments

| Name | Required | Details | Default |
| --- | --- | --- | --- |
| `provider` | Yes | Email provider: gmail, outlook, or imap | None |

## Options

| Option | Required | Details | Default |
| --- | --- | --- | --- |
| `--reauthorize <account-id>` | No | Reconnect an existing account | None |
| `--local` | No | Use the local browser callback for OAuth | None |
| `--hosted` | No | Use FLUXMAIL_PUBLIC_URL for the OAuth callback | None |
| `--email <address>` | No | Mailbox address (required for IMAP) | None |
| `--display-name <name>` | No | Sender name for IMAP messages | None |
| `--imap-host <host>` | No | IMAP server hostname | None |
| `--imap-port <port>` | No | IMAP server port | `993` |
| `--imap-security <mode>` | No | IMAP security: tls or starttls; defaults to tls on port 993, otherwise starttls | None |
| `--imap-user <user>` | No | IMAP username; defaults to the mailbox address | None |
| `--imap-password-env <name>` | No | Read the IMAP password from this environment variable | None |
| `--smtp-host <host>` | No | SMTP server hostname | None |
| `--smtp-port <port>` | No | SMTP server port | `587` |
| `--smtp-security <mode>` | No | SMTP security: tls or starttls; defaults to tls on port 465, otherwise starttls | None |
| `--smtp-user <user>` | No | SMTP username; defaults to the IMAP username | None |
| `--smtp-password-env <name>` | No | Read a separate SMTP password from this environment variable | None |
| `--sent-folder <path>` | No | Sent mailbox path | None |
| `--drafts-folder <path>` | No | Drafts mailbox path | None |
| `--trash-folder <path>` | No | Trash mailbox path | None |
| `--archive-folder <path>` | No | Archive mailbox path | None |
| `--spam-folder <path>` | No | Spam mailbox path | None |
| `--no-save-sent` | No | Do not append SMTP submissions to the Sent folder | None |
