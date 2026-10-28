# Telemetry

Fluxmail uses PostHog to count active installations and understand which CLI, MCP, and REST features people use. Telemetry is on by default. It runs in the background, and analytics failures do not affect email operations.

## What Fluxmail sends

Every event contains a random installation ID, the Fluxmail version, the Node.js version, operating system, and architecture. The ID lives at `<data dir>/telemetry.id`. It is separate from the licensing instance ID and is not derived from an email address, license key, hostname, IP address, or machine identifier.

Every package event carries `deployment_type=self_hosted`. Fluxmail Cloud uses `deployment_type=cloud`, and the public website uses `deployment_type=website`. The package sets its label after caller properties so a supplied property cannot change the classification. Older events have no deployment label.

Operation errors with `internal`, `provider_unavailable`, `request_timeout`, `uncertain`, or `account_failure` also produce a synthetic `$exception` for PostHog Error Tracking. The CLI uses `request_timeout` for remote request timeouts and `uncertain` for unknown send outcomes. It reports `canceled`, without an exception, when someone stops an interactive prompt with Ctrl+C or Ctrl+D. MCP and REST use `account_failure` for failed or uncertain delivery results and partial account or item failures. These reports contain the interface, operation, allowlisted error code, and any [provider failure properties](#provider-failure-properties), with a stable fingerprint for grouping. They exclude original messages, stacks, causes, and feature properties. Individual input, permission, not-found, and rate-limit errors stay in operation events. Error reporting follows the same telemetry opt-out settings.

| Event                  | `product_surface`    | Other properties                                                                                                                                                                                                            |
| ---------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation completed`  | `cli`, `mcp`, `rest` | Operation, outcome, duration, and safe properties such as transport, feature mode, or MCP client category                                                                                                                   |
| `mcp server started`   | `mcp`                | Transport (`stdio` or `http`), plan, and mailbox and member totals                                                                                                                                                          |
| `mcp client connected` | `mcp`                | `operation=initialize` or `operation=server/discover`, `outcome=success`, transport (`stdio` or `http`), a fixed `mcp_client` category, the reported `mcp_client_name` and `mcp_client_version`, and `mcp_protocol_version` |
| `$exception`           | `cli`, `mcp`, `rest` | Operation and safe failure code for internal, provider, timeout, uncertain-send, or partial failures                                                                                                                        |

### MCP client identity

After the SDK validates a legacy MCP `initialize` or modern `server/discover` request and sends a successful response, Fluxmail records `mcp client connected`. Failed requests, tool listing, tool calls, and `notifications/initialized` do not produce this connection event. Each successful initialization or discovery can produce an event, including repeated probes. Modern clients can call tools without discovery; those calls do not produce a connection event, but their operation events still carry the client properties.

The `mcp_client` property comes from `initialize.params.clientInfo.name` for legacy clients and the per-request `io.modelcontextprotocol/clientInfo` metadata for modern discovery. MCP tool events read the tool call's `io.modelcontextprotocol/clientInfo` metadata for modern requests and the connection's `initialize` request for legacy stdio clients. Legacy HTTP is stateless, so its tool calls carry no client name and report `unknown`. Fluxmail trims whitespace, lowercases the name, and replaces runs of spaces, underscores, and hyphens with an underscore before checking exact aliases. It does not use substring matching or inspect parent processes or environment variables to identify a client. Names longer than 128 characters are classified as `other`. `mcp_client_name` carries the reported name with surrounding whitespace removed. It is omitted when the name is missing, blank, not a string, or longer than 128 characters. `mcp_client_version` carries the reported `clientInfo.version` the same way, up to 64 characters.

`mcp_protocol_version` is the MCP revision, such as `2025-06-18` or `2026-07-28`. Legacy initialization uses the negotiated version in its result. Discovery and modern tool calls use the per-request `io.modelcontextprotocol/protocolVersion` metadata. Legacy tool calls use the `MCP-Protocol-Version` header over HTTP or the negotiated version over stdio, so legacy HTTP tool calls report a protocol version even though they have no client name. Values that are not a `YYYY-MM-DD` date are omitted.

The fixed categories are `claude`, `claude_desktop`, `claude_code`, `codex`, `cursor`, `chatgpt`, `vscode`, `windsurf`, `cline`, `roo_code`, `goose`, `zed`, `muse`, `other`, and `unknown`. Generic `claude` and `claude-ai` names map to `claude`; they cannot distinguish Desktop from web. Nonempty names without an exact alias map to `other`. Missing, non-string, or blank names map to `unknown` in the classifier, though the SDK rejects initialize requests with missing or non-string names.

Client titles, capabilities, user-agent headers, and request or session IDs are not sent. Client identity is self-reported and may be inaccurate, and a custom client can put any text in its name or version. MCP tool and `server/discover` operation events carry the same client and protocol properties. CLI and REST events do not.

Collection begins when an installation upgrades to a package release containing this event and has telemetry enabled. Older installations and disabled telemetry are not covered, and there is no historical backfill. Connection event totals count successful initializations and discovery requests, not unique people or installations. Tool events from earlier releases have no client properties.

### Operation properties

The `operation` property contains the CLI command path, MCP tool name, or REST OpenAPI operation ID. This keeps the event schema consistent while preserving the name used by each interface. The browser callback that finishes a hosted OAuth connection reports `completeHostedConnection` on the `rest` surface, because that request, not the command that printed the link, is where the mailbox is connected.

`server/discover` also records an MCP operation event when the connected SDK transport sends its response, with outcome, duration, transport, client properties, and `invalid_request` for a rejected discovery. Requests rejected by the SDK before a server instance is connected do not produce this event. No protocol metadata or request contents are collected.

MCP OAuth requests report on the `rest` surface as `oauthRegister`, `oauthClientMetadata`, `oauthAuthorize`, `oauthConsent`, `oauthToken`, and `oauthRevoke`. Errors carry the OAuth error code, such as `invalid_grant` or `invalid_scope`, or a fixed code such as `expired_request` or `cross_origin`. `oauthAuthorize` records `client_kind` as `registered` or `metadata_document`. `oauthClientMetadata` runs when Fluxmail fetches a client metadata document and records `metadata_source` as `fetched` or `stale`. `oauthConsent` records `step` as `sign_in` or `approve` and, once the member decides, `consent` as `approved` or `denied`. `oauthToken` records `grant_type` as `authorization_code` or `refresh_token`. These events never include client IDs or URLs, redirect URIs, state, codes, tokens, scopes, mailbox IDs, email addresses, or passwords.

Batch search reports `emails search-batch`, `search_emails_batch`, or `searchMessages`, depending on the surface. Its outcome is `error` when any account group fails, including mixed results. Provider failure properties describe the first failed group. The event does not contain account IDs, query text, page tokens, or provider error text.

Delivery status, preview, draft retrieval, and body continuation each use their CLI command path, MCP tool name, or REST operation ID. Bulk modification reports an error outcome when any item fails or is uncertain. These events carry no operation ID, message ID, recipient, or body content.

MCP exposes each message action as its own tool, so bulk modification reports an operation such as `mark_emails_read`, `archive_emails`, `move_emails`, or `trash_emails`. Earlier versions reported every MCP action as `modify_emails`. REST reports `modifyMessages`. Both surfaces also record `action` as `markRead`, `markUnread`, `star`, `unstar`, `archive`, `move`, `addLabels`, `removeLabels`, `trash`, `untrash`, or `delete`, so a breakdown by `action` compares MCP and REST and spans the rename. These events never include folder names or labels.

MCP attachment downloads record `destination` as `resource` for a link, `inline` for embedded content, or `pdf_pages` for a PDF page range read without `inline`. The same value is recorded when the download fails. The event does not contain an attachment ID, name, or content.

CLI `stdio` operations record `startup_phase` as one of `permissions`, `instance`, `context`, `authentication`, `account_scope`, `transport`, or `ready`. Failed starts report the phase that failed; successful starts report `ready`. This distinguishes invalid permission options, local instance selection, configuration or database initialization, session authentication, mailbox selection, and MCP transport startup without collecting option values, instance names, paths, credentials, or error messages. A successful CLI `stdio` operation means the server started, not that a later MCP tool call succeeded.

Stdio events also record `startup_data_dir_source=environment|default` and `startup_instance_selection=explicit|automatic`. These describe whether the launch supplied a data directory or selected an instance by name. The directory and instance name are never sent.

Recognized instance and session failures add an allowlisted `startup_reason`:

| Value                          | Meaning                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `instance_not_configured`      | No CLI instance was selected or configured                |
| `instance_not_found`           | The selected instance is absent from the profile file     |
| `local_instance_required`      | Stdio selected a remote profile                           |
| `local_instance_ambiguous`     | Several local profiles require an explicit choice         |
| `instance_config_read_failed`  | The CLI profile file could not be read                    |
| `instance_config_invalid_json` | The CLI profile file contains invalid JSON                |
| `credentials_read_failed`      | The session credentials file could not be read            |
| `credentials_invalid_json`     | The session credentials file contains invalid JSON        |
| `session_missing`              | The selected local profile has no session token           |
| `session_invalid`              | The session token did not authenticate as a local session |

File-read failures also record `startup_io_code`: `EACCES`, `EPERM`, `EISDIR`, `ENOTDIR`, `EIO`, `EMFILE`, `ENFILE`, `ELOOP`, `ENAMETOOLONG`, or `unknown`. Other failures omit this property. Unclassified failures retain their phase and safe error code without a reason. Local `cli.operation_failed` records include the same startup properties in `details`; their error message stays local. None of these diagnostic properties are sent after telemetry is disabled.

## Provider failure properties

When a mail operation fails inside Gmail, Outlook, or IMAP, `operation completed` and the matching `$exception` may add these properties. Each value comes from a fixed list. A property is left out when Fluxmail cannot classify it, and none of them appear on successful operations.

| Property               | Values                                                                                                                                                                                                                                                                | Meaning                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `provider`             | `gmail`, `outlook`, `imap`                                                                                                                                                                                                                                            | Which kind of mailbox failed                                             |
| `failure_phase`        | `connect`, `folders`, `select`, `search`, `fetch`, `smtp`, `token_refresh`, `request`                                                                                                                                                                                 | The provider step that failed. Gmail and Outlook API calls use `request` |
| `failure_reason`       | `search_timeout`, `insufficient_scope`, `connection_refused`, `host_not_found`, `network_unreachable`, `connection_timeout`, `connection_reset`, `tls_mismatch`, `tls_error`, `server_no`, `server_bad`, `http_error`, `invalid_response`, `other`, `request_timeout` | Why the step failed                                                      |
| `provider_http_status` | HTTP status from 100 to 599                                                                                                                                                                                                                                           | Status returned by the Gmail, Microsoft Graph, or Microsoft OAuth API    |
| `io_code`              | Node.js network and TLS codes such as `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, or `CERT_HAS_EXPIRED`, or `other`                                                                                                                                                     | The system error code behind a network failure                           |

`server_no` and `server_bad` mean the IMAP server answered a command with `NO` or `BAD`. The server's response text is not sent. `request_timeout` means a Gmail or Microsoft Graph request hit its deadline before the provider responded. A request cancelled for another reason is not counted as a timeout. `io_code` is limited to the codes listed in `FAILURE_IO_CODES` in `packages/core/src/errors.ts`; any other code is sent as `other`. These properties never include hostnames, ports, mailbox addresses, folder names, search text, or provider messages.

CLI commands that use a local instance handle the request in the same process. The REST layer records its failure properties in memory and passes them to the CLI event, so the operation is still counted once.

## Mailbox connection properties

Mailbox connection and removal events may add these properties to `operation completed`:

| Property                                                             | Values                                   | Meaning                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `provider`                                                           | `gmail`, `outlook`, `imap`               | Which kind of mailbox the operation connects or removes                                                           |
| `connection_flow`                                                    | `hosted`, `loopback`, `imap_credentials` | Whether OAuth returns through the server public URL, local callback port, or IMAP credentials are tested          |
| `oauth_app`                                                          | `built-in`, `custom`                     | Fluxmail's built-in Google or Microsoft application, or an OAuth application the operator registered              |
| `oauth_callback`                                                     | `listener`, `pasted`, `timeout`          | How a local OAuth redirect reached the CLI, or that none arrived before the command stopped waiting               |
| `reauthorize`                                                        | `true`, `false`                          | Whether the operation reconnected a mailbox that already exists                                                   |
| `connection_stage`                                                   | Fixed stage names                        | Whether setup is validating, preparing OAuth, requesting a connection, checking the provider, saving, or complete |
| `request_timeout_class`                                              | `default`, `custom`, `imap_margin`       | Bounded class for the CLI request deadline; the configured value is not sent                                      |
| `connection_request_duration_ms`                                     | number                                   | Time spent waiting for the account-connection request                                                             |
| `http_status`                                                        | HTTP status or `0`                       | Response status for account-connection requests; `0` means no HTTP response was received                          |
| `failure_kind`                                                       | Fixed categories                         | Broad class such as client timeout, provider error, validation, transport, or HTTP error                          |
| `account_count`                                                      | number                                   | Mailboxes connected to the installation after the change                                                          |
| `gmail_account_count`, `outlook_account_count`, `imap_account_count` | number                                   | The same total split by provider                                                                                  |

`oauth_app` reports the application that issued the tokens, never its client ID or secret. `oauth_callback` appears only on local OAuth connections. A pasted callback URL contains an authorization code and state, so Fluxmail records only that the user pasted it. The counts are totals for the installation. They carry no mailbox address, account ID, or member ID.

Account setup diagnostics use fixed stage and failure categories, request timing, a bounded request timeout class, and HTTP status. The configured CLI timeout and exact server-side IMAP connection-check deadline are not sent. When the CLI receives an account API error, its structured JSON output includes the random request ID also returned by the API and written to local server logs. The ID is not sent to PostHog. These diagnostics never include mailbox addresses, server hostnames, request payloads, credentials, provider messages, or stacks.

The account counts appear only after Fluxmail has connected or removed a mailbox. Events that prepare an OAuth link do not include them because the user may never finish the browser flow. `reauthorize` is left out when the surface cannot tell a reconnection from a new mailbox, such as a CLI IMAP connection against a remote instance, where the server matches the mailbox by address and reports the answer in its own event.

## Server start properties

`mcp server started` also records the installation's plan and size:

| Property        | Values                                                       | Meaning                                                                                                     |
| --------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `plan`          | `personal`, `pro`, `team`, `business`, `enterprise`, `other` | The plan in effect at startup, including a paid plan in grace. Any other lease plan name is sent as `other` |
| `account_count` | number                                                       | Mailboxes connected to the installation                                                                     |
| `member_count`  | number                                                       | Members on the installation                                                                                 |

These are totals only. They carry no license key, license ID, mailbox address, account ID, or member ID. If Fluxmail cannot read them, the event is sent without them.

Use `deployment_type` to compare Cloud and self-hosted traffic in PostHog. Use `product_surface` to compare CLI, MCP, and REST operations within a deployment type. The website uses `product_surface=landing_page`.

PostHog person profiles and GeoIP lookup are disabled. The PostHog SDK adds its library name, library version, and server marker.

## What Fluxmail does not send

Telemetry does not include:

- Command arguments or option values
- Email addresses, recipients, or connected mailbox addresses
- Account, message, thread, draft, schedule, or attachment IDs
- Search queries, subjects, message bodies, labels, or folder names
- Attachment names, local file paths, or downloaded content
- OAuth credentials, API keys, license keys, passwords, or config values
- Error messages, stack traces, or provider responses
- Raw MCP client names, versions, titles, capabilities, user-agent headers, or request and session IDs

## Turn telemetry off

Disable telemetry for the installation:

```bash
fluxmail telemetry disable
```

The command stores the choice in the Fluxmail data directory. It takes precedence over `FLUXMAIL_TELEMETRY=1`, and the disable command itself does not send an event.

Check or change the setting with:

```bash
fluxmail telemetry status
fluxmail telemetry enable
```

You can also set `FLUXMAIL_TELEMETRY=0` or `DO_NOT_TRACK=1` in the process environment. Either variable keeps telemetry disabled after `fluxmail telemetry enable`.

## Suggested PostHog reports

Use unique installation IDs rather than total event counts when measuring adoption.

- Active installations: unique users for `operation completed`
- Product usage: `operation completed`, broken down by `product_surface`
- MCP feature adoption: `operation completed` filtered to `product_surface = mcp`, broken down by `operation`
- REST feature adoption: `operation completed` filtered to `product_surface = rest`, broken down by `operation`
- CLI feature adoption: `operation completed` filtered to `product_surface = cli`, broken down by `operation`
- Transport adoption: `mcp server started`, broken down by `transport`
- MCP client adoption: unique installation IDs (`distinct_id`) for `mcp client connected`, filtered to `deployment_type=self_hosted` and broken down by `mcp_client`
- Mailboxes and members by plan: `mcp server started`, charted as the last `account_count` and `member_count` per installation ID, broken down by `plan`
- Reliability: `operation completed`, broken down by `product_surface`, `outcome`, and `error_code`
- Scheduled sending: `operation completed` filtered to `operation = send_email` or `sendMessage`, broken down by `scheduled`
- Mailboxes per installation: `operation completed` filtered to events that carry `account_count`, charted as the last value per installation ID
- Provider mix: successful connection events that carry `account_count`, broken down by `provider`
- OAuth application adoption: successful connection events that carry both `account_count` and `oauth_app`, broken down by `oauth_app` and `connection_flow`
- Reconnections compared with new mailboxes: successful connection events that carry `account_count`, broken down by `reauthorize`

For an MCP client adoption report over the past 30 days, count each installation once per client category:

```sql
SELECT
    properties.mcp_client AS mcp_client,
    count(DISTINCT distinct_id) AS installations
FROM events
WHERE event = 'mcp client connected'
    AND properties.deployment_type = 'self_hosted'
    AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY properties.mcp_client
ORDER BY installations DESC
```

Reconnects do not increase a category's installation count. An installation that connects through several clients appears in each category, so adding the category counts can exceed the overall installation count. These IDs identify installations, not people. The report covers enabled telemetry after upgrade; it cannot recover earlier client usage or assign a client to historical tool calls.

## Explicit feedback submissions

`send_feedback` uses the existing `operation completed` event with `product_surface=mcp`, outcome, duration, transport and MCP client properties. It adds no feature properties. The feedback message, category, report ID and intake URL are excluded from operation telemetry and local failure logs.

The feedback payload is a separate, explicit support submission to the configured Cloud origin's `/api/feedback`, independent of anonymous telemetry consent. It contains only `message`, `category`, `product=self_hosted` and the valid installed package version. Cloud retains reports privately for 90 days and routes them through PostHog to Linear, with optional team email. Those downstream copies have separate retention. `FLUXMAIL_FEEDBACK_ENABLED=0` or `[feedback] enabled = false` blocks the support request without changing telemetry settings.
