---
title: 'Use the CLI'
description: 'Read and manage email, then configure the Fluxmail instance from the same command line.'
updated: '2026-10-06'
---

The Fluxmail CLI can read, draft, send, schedule, and organize email. It also configures and runs the service. Mail commands call the same authenticated REST operations for local and remote instances, so permissions and mailbox access rules stay the same across CLI, MCP, and REST.

Complete the [Quickstart](/docs/quickstart) before using the workflows below.

## Check the instance

```bash
fluxmail status
fluxmail accounts list
fluxmail members list
```

`fluxmail status` reports provider availability, connected mailboxes, and mailboxes that need to be reauthorized.

## Choose a mailbox

Mail commands use the only accessible mailbox when there is exactly one. If you can access several mailboxes, pass the global account option with an account ID or email address:

```bash
fluxmail --mail-account you@example.com emails list --folder inbox
fluxmail -a <account-id> labels list
```

Fluxmail returns an error when it cannot choose one mailbox safely.

## Read and search email

List inbox messages, search across mail, or fetch a complete message or thread:

```bash
fluxmail emails list --folder inbox --read false --page-size 20
fluxmail emails search "from:ann@example.com is:unread quarterly report" --include-search-context true
fluxmail emails search-batch "subject:invoice is:unread" --account <first-account-id> --account <second-account-id>
fluxmail emails get <message-id>
fluxmail threads get <thread-id>
fluxmail emails list --all --max-results 1000
```

The search string uses Fluxmail's [portable search syntax](/docs/email-search). Add `--include-snippet true` to request IMAP previews, or pass `false` to suppress previews. Add `--include-search-context true` to include an excerpt around literal search text. List responses include `meta.nextPageToken` when another page is available. Pass it back with `--page-token` and the same query, page size, snippet setting, and search context setting. Check `meta.exhausted` before treating an empty page as a confirmed negative result.

Use `--all` on `emails list` or `emails search` to follow every page. It stops after 1,000 messages by default. Set `--max-results` to another limit up to 10,000. Set the global `--timeout <seconds>` option when a slow mailbox needs more than the default 30 seconds per request.

`emails search-batch` accepts 1 through 20 repeated `--account` options. It prints every account group and exits nonzero if any group fails. Use `--input <file|->` to send an exact batch request with per-account continuation tokens.

Folders are navigable mailbox locations. Labels are Gmail user labels or Outlook categories:

```bash
fluxmail folders list
fluxmail labels list
```

Gmail user labels appear in both listings because Gmail uses them as mailbox views and message tags. IMAP mailboxes support folders but not labels.

## Draft, send, and forward

Read [Sending and retries](/docs/sending-and-retries) before submitting a delivery. Keep the same idempotency key when retrying the same request.

Build a message with flags:

```bash
fluxmail drafts create \
  --to ann@example.com \
  --subject "Quarterly report" \
  --body-file report.txt \
  --attach report.pdf

fluxmail drafts get <draft-id>

fluxmail emails send \
  --to ann@example.com \
  --subject "Quarterly report" \
  --body "The report is attached." \
  --attach report.pdf \
  --idempotency-key quarterly-report-2026-09
```

Use `--html` or `--html-file` for an HTML body. Repeat `--to`, `--cc`, `--bcc`, and `--attach` as needed. If standard input is redirected and no body option is present, Fluxmail uses standard input as the plain-text body.

For plain-text email, keep each prose paragraph on one continuous line in `--body`, a body file, or standard input. Use a blank line between paragraphs. Fluxmail preserves line breaks, including those in lists and signatures.

Reply, send an existing draft, schedule delivery, or forward a message:

```bash
fluxmail emails preview --reply-to <message-id> --reply-all --body "Thanks, everyone."
fluxmail emails send --reply-to <message-id> --reply-all --body "Thanks, everyone." --idempotency-key reply-2026-09
fluxmail emails send --draft <draft-id> --idempotency-key draft-2026-09
fluxmail emails send --to ann@example.com --body "Later" --send-at 2026-10-01T12:00:00Z --idempotency-key later-2026-09
fluxmail emails forward <message-id> --to lee@example.com --no-attachments --idempotency-key forward-2026-09
fluxmail emails delivery-status <operation-id>
```

Every send and forward needs an idempotency key that you choose. Save the key with the request and reuse it if the command times out or you need to check the result. The response contains an `operationId`. Use `emails delivery-status` to inspect it. If the status is `uncertain`, inspect the recipient mailbox or sent folder before sending again. Reusing the key never starts a second delivery.

## Organize messages

Apply one action to one or more message IDs:

