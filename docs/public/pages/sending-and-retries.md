---
title: "Sending and retries"
description: "Preview a send, track its delivery, and retry without sending a duplicate."
updated: '2026-11-06'
---

Sending requires `mail.send`. Choose the mailbox, recipients, and message before submitting a send. You can inspect a saved draft or preview a request first. Previewing does not deliver email.

## Preview the message

Use MCP `preview_send`, CLI `emails preview`, or REST `/accounts/<account-id>/send/preview` to resolve the sender, reply recipients, subject, and attachment metadata. To inspect an existing draft, use `get_draft`, `drafts get`, or `GET /accounts/<account-id>/drafts/<draft-id>`.

See [Send from another address](/docs/send-as-addresses) if you want to use an existing mailbox alias. Fluxmail does not create the alias at your provider.

## Give each delivery a stable key

Create an idempotency key for each intended send or forward, and save it with the request before calling Fluxmail:

| Interface | Where to pass the key |
| --- | --- |
| MCP | `idempotencyKey` on `send_email` or `forward_email` |
| REST | `Idempotency-Key` request header |
| CLI | `--idempotency-key` on `emails send` or `emails forward` |

Reuse the same key when retrying the same request. New delivery-operation keys have no automatic expiry and are scoped to the authenticated credential. Reusing a key with different request data returns a conflict. See the [0.11.0 migration guide](/docs/upgrades/0.11.0) for legacy REST records with a 24-hour lifetime.

Do not switch credentials or create a new key to retry a request whose outcome you have not established.

## Check the delivery operation

A send returns an `operationId` and a status. Save the returned ID; do not assume it is the same as your idempotency key.

| Status | What to do |
| --- | --- |
| `queued` | Wait for the scheduled delivery. |
| `sending` | Check the operation again. |
| `succeeded` | Delivery completed; the result includes the sent message ID. |
| `failed` | Inspect the failure before deciding what to do next. |
| `uncertain` | Check the Sent folder or recipient before making any new send request. The provider may have delivered it. |

Use MCP `get_delivery_operation`, CLI `emails delivery-status`, or REST `GET /accounts/<account-id>/delivery-operations/<operation-id>` to check the result. Fluxmail does not automatically retry an uncertain delivery under the same key.

MCP marks failed and uncertain sends as tool errors, but the structured result still includes the operation ID and status. Read that result before retrying. If a request times out before you receive its result, retry the same request with the same credential and key to recover the saved operation.

## Schedule a message

Use the sending interface's `sendAt` field or CLI scheduling option. Forwards can be scheduled the same way. Fluxmail saves the scheduled message as a draft in the mailbox. Edits to the draft go out with it. A connection without `mail.send` can't edit a draft that's waiting to send; cancel the scheduled send first. A scheduled forward is saved when you schedule it, with the original message's attachments, so later changes to the original don't affect it. `fluxmail serve` or `fluxmail scheduled run` must be running against the same store for delivery. Stdio connections never start a delivery worker. Queued mail stays stored while the worker is stopped; overdue mail may send when it starts again. Retry delays survive worker restarts.

Review pending schedules before restoring a backup or restarting an instance after a long outage. Use the [MCP tools](/docs/tools), [CLI guide](/docs/use-the-cli), or [REST reference](/docs/rest-api) to list and cancel scheduled sends.

## Keep scheduled delivery running

For a stdio-only installation, run a persistent worker on the computer that stores the schedules:

```bash
FLUXMAIL_DATA_DIR=/path/to/your/fluxmail-data fluxmail scheduled run
```

Use the same `FLUXMAIL_DATA_DIR` as the stdio clients. The runner uses local deployment configuration independently of the active CLI profile and needs no CLI login session. An explicit `--instance` must name an existing local profile. Omit `--mail-account`: the runner processes all mailboxes in the instance.

The worker runs in the foreground. Keep it running with your process supervisor and allow at least 45 seconds for shutdown. SIGINT, SIGTERM, and SIGHUP stop new delivery and wait up to 30 seconds for active work. A second signal forces termination.

For remote HTTP installations, schedules live on the server and `serve` continues delivery after clients disconnect. Docker's existing `serve` process handles delivery; no extra worker is needed. The standalone runner reads storage on its own host, which can be a VPS. It cannot consume another server's queue over HTTP.

Workers may share one SQLite store on the same host. Do not share the store over a network filesystem. Claims reduce conflicting work, but cannot guarantee exactly-once delivery by an external mail provider. If a delivery outcome is uncertain, check Sent before sending again.

## Before restarting an existing instance

Starting `fluxmail serve`, `fluxmail scheduled run`, or the Docker service starts the instance-wide scheduler. Overdue scheduled messages can send immediately. A client's read-only profile and mailbox restrictions apply to its tool calls; the worker processes the whole instance. Starting `fluxmail stdio` leaves schedules queued.

Before restarting an instance, inspect pending schedules with a one-shot local CLI command for each mailbox you can access:

```bash
fluxmail --instance <local-name> --mail-account <account-id> scheduled list
```

For a stopped Docker installation, use a one-shot container with the existing data volume:

```bash
docker compose run --rm --no-deps -T fluxmail \
  --instance local --mail-account <account-id> scheduled list
```

These commands do not start the scheduler. If your saved session has expired, log in with a one-shot local command before listing schedules. Ask the instance operator to review mailboxes your member cannot access. Resume the instance only when you intend its pending deliveries to run. A connection test does not require canceling or changing those schedules.

## Preserve paragraph formatting

For plain-text email, keep each prose paragraph on one continuous line and separate paragraphs with blank lines. This applies to MCP `bodyText`, REST `body.text`, and a forward's `comment`. Fluxmail preserves line breaks, so fixed-width wrapping appears as short lines in the recipient's mail app. Lists and signatures can use intentional line breaks.

See [Send email](/docs/tools/send-email) for MCP inputs or [the REST send endpoint](/docs/rest-api/send-message) for request fields.
