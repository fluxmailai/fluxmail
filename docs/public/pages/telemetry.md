---
title: 'Telemetry'
description: 'Turn off anonymous telemetry and see what usage data and optional feedback Fluxmail sends.'
updated: '2026-10-25'
---

Fluxmail sends anonymous usage events and error reports to its PostHog project by default. You can turn them off without disabling email operations or feedback you explicitly choose to send.

## Turn telemetry off

```bash
fluxmail telemetry disable
```

You can also set `FLUXMAIL_TELEMETRY=0` or `DO_NOT_TRACK=1`. Any disabling source takes priority over an enabling source. Use `fluxmail telemetry status` to check the effective state. These settings disable both usage events and error reports.

## Collected data

Events include a random installation ID, the Fluxmail and Node.js versions, operating system and architecture. They identify the installation as self-hosted. Operation events record the CLI command, MCP tool or REST operation, its outcome, duration and selected feature modes.

Depending on the operation, events can also include:

- Provider diagnostics: Gmail, Outlook or IMAP, the step that failed (such as connecting, searching or refreshing a token), a fixed failure category (such as a refused connection, timeout or missing Gmail permission), the provider's HTTP status and a standard network error code such as `ECONNREFUSED`. Internal, provider, timeout and uncertain-send failures also produce error reports with the operation name and a safe error code. Partial account or item failures count as errors; batch search diagnostics describe the first failed account group.
- Feature choices: the message action, such as archive or trash, or whether an MCP attachment download returned a resource link, inline content or text from a PDF page range. Attachment destination is recorded on failures too.
- Stdio startup diagnostics: the phase that failed or `ready`, fixed reasons for recognized instance and session failures, and allowlisted filesystem error codes. Phases cover permission options, instance selection, configuration and database initialization, authentication, mailbox selection and transport startup. Events indicate whether the data directory came from the environment or the default and whether instance selection was explicit or automatic.
- Installation size: the plan and mailbox and member counts when the MCP server starts. Plans are Personal, Pro, Team, Business, Enterprise or `other`. Mailbox connection and removal events include provider type and mailbox totals, including totals by provider.
- Mailbox setup diagnostics: whether OAuth used the public URL or a local callback, a built-in or custom provider application, and a direct callback, pasted callback or timeout. Events can indicate reauthorization, a fixed setup stage and failure category, request duration, HTTP status and a bounded category for the CLI request deadline.
- MCP client metadata: the client's self-reported name and version, limited to 128 and 64 characters, a client category such as `claude_code`, `codex` or `cursor`, and the MCP protocol version. The name and version retain the text the client supplies.
- MCP OAuth activity: registration, sign-in, approval or denial, token requests and revocation, with outcomes and OAuth error codes. Token events distinguish code exchange from refresh.

## Data excluded from anonymous telemetry

Except for the MCP client's self-reported name and version described above, anonymous telemetry excludes command arguments, email and mailbox data, identifiers, search text, file paths, credentials, configuration values and request payloads. It never sends provider responses, original error messages or stack traces. PostHog person profiles and GeoIP lookup are disabled.

Excluded details include server names and addresses, folder names and labels, attachment names and content, recipients, message and delivery IDs, account IDs, page tokens, instance names, session tokens and file contents. Setup events exclude pasted callback URLs, exact timeout settings and the request ID returned in CLI errors and local server logs. MCP OAuth activity excludes client names and URLs, redirect addresses, codes, tokens, permissions, mailboxes and email addresses; the client name and version on MCP connection and tool events are the separate exception above. Startup plan reporting excludes license keys and addresses.

## Feedback you choose to send

When you explicitly ask an MCP client to submit feedback, `send_feedback` sends the message, category, product type, package version and any approved diagnostics and reply address to the Fluxmail Cloud feedback intake. This works even when anonymous telemetry is disabled. Review and confirm the message, diagnostics and exact optional reply address before submitting. A client must never choose or attach a connected mailbox address automatically. You can choose another address or send feedback without one. Exclude mail contents, attachments, raw tool arguments, logs, credentials, full connected-account lists and conversation history. When telemetry is enabled, the operation event records success or failure without the message, category, diagnostics, reply address or feedback ID.

Cloud stores reports and the chosen reply address privately for 90 days and sends them to PostHog, Linear and optional team notifications. Those downstream copies have separate retention policies. The reply address is labeled user-provided and unverified. It is not verified, automatically emailed, or used for authentication or as a PostHog identity. See [sending feedback](/docs/tools#send-feedback) for supported diagnostics, submission limits, data-transfer details and the administrator setting that disables submissions.