```bash
fluxmail emails modify mark-read <message-id>
fluxmail emails modify archive <message-id-1> <message-id-2>
fluxmail emails modify move <message-id> --folder Projects
fluxmail emails modify add-labels <message-id> --label Customer
```

The available actions are `mark-read`, `mark-unread`, `star`, `unstar`, `archive`, `trash`, `untrash`, `delete`, `move`, `add-labels`, and `remove-labels`. Label actions work with Gmail labels and Outlook categories.

A modify request accepts up to 100 distinct message IDs. Its result lists `succeededIds`, `failed` entries with safe error codes, and `uncertainIds`. Check uncertain messages before retrying. Other IDs continue processing when one fails.

List or cancel scheduled sends:

```bash
fluxmail scheduled list
fluxmail scheduled cancel <schedule-id>
```

## Download attachments

Choose the destination path explicitly:

```bash
fluxmail attachments download <message-id> <attachment-id> --output ./report.pdf
```

Fluxmail will not replace an existing file unless you pass `--force`. Attachment IDs are opaque, so pass them exactly as returned. The command prints JSON metadata after it writes the attachment.

## Send exact REST JSON

Draft, send, forward, and modify commands accept an exact REST request body from a file or standard input:

```bash
fluxmail emails send --input request.json --idempotency-key request-2026-09
fluxmail emails modify --input - < request.json
```

`--input` cannot be combined with flags that build the same request body. Send and forward commands still accept `--idempotency-key` with JSON input.

## Script output and exit codes

The default output is a JSON envelope with `data`, plus `meta` and `warnings` when present. Mail, account list, and root status commands return their API data in `data`. Other management commands wrap their displayed lines in `data`; interactive setup and connection flows still print prompts directly. Use the root `--format table` option for a compact display or `--format ndjson` for one record per line. Errors in JSON and NDJSON mode go to stderr as JSON.

The exit code is `0` for success, `2` for invalid input, `3` for partial or uncertain results, `4` for access errors, `5` for provider or network errors, and `1` for internal or uncategorized errors. Scripts should inspect the response as well as the exit code.

## Run the HTTP server

```bash
fluxmail serve
```

The server listens on port 8977 by default. It provides MCP at `/mcp` and REST at `/api/v1`.

For a local MCP client that uses stdio, the client launches this command instead:

```bash
fluxmail stdio
```

See [Connect an MCP client](/docs/connect-an-mcp-client) for client configuration and transport options.

## Manage mailboxes and members

Connect another mailbox or list the existing mailboxes:

```bash
fluxmail accounts add gmail
fluxmail accounts list
```

Administrators can invite members and share mailboxes with them:

```bash
fluxmail members add --name "Another person" --email person@example.com
fluxmail accounts access <account-id> --share-with person@example.com
```

See [Teams and plans](/docs/teams-and-plans) for mailbox sharing and plan limits.

## Manage API keys

Create a key for an HTTP MCP or REST client:

```bash
fluxmail apikey create --name local-client
```

Fluxmail shows the key once. You can list, change, or revoke keys without exposing their stored secrets:

```bash
fluxmail apikey list
fluxmail apikey permissions <key-id> --profile read-only
fluxmail apikey revoke <key-id>
```

See [Permissions](/docs/permissions) for profiles, custom capabilities, and mailbox restrictions.

## Use the CLI with Docker

Prefix commands with `docker compose exec fluxmail`:

```bash
docker compose exec fluxmail fluxmail status
docker compose exec fluxmail fluxmail accounts list
```

See [Deploy with Docker](/docs/deploy-with-docker) for remote server setup.

## Command reference

Run `fluxmail --help` or add `--help` to a command for terminal help:

```bash
fluxmail accounts add --help
fluxmail emails send --help
```

The [CLI reference](/docs/cli) lists every command and option.

## Update Fluxmail

Follow [Upgrade Fluxmail](/docs/upgrade-fluxmail) to check compatibility and back up the instance before installing a new release.

Fluxmail checks npm for a newer stable release at most once every 24 hours when you run an interactive CLI command. The check runs in the background. If it finds a newer release, a later command prints an update notice to stderr. Registry and cache errors do not affect the command.

Update a global installation:

```bash
npm install -g fluxmail@latest
```

`npx -y fluxmail@latest` already downloads the current stable release. If you use an exact version with `npx`, change the version in the command when you are ready to update.

For Docker, pull the current image and recreate the service:

```bash
docker compose pull fluxmail
docker compose up -d
```

Fluxmail does not show update notices for MCP stdio, redirected output, CI, npm scripts, or `npx` runs. Skip the check for one command with the global option:

```bash
fluxmail --no-update-notifier status
```

Set `NO_UPDATE_NOTIFIER=1` in your shell or container environment to turn off update checks. This variable controls only update checks and is not part of Fluxmail configuration.
