# Changelog

Fluxmail records user-facing changes in this file. The format follows [Common Changelog](https://common-changelog.org/).

## [Unreleased]

### Changed

- [MCP] **Breaking:** Replace `modify_emails` with one tool per action: `mark_emails_read`, `mark_emails_unread`, `star_emails`, `unstar_emails`, `archive_emails`, `move_emails`, `add_labels`, `remove_labels`, `trash_emails`, `restore_emails`, and `delete_emails`; clients pick up the new tools the next time they list tools, but prompts or scripts that call `modify_emails` by name must use the matching tool instead, while the CLI and REST API are unchanged ([#152](https://github.com/fluxmailai/fluxmail/pull/152))
- [MCP] Mark `move_emails`, `trash_emails`, and `delete_emails` as destructive and the other change tools as non-destructive, so clients can ask for confirmation only where mail can be lost ([#152](https://github.com/fluxmailai/fluxmail/pull/152))

## [0.15.0] - 2026-10-16

### Changed

- Require Node.js 22.22 or later and drop support for Node.js 20; upgrade Node.js before installing this release, while Docker installations need no changes; [upgrade Node.js](https://fluxmail.ai/docs/upgrades/0.15.0/) ([#144](https://github.com/fluxmailai/fluxmail/pull/144))
- [MCP / CLI / REST] Add the provider, failing step, fixed failure reason, provider HTTP status, and network error code to anonymous telemetry for failed mail operations ([#146](https://github.com/fluxmailai/fluxmail/pull/146))

### Fixed

- Fix startup failures after installing Fluxmail with npm 12, which skips dependency install scripts ([#144](https://github.com/fluxmailai/fluxmail/pull/144))
- [MCP / CLI / REST] Return the IMAP folders a search already finished when a later folder passes the search time limit, instead of failing the whole search ([#145](https://github.com/fluxmailai/fluxmail/pull/145))
- [MCP / CLI / REST] Report Gmail requests that lack Gmail permission as `auth_expired` and mark the account for reconnection ([#145](https://github.com/fluxmailai/fluxmail/pull/145))
- [CLI / REST] Reject a Google connection when the Gmail permission was cleared on the consent screen and ask to connect again with it selected ([#145](https://github.com/fluxmailai/fluxmail/pull/145))
- [CLI] Cancel interactive prompts on Ctrl+D as well as Ctrl+C ([#145](https://github.com/fluxmailai/fluxmail/pull/145))

## [0.14.0] - 2026-10-16

Only the breaking entries for the interfaces you use apply. A REST-only integration, for example, does not need the stdio, attachment, or IMAP setup migrations.

### Changed

- [MCP] **Breaking:** Start `fluxmail stdio` read-only when it has no `--profile` or `--allow`; add the profile each client needs, such as `--profile full`, to its stdio arguments; [choose stdio profiles before upgrading](https://fluxmail.ai/docs/upgrades/0.14.0/) ([#130](https://github.com/fluxmailai/fluxmail/pull/130))
- [CLI / REST] **Breaking:** Create API keys with the `read-only` profile when no permissions are given; pass `--profile` to `fluxmail apikey create` or `permissionProfile` to `POST /api/v1/me/api-keys` for broader access, while existing keys keep their profiles; [create keys with the access they need](https://fluxmail.ai/docs/upgrades/0.14.0/) ([#130](https://github.com/fluxmailai/fluxmail/pull/130))
- [MCP / REST] **Breaking:** Remove permanent deletion from the `full` profile, including existing API keys, stdio connections, and MCP bundle installations that use it; add `--allow mail.delete` to `--profile full` for clients that permanently delete mail, while CLI commands are unaffected; [restore permanent deletion](https://fluxmail.ai/docs/upgrades/0.14.0/) ([#130](https://github.com/fluxmailai/fluxmail/pull/130))
- [MCP] **Breaking:** Return inline PNG, JPEG, GIF, and WebP attachments from `download_attachment` as `image` content and UTF-8 text attachments as resource `text`, including attachment resource reads; read those fields instead of base64 `blob` for those types; [update attachment readers](https://fluxmail.ai/docs/upgrades/0.14.0/) ([#139](https://github.com/fluxmailai/fluxmail/pull/139))
- [CLI] **Breaking:** Choose the `fluxmail accounts add imap` security mode from the port when `--imap-security` or `--smtp-security` is omitted, using `tls` on ports 993 and 465 and `starttls` on other ports; pass `--imap-security tls` for implicit TLS on another IMAP port; [set the security mode explicitly](https://fluxmail.ai/docs/upgrades/0.14.0/) ([#137](https://github.com/fluxmailai/fluxmail/pull/137))
- [MCP / REST] Name the missing capabilities and the command that enables them in permission errors, and tell MCP agents which actions are disabled for the connection ([#130](https://github.com/fluxmailai/fluxmail/pull/130))
- [MCP] Remove server and tool instructions that told agents to avoid other tools and email connectors ([#139](https://github.com/fluxmailai/fluxmail/pull/139))
- [MCP] Name the Claude Code plugin Fluxmail Self-Hosted ([#138](https://github.com/fluxmailai/fluxmail/pull/138))
- [CLI / REST] Add setup stage, timeout, request duration, HTTP status, and failure category to anonymous account setup telemetry ([#136](https://github.com/fluxmailai/fluxmail/pull/136))

### Added

- [MCP] Extract text from inline PDF attachments in `download_attachment`, including Chinese, Japanese, and Korean PDFs with predefined encodings, and read later page ranges with `pages` ([#139](https://github.com/fluxmailai/fluxmail/pull/139))
- [MCP] Add a title and read-only, destructive, and idempotent hints to every tool ([#139](https://github.com/fluxmailai/fluxmail/pull/139))
- [MCP] Make `accountId` optional in `download_attachment` when exactly one account is connected ([#139](https://github.com/fluxmailai/fluxmail/pull/139))
- [MCP] Add a permission profile setting to the MCP bundle that defaults to `full` and keeps a saved choice ([#130](https://github.com/fluxmailai/fluxmail/pull/130)) ([#134](https://github.com/fluxmailai/fluxmail/pull/134))
- [CLI] Accept `--allow` with `--profile` to add capabilities to a profile ([#130](https://github.com/fluxmailai/fluxmail/pull/130))
- [CLI / REST] Return a request ID with account setup errors and record it in local server logs ([#136](https://github.com/fluxmailai/fluxmail/pull/136))

### Fixed

- [CLI] Wait 5 seconds past the server's 30-second connection test in `fluxmail accounts add imap` so it reports the server's result instead of a request timeout ([#135](https://github.com/fluxmailai/fluxmail/pull/135))
- [CLI / REST] Stop waiting for an SMTP greeting after 10 seconds and suggest checking the security mode when an IMAP or SMTP TLS setting does not match the port ([#137](https://github.com/fluxmailai/fluxmail/pull/137))
- [MCP] Return the attachment URI as text to clients that use an MCP protocol version older than 2025-06-18 ([#139](https://github.com/fluxmailai/fluxmail/pull/139))

## [0.13.0] - 2026-10-08

### Changed

- [MCP / CLI] Stop delivering scheduled mail from stdio sessions; run `fluxmail serve` or `fluxmail scheduled run` against the same data directory to keep delivery running; [update stdio-only installations](https://fluxmail.ai/docs/sending-and-retries/#keep-scheduled-delivery-running) ([#125](https://github.com/fluxmailai/fluxmail/pull/125))
- Advance the SQLite store to format 6 for persistent retry deadlines; stop all processes sharing the store and back it up before upgrading, and restore that backup for rollback; [prepare existing installations](https://fluxmail.ai/docs/upgrade-fluxmail/) ([#125](https://github.com/fluxmailai/fluxmail/pull/125))
- Use `ghcr.io/fluxmailai/fluxmail` for Docker images and `io.github.fluxmailai/fluxmail` in the MCP Registry after the repository move ([#126](https://github.com/fluxmailai/fluxmail/pull/126))
- [CLI] Record safe stdio startup failure reasons, filesystem error codes, and selection categories in anonymous telemetry without collecting paths, credentials, or option values ([#122](https://github.com/fluxmailai/fluxmail/pull/122))

### Added

- [CLI] Add `fluxmail scheduled run` to process scheduled delivery for the whole local instance without starting HTTP or MCP ([#125](https://github.com/fluxmailai/fluxmail/pull/125))

### Fixed

- [MCP / CLI / REST] Preserve scheduled-send retry delays across worker restarts, discover schedules created by other processes, and renew delivery claims during slow sends ([#125](https://github.com/fluxmailai/fluxmail/pull/125))
- [MCP / CLI / REST] Drain active HTTP requests, scheduled deliveries, and license refreshes before closing the store on shutdown, and keep HTTP MCP operations running after clients disconnect ([#125](https://github.com/fluxmailai/fluxmail/pull/125))

## [0.12.0] - 2026-10-05

### Changed

- [MCP / CLI / REST] Label anonymous telemetry as self-hosted and send grouped operational error reports using safe error codes; [turn telemetry off](https://fluxmail.ai/docs/configuration/) to disable both ([#118](https://github.com/churichard/fluxmail/pull/118))

### Added

- [MCP] Add a Claude Code plugin that starts the matching stable Fluxmail release with read-only permissions; enable telemetry by default and honor existing opt-outs ([#114](https://github.com/churichard/fluxmail/pull/114)) ([#120](https://github.com/churichard/fluxmail/pull/120))

### Fixed

- [MCP / CLI] Select the sole local profile for stdio when it has a custom name and the active profile is remote or missing, and name the selected profile in login instructions ([#113](https://github.com/churichard/fluxmail/pull/113))
- [MCP] Accept `null` for optional tool inputs and treat it as omission so clients that require explicit values can call tools without unused filters or draft fields ([#116](https://github.com/churichard/fluxmail/pull/116))

## [0.11.2] - 2026-10-02

### Changed

- [CLI] Record successful stdio startup or the phase that failed in anonymous telemetry without collecting option values or error messages ([#110](https://github.com/churichard/fluxmail/pull/110))

### Fixed

- [MCP / CLI] Keep stdio connected to the local profile when the active CLI instance is remote ([#110](https://github.com/churichard/fluxmail/pull/110))
- [CLI] Validate stdio permissions and local login before opening the store, report invalid permission options as `invalid_request`, and close resources when startup fails ([#110](https://github.com/churichard/fluxmail/pull/110))
- [MCP / CLI / REST] Enforce Outlook attachment size limits on downloaded bytes so overstated Graph metadata does not reject valid files ([#111](https://github.com/churichard/fluxmail/pull/111))
- [MCP / CLI / REST] Read Outlook inline attachment metadata with the correct Microsoft Graph field selection ([#111](https://github.com/churichard/fluxmail/pull/111))
- [MCP / CLI / REST] Reduce temporary copies for Gmail attachments and release unused Outlook response bodies after sends and attachment uploads ([#111](https://github.com/churichard/fluxmail/pull/111))

## [0.11.1] - 2026-09-28

### Fixed

- [MCP] Fix tool output schemas so strict clients can call Fluxmail tools ([#107](https://github.com/churichard/fluxmail/pull/107))

## [0.11.0] - 2026-09-25

### Changed

- [MCP] **Breaking:** Pass `idempotencyKey` to `send_email` and `forward_email`, read the delivery operation instead of a sent message, and use `get_delivery_operation` to check its status; [update MCP send clients before upgrading](https://fluxmail.ai/docs/upgrades/0.11.0/) ([#98](https://github.com/churichard/fluxmail/pull/98))
- [CLI] **Breaking:** Pass `--idempotency-key` to `emails send` and `emails forward`, read the delivery operation instead of a sent message, and use `emails delivery-status` to check its status; [update CLI send commands before upgrading](https://fluxmail.ai/docs/upgrades/0.11.0/) ([#98](https://github.com/churichard/fluxmail/pull/98))
- [REST] **Breaking:** Read a delivery operation instead of a sent message from send and forward requests, retain `Idempotency-Key`, and use the delivery status endpoint to check the outcome; [update REST send clients before upgrading](https://fluxmail.ai/docs/upgrades/0.11.0/) ([#98](https://github.com/churichard/fluxmail/pull/98))
- [MCP / CLI / REST] **Breaking:** Read `succeededIds`, `failed`, and `uncertainIds` instead of `modified` from bulk message actions, and keep each request to 100 distinct message IDs; [update bulk action clients before upgrading](https://fluxmail.ai/docs/upgrades/0.11.0/) ([#98](https://github.com/churichard/fluxmail/pull/98))
- [MCP] **Breaking:** Follow pages from `get_thread`, use `get_email_body` to continue truncated bodies, and set `inline` to embed attachment bytes; [update MCP readers before upgrading](https://fluxmail.ai/docs/upgrades/0.11.0/) ([#98](https://github.com/churichard/fluxmail/pull/98))
- [CLI] **Breaking:** Parse the default JSON envelope instead of command text, and handle the new exit codes for input, partial, access, and provider errors; [update CLI scripts before upgrading](https://fluxmail.ai/docs/upgrades/0.11.0/) ([#98](https://github.com/churichard/fluxmail/pull/98))
- Advance stored data from format 3 to 5 for delivery operations; stop processes that share the data directory and back it up before upgrading because older releases cannot open the migrated store; [prepare existing installations](https://fluxmail.ai/docs/upgrades/0.11.0/) ([#98](https://github.com/churichard/fluxmail/pull/98))
- [MCP / CLI / REST] Keep email operations available for seven days after a paid plan lowers mailbox or member limits below current usage, and prevent new additions until usage fits the plan ([#104](https://github.com/churichard/fluxmail/pull/104))
- Record the plan and mailbox and member totals when the MCP server starts, using `other` for unrecognized plan names; [review the anonymous telemetry settings](https://fluxmail.ai/docs/configuration/) ([#102](https://github.com/churichard/fluxmail/pull/102))
- [MCP] Guide agents to keep plain-text email paragraphs on one line when drafting or forwarding messages ([#101](https://github.com/churichard/fluxmail/pull/101))

### Added

- [MCP / CLI / REST] Fetch drafts and preview recipients and sender details before sending ([#98](https://github.com/churichard/fluxmail/pull/98))

### Fixed

- [MCP / CLI / REST] Reuse proxy connections for Gmail API requests and Google sign-in to avoid repeated tunnels during searches ([#99](https://github.com/churichard/fluxmail/pull/99))
- [MCP / CLI / REST] Send the proxy hostname during TLS negotiation with an HTTPS Google proxy so it can select the correct certificate ([#100](https://github.com/churichard/fluxmail/pull/100))

## [0.10.0] - 2026-09-23

### Changed

- Record whether a local OAuth connection used the browser redirect, a pasted callback URL, or timed out in anonymous telemetry ([#91](https://github.com/churichard/fluxmail/pull/91))

### Added

- [CLI] Finish Gmail and Outlook account connections from a browser on another computer by pasting the callback URL into the waiting terminal ([#91](https://github.com/churichard/fluxmail/pull/91))
- [MCP / CLI / REST] Add optional search context excerpts to Gmail, Outlook, and IMAP results, with match and availability statuses ([#92](https://github.com/churichard/fluxmail/pull/92))

### Fixed

- [MCP / CLI / REST] Save IMAP drafts with multiline bodies on strict servers and show the server's rejection reason when an IMAP command fails ([#93](https://github.com/churichard/fluxmail/pull/93))

## [0.9.0] - 2026-09-16

### Changed

- Advance stored data to format 3 for send-as identities; stop processes that share the data directory and keep the migration backup because older Fluxmail releases cannot open the upgraded store; [prepare existing installations before upgrading](https://fluxmail.ai/docs/upgrades/0.9.0/) ([#88](https://github.com/churichard/fluxmail/pull/88))
- Require custom provider authors to return `MessageSearchPage.exhausted` from `EmailProvider.listMessages`; set it only after the provider has examined the full requested scope, and [update custom providers before upgrading](https://fluxmail.ai/docs/upgrades/0.9.0/) ([#89](https://github.com/churichard/fluxmail/pull/89))
- [MCP / CLI / REST] Bound searches with a soft time budget and hard deadline, return resumable pages at safe boundaries, and report whether each requested scope is exhausted ([#89](https://github.com/churichard/fluxmail/pull/89))

### Added

- [MCP / CLI / REST] Expose available send-as identities and accept an available sender for draft, forward, immediate send, and scheduled send operations ([#88](https://github.com/churichard/fluxmail/pull/88))
- [CLI / REST] Configure send-as addresses for Outlook and IMAP accounts while Gmail continues to use provider-managed identities ([#88](https://github.com/churichard/fluxmail/pull/88))
- [MCP / CLI / REST] Add multi-account search through MCP `search_emails_batch`, CLI `emails search-batch`, and REST `POST /api/v1/messages/search`, with per-account pagination, partial failures, and optional message previews ([#89](https://github.com/churichard/fluxmail/pull/89))

### Fixed

- [MCP / CLI / REST] Keep slow searches resumable without skipping or repeating messages, and preserve successful account results when another account fails ([#89](https://github.com/churichard/fluxmail/pull/89))
- [MCP / CLI / REST] Keep IMAP attachment IDs stable and treat them as opaque values when downloading attachments ([#89](https://github.com/churichard/fluxmail/pull/89))

## [0.8.1] - 2026-09-14

### Fixed

- [CLI] Recreate the missing `local` instance profile when logging in to an existing local instance ([#85](https://github.com/churichard/fluxmail/pull/85))
- [CLI] Reject `fluxmail setup` on an already configured instance and point at login instead ([#85](https://github.com/churichard/fluxmail/pull/85))
- [CLI] Clarify the missing-instance error and align `instances` table output ([#85](https://github.com/churichard/fluxmail/pull/85))

## [0.8.0] - 2026-09-01

### Changed

- Relicense Fluxmail under the [Elastic License 2.0](https://github.com/churichard/fluxmail/blob/main/LICENSE.md), which permits use, modification, and redistribution but does not permit circumventing license key functionality or offering Fluxmail as a hosted service ([#80](https://github.com/churichard/fluxmail/pull/80))
- Record the mailbox provider, OAuth flow, OAuth application kind, and installation mailbox counts in anonymous telemetry, and report the browser callback that finishes a hosted connection as `completeHostedConnection`; [turn telemetry off](https://fluxmail.ai/docs/configuration/) to opt out ([#83](https://github.com/churichard/fluxmail/pull/83))

### Fixed

- [CLI] Fail `fluxmail accounts add gmail` and `fluxmail accounts add outlook` before printing a connection link when `FLUXMAIL_PUBLIC_URL` selects the hosted flow without a suitable OAuth application, and offer `--local` ([#82](https://github.com/churichard/fluxmail/pull/82))
- [CLI / REST] Name `FLUXMAIL_PUBLIC_URL` in hosted Gmail and Outlook connection errors so the setting that selected the flow is clear ([#82](https://github.com/churichard/fluxmail/pull/82))

## [0.7.0] - 2026-07-25

Only the breaking entries for the interfaces you use apply. An MCP-only integration, for example, does not need the CLI or REST migrations.

### Changed

- [CLI] **Breaking:** CLI users must replace `--unread-only` with `--read false`, replace `--starred-only` with `--starred true`, pass a boolean to `--has-attachment`, treat `--text` as literal text, use typed syntax for `emails search`, and discard existing page tokens; [update CLI commands before upgrading](https://fluxmail.ai/docs/upgrades/0.7.0/) ([#76](https://github.com/churichard/fluxmail/pull/76))
- [MCP] **Breaking:** MCP clients must replace the `unreadOnly` and `starredOnly` search arguments with `read` and `starred`, treat `list_emails.text` as literal text, use typed syntax for `search_emails.query`, and discard existing page tokens; [update MCP clients before upgrading](https://fluxmail.ai/docs/upgrades/0.7.0/) ([#76](https://github.com/churichard/fluxmail/pull/76))
- [REST] **Breaking:** REST clients must replace the `unreadOnly` and `starredOnly` message query parameters with `read` and `starred`, treat `text` as literal text, and discard existing page tokens; [update REST requests before upgrading](https://fluxmail.ai/docs/upgrades/0.7.0/) ([#76](https://github.com/churichard/fluxmail/pull/76))
- **Breaking:** Custom provider authors must handle `EmailQuery.read` and `EmailQuery.starred` instead of `unreadOnly` and `starredOnly`, treat `text` as literal text, add the required `Capabilities.search` field, and support both values for every advertised boolean filter; [update custom providers before upgrading](https://fluxmail.ai/docs/upgrades/0.7.0/) ([#76](https://github.com/churichard/fluxmail/pull/76))
- [MCP / CLI / REST] Reject unsupported search filters and provider-native queries before CLI, MCP, or REST requests reach a built-in or custom provider ([#77](https://github.com/churichard/fluxmail/pull/77))

### Added

- [MCP / CLI / REST] Add typed portable search syntax to CLI `emails search`, MCP `search_emails`, and the REST `query` parameter, with parser diagnostics in MCP and REST results ([#76](https://github.com/churichard/fluxmail/pull/76))
- [MCP / CLI / REST] Apply portable search normalization and capability checks consistently across CLI, MCP, REST, and email providers ([#76](https://github.com/churichard/fluxmail/pull/76))
- [MCP / CLI / REST] Add signed, query-bound page tokens that expire after one hour, plus provider-aware filtered pagination with incomplete-page metadata and canonical attachment checks ([#76](https://github.com/churichard/fluxmail/pull/76))

## [0.6.1] - 2026-07-23

### Fixed

- Stop local IMAP CLI commands from hanging after completion ([#72](https://github.com/churichard/fluxmail/pull/72))

## [0.6.0] - 2026-07-21

### Changed

- **Breaking:** replace `config.env` and automatic working-directory dotenv loading with typed `config.toml` deployment settings and encrypted OAuth and license records in SQLite; [back up the data directory and migrate existing configuration](https://fluxmail.ai/docs/upgrades/0.6.0/) before starting Fluxmail 0.6.0 ([#69](https://github.com/churichard/fluxmail/pull/69))
- **Breaking:** replace `fluxmail config set`, `unset`, and `list` with `config init`, `config show`, `config migrate`, and focused `oauth` commands; update scripts and integrations before upgrading ([#69](https://github.com/churichard/fluxmail/pull/69))
- **Breaking:** advance shared stores to format 2 and remove the public `config.env` and dotenv mutation helpers; do not open an upgraded store with an older release, and migrate package consumers to the typed configuration APIs ([#69](https://github.com/churichard/fluxmail/pull/69))
- **Breaking:** add the required `listLabels` method to the public `EmailProvider` interface; custom provider implementations must add the method before upgrading to `@fluxmail/core` 0.6.0 ([#66](https://github.com/churichard/fluxmail/pull/66))
- Reduce the paid license grace period after lease expiration from 21 days to 7 days ([#67](https://github.com/churichard/fluxmail/pull/67))

### Added

- Add CLI workflows for listing, searching, drafting, sending, forwarding, organizing, and scheduling email, plus attachment downloads ([#66](https://github.com/churichard/fluxmail/pull/66))
- Add Gmail user labels and Outlook categories across providers, MCP, REST, and the CLI ([#66](https://github.com/churichard/fluxmail/pull/66))
- Add authenticated REST operations for viewing, configuring, and resetting Google and Microsoft OAuth applications ([#69](https://github.com/churichard/fluxmail/pull/69))
- Add bounded, redacted local error logs with configurable destinations, rotation, and the `fluxmail logs` command ([#68](https://github.com/churichard/fluxmail/pull/68))
- Add daily update notices to interactive CLI commands with command-line and environment opt-outs ([#65](https://github.com/churichard/fluxmail/pull/65))
- Add `_FILE` environment variables for the encryption key, OAuth client secrets, and license key ([#69](https://github.com/churichard/fluxmail/pull/69))

### Fixed

- Preserve existing Microsoft OAuth scopes during refresh and retry invalid passwords in interactive CLI login ([#66](https://github.com/churichard/fluxmail/pull/66))
- Keep configuration updates in sync across running processes and preserve the OAuth application used by existing and in-flight account connections ([#69](https://github.com/churichard/fluxmail/pull/69))
- Ignore missing Gmail labels during removal instead of failing the whole modification ([#66](https://github.com/churichard/fluxmail/pull/66))

## [0.5.0] - 2026-07-18

### Changed

- **Breaking:** require member authentication for every instance, remove `FLUXMAIL_AUTH=none`, revoke legacy API keys during migration, and require a backup to return to an older version; [back up the data directory and claim the instance](https://fluxmail.ai/docs/upgrades/0.5.0/) before reconnecting clients ([#58](https://github.com/churichard/fluxmail/pull/58))
- **Breaking:** replace the `Account` fields `ownerId`, `sharingMode`, `sharedMemberIds`, and `memberId` with `ownerMemberId`, `sharedWithAll`, and `grantedMemberIds`; update API clients to use the new fields ([#58](https://github.com/churichard/fluxmail/pull/58))
- **Breaking:** make the CLI use named local or remote instances for administration, and require a logged-in local session before starting stdio MCP ([#58](https://github.com/churichard/fluxmail/pull/58))
- Record CLI, MCP, and REST operations with one anonymous telemetry schema that excludes arguments, request data, identifiers, and error messages ([#55](https://github.com/churichard/fluxmail/pull/55))

### Added

- Add password login, member sessions, enrollment and reset flows, member status controls, scoped API keys, mailbox access grants, and append-only security audits ([#58](https://github.com/churichard/fluxmail/pull/58))
- Add instance setup, login, logout, instance switching, session management, and member administration commands to the CLI ([#58](https://github.com/churichard/fluxmail/pull/58))
- Add member and session authentication, self-service mailbox and API key management, and administrative member and audit operations to the REST API ([#58](https://github.com/churichard/fluxmail/pull/58))
- Use Fluxmail's built-in Desktop Google OAuth app for local Gmail connections while keeping custom clients available for local and hosted setups ([#56](https://github.com/churichard/fluxmail/pull/56))

### Fixed

- Keep the Google OAuth client that issued each stored Gmail refresh token so existing accounts continue to refresh after an app configuration change ([#60](https://github.com/churichard/fluxmail/pull/60))
- Serialize shared database migrations, stored configuration writes, and encryption key creation to protect concurrent Fluxmail processes ([#59](https://github.com/churichard/fluxmail/pull/59))

## [0.4.1] - 2026-07-17

### Changed

- Point package and registry metadata at `churichard/fluxmail`, with container images at `ghcr.io/churichard/fluxmail` ([#53](https://github.com/churichard/fluxmail/pull/53))

## [0.4.0] - 2026-07-16

### Changed

- **Breaking:** require every new mailbox, API key, and stdio connection to name a member; existing memberless API keys become management-only credentials and can no longer read mail ([#34](https://github.com/churichard/fluxmail/pull/34))
- **Breaking:** identify a mailbox by its email address across providers; on first startup, keep the Gmail connection when duplicates exist, or otherwise keep the oldest connection, and remove the other duplicates ([#34](https://github.com/churichard/fluxmail/pull/34))
- **Breaking:** exclude Spam and Trash from queries that omit `folder` or use `folder: "all"`; query either folder directly to include those messages ([#49](https://github.com/churichard/fluxmail/pull/49))
- **Breaking:** add required `sharingMode` and `sharedMemberIds` fields to `Account`, replace its deprecated `memberId` field with `ownerId`, and add required `supplementalCapabilities` to `PermissionPolicy` ([#34](https://github.com/churichard/fluxmail/pull/34))
- **Breaking:** require an authenticated key with `admin.accounts` for `POST /auth/connections`, even when `FLUXMAIL_AUTH=none`, and require HTTPS for remote administrative requests ([#44](https://github.com/churichard/fluxmail/pull/44))
- Require mailbox owners to reassign or delete their mailboxes before removing the member ([#34](https://github.com/churichard/fluxmail/pull/34))
- Separate mail permissions from the `admin.accounts`, `admin.api_keys`, and `admin.license` capabilities ([#44](https://github.com/churichard/fluxmail/pull/44))

### Added

- Add Microsoft 365 and Outlook.com support through Microsoft Graph, including local PKCE and hosted OAuth flows ([#40](https://github.com/churichard/fluxmail/pull/40))
- Add a JSON REST API at `/api/v1` with an OpenAPI 3.1 schema, raw attachment downloads, and stored idempotency results for sends and forwards ([#41](https://github.com/churichard/fluxmail/pull/41))
- Add authenticated administrative REST endpoints for mailbox connections, API keys, and license activation, with explicit capabilities and audit records ([#44](https://github.com/churichard/fluxmail/pull/44))
- Add member roles, private and shared mailbox access, selected-member sharing, and mailbox allowlists for API keys and stdio connections ([#34](https://github.com/churichard/fluxmail/pull/34))

### Fixed

- Check Outlook attachment metadata before downloading content when a size limit is active, avoiding unnecessary buffering for oversized files ([#42](https://github.com/churichard/fluxmail/pull/42))
- Preserve the separate Trash and Archive permissions in Outlook move operations, including moves that use Microsoft folder aliases ([#43](https://github.com/churichard/fluxmail/pull/43))
- Prevent hosted Microsoft OAuth responses from forwarding connection credentials through the HTTP referrer ([#43](https://github.com/churichard/fluxmail/pull/43))
- Stop a pending IMAP connection immediately when its provider closes during setup ([#49](https://github.com/churichard/fluxmail/pull/49))

[Unreleased]: https://github.com/fluxmailai/fluxmail/compare/v0.15.0...HEAD
[0.4.0]: https://github.com/churichard/fluxmail/compare/v0.3.0...v0.4.0
[0.4.1]: https://github.com/churichard/fluxmail/compare/v0.4.0...v0.4.1
[0.5.0]: https://github.com/churichard/fluxmail/compare/v0.4.1...v0.5.0
[0.6.0]: https://github.com/churichard/fluxmail/compare/v0.5.0...v0.6.0
[0.6.1]: https://github.com/churichard/fluxmail/compare/v0.6.0...v0.6.1
[0.7.0]: https://github.com/churichard/fluxmail/compare/v0.6.1...v0.7.0
[0.8.0]: https://github.com/churichard/fluxmail/compare/v0.7.0...v0.8.0
[0.8.1]: https://github.com/churichard/fluxmail/compare/v0.8.0...v0.8.1
[0.9.0]: https://github.com/churichard/fluxmail/compare/v0.8.1...v0.9.0
[0.10.0]: https://github.com/churichard/fluxmail/compare/v0.9.0...v0.10.0
[0.11.0]: https://github.com/churichard/fluxmail/compare/v0.10.0...v0.11.0
[0.11.1]: https://github.com/churichard/fluxmail/compare/v0.11.0...v0.11.1
[0.11.2]: https://github.com/churichard/fluxmail/compare/v0.11.1...v0.11.2
[0.12.0]: https://github.com/churichard/fluxmail/compare/v0.11.2...v0.12.0
[0.13.0]: https://github.com/fluxmailai/fluxmail/compare/v0.12.0...v0.13.0
[0.14.0]: https://github.com/fluxmailai/fluxmail/compare/v0.13.0...v0.14.0
[0.15.0]: https://github.com/fluxmailai/fluxmail/compare/v0.14.0...v0.15.0
