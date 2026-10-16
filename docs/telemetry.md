# Telemetry

Fluxmail uses PostHog to count active installations and understand which CLI, MCP, and REST features people use. Telemetry is on by default. It runs in the background, and analytics failures do not affect email operations.

## What Fluxmail sends

Every event contains a random installation ID, the Fluxmail version, the Node.js version, operating system, and architecture. The ID lives at `<data dir>/telemetry.id`. It is separate from the licensing instance ID and is not derived from an email address, license key, hostname, IP address, or machine identifier.

Every package event carries `deployment_type=self_hosted`. Fluxmail Cloud uses `deployment_type=cloud`, and the public website uses `deployment_type=website`. The package sets its label after caller properties so a supplied property cannot change the classification. Older events have no deployment label.

Operation errors with `internal`, `provider_unavailable`, `request_timeout`, `uncertain`, or `account_failure` also produce a synthetic `$exception` for PostHog Error Tracking. The CLI uses `request_timeout` for remote request timeouts and `uncertain` for unknown send outcomes. It reports `canceled`, without an exception, when someone stops an interactive prompt with Ctrl+C or Ctrl+D. MCP and REST use `account_failure` for failed or uncertain delivery results and partial account or item failures. These reports contain the interface, operation, and allowlisted error code, with a stable fingerprint for grouping. They exclude original messages, stacks, causes, and feature properties. Individual input, permission, not-found, and rate-limit errors stay in operation events. Error reporting follows the same telemetry opt-out settings.

| Event                 | `product_surface`    | Other properties                                                                                     |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `operation completed` | `cli`, `mcp`, `rest` | Operation, outcome, duration, and safe properties such as transport or feature mode                  |
| `mcp server started`  | `mcp`                | Transport (`stdio` or `http`), plan, and mailbox and member totals                                   |
| `$exception`          | `cli`, `mcp`, `rest` | Operation and safe failure code for internal, provider, timeout, uncertain-send, or partial failures |

The `operation` property contains the CLI command path, MCP tool name, or REST OpenAPI operation ID. This keeps the event schema consistent while preserving the name used by each interface. The browser callback that finishes a hosted OAuth connection reports `completeHostedConnection` on the `rest` surface, because that request, not the command that printed the link, is where the mailbox is connected.

Batch search reports `emails search-batch`, `search_emails_batch`, or `searchMessages`, depending on the surface. Its outcome is `error` when any account group fails, including mixed results. The event does not contain account IDs, query text, page tokens, or provider error text.

Delivery status, preview, draft retrieval, and body continuation each use their CLI command path, MCP tool name, or REST operation ID. Bulk modification reports an error outcome when any item fails or is uncertain. These events carry no operation ID, message ID, recipient, or body content.

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

## Mailbox connection properties

Mailbox connection and removal events may add these properties to `operation completed`:

| Property                                                             | Values                                   | Meaning                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `provider`                                                           | `gmail`, `outlook`, `imap`               | Which kind of mailbox the operation connects or removes                                                           |
| `connection_flow`                                                    | `hosted`, `loopback`, `imap_credentials` | Whether OAuth returns through the server public URL, local callback port, or IMAP credentials are tested          |
| `oauth_app`                                                          | `built-in`, `custom`                     | Fluxmail's built-in Google application, or an OAuth application the operator registered                           |
| `oauth_callback`                                                     | `listener`, `pasted`, `timeout`          | How a local OAuth redirect reached the CLI, or that none arrived before the command stopped waiting               |
| `reauthorize`                                                        | `true`, `false`                          | Whether the operation reconnected a mailbox that already exists                                                   |
| `connection_stage`                                                   | Fixed stage names                        | Whether setup is validating, preparing OAuth, requesting a connection, checking the provider, saving, or complete |
| `request_timeout_class`                                              | `default`, `custom`, `imap_margin`       | Bounded class for the CLI request deadline; the configured value is not sent                                      |
| `connection_request_duration_ms`                                     | number                                   | Time spent waiting for the account-connection request                                                             |
| `http_status`                                                        | HTTP status or `0`                       | Response status for account-connection requests; `0` means no HTTP response was received                          |
| `failure_kind`                                                       | Fixed categories                         | Broad class such as client timeout, provider error, validation, transport, or HTTP error                          |
| `account_count`                                                      | number                                   | Mailboxes connected to the installation after the change                                                          |
| `gmail_account_count`, `outlook_account_count`, `imap_account_count` | number                                   | The same total split by provider                                                                                  |

`oauth_app` reports the application that issued the tokens, never its client ID or secret. `oauth_callback` appears only on local OAuth connections. A pasted callback URL contains an authorization code and state, so Fluxmail records only that the user pasted it. Outlook always reports `custom`, since Fluxmail ships no built-in Microsoft application. The counts are totals for the installation. They carry no mailbox address, account ID, or member ID.

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
- Mailboxes and members by plan: `mcp server started`, charted as the last `account_count` and `member_count` per installation ID, broken down by `plan`
- Reliability: `operation completed`, broken down by `product_surface`, `outcome`, and `error_code`
- Scheduled sending: `operation completed` filtered to `operation = send_email` or `sendMessage`, broken down by `scheduled`
- Mailboxes per installation: `operation completed` filtered to events that carry `account_count`, charted as the last value per installation ID
- Provider mix: successful connection events that carry `account_count`, broken down by `provider`
- OAuth application adoption: successful connection events that carry both `account_count` and `oauth_app`, broken down by `oauth_app` and `connection_flow`
- Reconnections compared with new mailboxes: successful connection events that carry `account_count`, broken down by `reauthorize`
