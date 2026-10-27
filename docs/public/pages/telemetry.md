---
title: 'Telemetry'
description: 'See what usage data Fluxmail sends and how to turn it off.'
updated: '2026-10-25'
---

Fluxmail sends anonymous operation events to its PostHog project by default. Events record the CLI command, MCP tool, or REST operation, plus the outcome, duration, selected feature modes, a random installation ID, and basic runtime information.

Each event is labeled `deployment_type=self_hosted` so package usage can be counted separately from Fluxmail Cloud and website traffic.

Internal, provider, timeout, and uncertain-send failures also send a grouped error report with the operation name and a safe error code. MCP and REST reports include partial account or item failures. Reports exclude the original error message, stack trace, and provider response. Turning telemetry off also disables these reports.

When a Gmail, Outlook, or IMAP request fails, the operation event and error report can also record the provider type, the step that failed (such as connecting, searching, or refreshing a token), and a fixed failure reason such as a refused connection, a search timeout, a provider request that took too long, or a missing Gmail permission. They can include the provider's HTTP status and a standard network error code such as `ECONNREFUSED`. Server names, addresses, folder names, and the provider's message are not sent.

For MCP attachment downloads, telemetry records whether the tool returned a resource link, inline content, or text from a PDF page range. It records the same choice if the download fails, without sending the attachment name or content.

For `fluxmail stdio`, telemetry records which startup phase failed, or `ready` when the server starts. The phases cover permission options, local instance selection, configuration and database initialization, session authentication, mailbox selection, and MCP transport startup. No option values or error messages are sent.

Recognized startup failures also record a fixed reason, such as an unconfigured instance, ambiguous local profiles, an unreadable or invalid profile or credentials file, or a missing or invalid session. File-read failures include an allowlisted filesystem error code. Stdio events record whether the data directory came from the environment or the default and whether instance selection was explicit or automatic. They do not include the directory, instance name, session token, file contents, or error text.

Delivery status, send preview, draft retrieval, body continuation, and bulk actions use the same event format. Fluxmail does not send delivery IDs, message IDs, recipients, or message content in these events.

Each MCP message action, such as archiving or moving to Trash, is reported under its own tool name. MCP and REST events for these actions also record which action ran, such as `archive` or `trash`. Folder names and labels are not sent.

When the MCP server starts, telemetry records the plan and how many mailboxes and members the installation has. The plan is sent as Personal, Pro, Team, Business, or Enterprise, and any other plan name is sent as `other`. It does not send the license key or any address.

MCP connection and tool events record the name and version your MCP client reports, such as `Claude Code` or `Cursor`, along with a category such as `claude_code`, `codex`, or `cursor` and the MCP protocol version in use.

After Fluxmail connects or removes a mailbox, telemetry records its provider and the installation's mailbox totals. OAuth connection events also record whether the callback used your public URL or the local port, and whether the provider used Fluxmail's built-in application or one you registered. Local connections record whether the redirect reached Fluxmail directly, you pasted the callback URL, or the command timed out. The pasted URL is never sent. Connection events report whether they replaced credentials for an existing mailbox.

Account setup diagnostics also record a fixed setup stage and failure category, a bounded class for the CLI request deadline, request duration, and HTTP status when available. The actual `--timeout` value and exact server-side IMAP connection-check deadline are not sent. When the CLI receives an account API error, its structured JSON output includes the random request ID also returned by the API and written to local server logs; this ID is not sent to PostHog.

When an MCP client connects with OAuth, telemetry records each registration, sign-in, approval or denial, token request, and revocation with its outcome and OAuth error code. Token events say whether the client exchanged a code or refreshed a token. Client names and URLs, redirect addresses, codes, tokens, permissions, mailboxes, and email addresses are not sent.

Fluxmail never sends command arguments, email or mailbox data, identifiers, search text, file paths, credentials, configuration values, request payloads, provider responses, stack traces, or error text. PostHog person profiles and GeoIP lookup are disabled.

For batch search, telemetry records the surface operation and marks the outcome as an error when any account group fails. Failure details come from the first failed group. It does not include account IDs, queries, page tokens, or group error text.

Turn telemetry off for the installation:

```bash
fluxmail telemetry disable
```

You can also set `FLUXMAIL_TELEMETRY=0` or `DO_NOT_TRACK=1`. Any disabling source takes priority over an enabling source. Use `fluxmail telemetry status` to check the effective state.
