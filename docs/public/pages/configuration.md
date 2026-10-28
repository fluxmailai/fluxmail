---
title: 'Configuration'
description: 'Deployment configuration, encrypted instance settings, outbound proxies, local logging, secret files, and telemetry controls.'
updated: '2026-10-06'
---

Deployment settings control startup, storage paths, and the server address. Instance settings hold OAuth applications and the license. Start with the setting you need to change:

| Task | Where to change it | Restart? |
| --- | --- | --- |
| Change the port, public URL, or storage path | `config.toml` or process environment | Yes |
| Configure a Google or Microsoft OAuth app | `fluxmail oauth configure` | No, unless using environment overrides |
| Activate a license | `fluxmail license activate` | No, unless using environment overrides |
| Inspect effective settings and their sources | `fluxmail config show` and `fluxmail oauth status` | No |

## Deployment configuration

Deployment settings are resolved in this order:

1. Built-in defaults
2. `<data dir>/config.toml`
3. Process environment variables

Changes to deployment settings require a restart. Run `fluxmail config init` to create a starter file with owner-only permissions. Run `fluxmail config show` to see effective values, their sources, and the paths Fluxmail is using.

`FLUXMAIL_DATA_DIR` stays outside `config.toml` because it tells Fluxmail where to find the file. It defaults to `~/.fluxmail`, or `/data` in the Docker image.

A typical file looks like this:

```toml
[storage]
database_path = "/var/lib/fluxmail/fluxmail.db"

[server]
port = 8977
public_url = "https://mail.example.com"
trust_proxy = false
max_attachment_mb = 10

[oauth.local]
host = "127.0.0.1"
port = 8976
```

Fluxmail rejects unknown TOML keys, invalid types, and values outside their allowed ranges. It does not change `process.env` while resolving settings.

## Instance settings

Custom Google and Microsoft OAuth applications and the license key are stored as encrypted records in SQLite. Changes made with `fluxmail oauth configure`, `fluxmail oauth reset`, or `fluxmail license activate` take effect immediately. You do not need to restart the server.

Use `fluxmail oauth status` to see client IDs, tenant IDs, configuration state, and source categories. Status output never includes client secrets, ciphertext, secret-file paths, or environment values.

Environment variables can override a complete provider group. When a provider comes from the environment, authenticated commands and APIs cannot replace or reset it until you remove the overrides and restart Fluxmail.

- Google requires both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Microsoft requires `MICROSOFT_CLIENT_ID` when any Microsoft override is present. `MICROSOFT_TENANT_ID` defaults to `common`. Public clients can omit `MICROSOFT_CLIENT_SECRET`.

## Secret storage

Fluxmail encrypts instance settings and provider credentials with AES-256-GCM before writing them to SQLite. Encrypted values use a versioned storage envelope so future releases can migrate the format safely.

The encryption key is resolved from one source:

1. `FLUXMAIL_ENCRYPTION_KEY`
2. `FLUXMAIL_ENCRYPTION_KEY_FILE`
3. `<data dir>/encryption.key`

Fluxmail generates `<data dir>/encryption.key` with owner-only permissions when no external key is configured. Back up this file with the database. A database backup is not usable without the matching key. Follow [Back up and restore](/docs/backup-and-restore) to preserve the complete installation.

For managed deployments, use `*_FILE` variables instead of putting secrets directly in the process environment. Fluxmail supports files for `FLUXMAIL_ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`, and `FLUXMAIL_LICENSE_KEY`. Paths must be absolute. Fluxmail reads UTF-8, removes one final newline, rejects empty files, and leaves externally managed file permissions unchanged.

## Import an env file

Fluxmail does not read `config.env`, `.env.local`, or `.env` files. Import settings from an existing file before starting Fluxmail:

```bash
fluxmail config migrate --from /absolute/path/to/old.env --dry-run
fluxmail config migrate --from /absolute/path/to/old.env
```

If the source file sets `FLUXMAIL_DATA_DIR`, that directory is the migration target. Otherwise, the command uses `FLUXMAIL_DATA_DIR` from the process environment or the default data directory.

The command validates imported deployment values and checks the database format before writing anything. If the target database already contains encrypted values, you must provide its existing encryption key. Fluxmail will not generate a replacement key for that database. The command writes deployment settings to `config.toml`, stores OAuth applications and the license in encrypted SQLite records, and preserves the source file. If the encrypted settings step fails, Fluxmail removes only the new `config.toml` and `encryption.key` files created by that import. Run `fluxmail config show` and `fluxmail oauth status` after the import. Remove the old `config.env` after you verify the result.

Docker Compose and process-manager env files still work because those tools populate the process environment before Fluxmail starts.

## Outbound proxy

If Gmail or Google sign-in requests need an HTTP proxy, set `HTTPS_PROXY` in the Fluxmail process environment before starting the server. Fluxmail also accepts `https_proxy`, `HTTP_PROXY`, and `http_proxy`. When several are set, it uses the first of `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, and `http_proxy`. Use an `http://` or `https://` proxy URL.

Fluxmail keeps proxy connections open on supported Node.js versions. A Gmail search can reuse a tunnel while reading messages. With an `https://` proxy, Fluxmail includes the proxy hostname in the TLS handshake so the proxy can present the right certificate.

To send some requests directly, list hosts in `NO_PROXY` (or `no_proxy`), separated by commas. Each entry can be:

- `*`, which skips the proxy for every host
- A hostname, such as `gmail.googleapis.com`
- A domain suffix, such as `.googleapis.com` or `*.googleapis.com`
- An origin, such as `https://gmail.googleapis.com`

These variables apply to Gmail API and Google sign-in requests. They do not change Outlook or IMAP connections. Restart Fluxmail after changing them.

## Local logs

Fluxmail writes bounded local logs for failures and low-volume service events. Successful MCP, REST, and CLI operations are not logged. See [Local logs](/docs/logging) for the file location, the 20 MiB disk limit, viewing commands, and privacy notes.

## Setting reference

<!-- BEGIN GENERATED:configuration -->
| Setting | Primary storage | Environment override | Default | Applies | Purpose |
| --- | --- | --- | --- | --- | --- |
| `deployment.data_dir` | External | `FLUXMAIL_DATA_DIR` | `~/.fluxmail (/data in Docker)` | Restart | Directory for the SQLite database, deployment configuration, and generated encryption key. |
| `storage.database_path` | `storage.database_path` | `FLUXMAIL_DB_PATH` | `<data dir>/fluxmail.db` | Restart | Override the SQLite database path. |
| `deployment.encryption_key` | External | `FLUXMAIL_ENCRYPTION_KEY`<br>`FLUXMAIL_ENCRYPTION_KEY_FILE` | `generated automatically` | Restart | A 64-character hexadecimal key used to encrypt credentials and instance secrets. |
| `server.port` | `server.port` | `FLUXMAIL_PORT` | `8977` | Restart | HTTP server port. |
| `server.public_url` | `server.public_url` | `FLUXMAIL_PUBLIC_URL` | `http://localhost:<FLUXMAIL_PORT>` | Restart | Public base URL used for HTTP APIs, hosted OAuth callbacks, and MCP client sign-in. MCP OAuth requires HTTPS or a loopback address. |
| `server.trust_proxy` | `server.trust_proxy` | `FLUXMAIL_TRUST_PROXY` | `false` | Restart | Trust forwarded protocol and client address headers from a reverse proxy. |
| `oauth.local.port` | `oauth.local.port` | `FLUXMAIL_OAUTH_PORT` | `8976` | Restart | Port for the local OAuth callback listener. |
| `oauth.local.host` | `oauth.local.host` | `FLUXMAIL_OAUTH_HOST` | `127.0.0.1` | Restart | Bind address for the local OAuth callback listener. |
| `server.max_attachment_mb` | `server.max_attachment_mb` | `FLUXMAIL_MAX_ATTACHMENT_MB` | `10` | Restart | Largest decoded attachment returned through MCP or REST, from 1 through 25 MB. |
| `logging.level` | `logging.level` | `FLUXMAIL_LOG_LEVEL` | `info` | Restart | Minimum severity retained by the bounded local logger. |
| `logging.destination` | `logging.destination` | `FLUXMAIL_LOG_DESTINATION` | `both` | Restart | Write local logs to both the rotating file and console, or choose file or console. |
| `feedback.enabled` | `feedback.enabled` | `FLUXMAIL_FEEDBACK_ENABLED` | `true` | Restart | Allow explicit feedback submissions to Fluxmail support, independently of anonymous telemetry. |
| `feedback.cloud_origin` | `feedback.cloud_origin` | `FLUXMAIL_FEEDBACK_CLOUD_ORIGIN` | `https://cloud.fluxmail.ai` | Restart | Cloud origin hosting the feedback intake. Override for development and testing. |
| `oauth.google.client_id` | Encrypted SQLite | `GOOGLE_CLIENT_ID` | `Fluxmail Desktop OAuth app` | Immediate; env: restart | Override the built-in Google OAuth client ID. |
| `oauth.google.client_secret` | Encrypted SQLite | `GOOGLE_CLIENT_SECRET`<br>`GOOGLE_CLIENT_SECRET_FILE` | `Fluxmail Desktop OAuth app` | Immediate; env: restart | Override the built-in Google OAuth client secret. Required with GOOGLE_CLIENT_ID. |
| `oauth.microsoft.client_id` | Encrypted SQLite | `MICROSOFT_CLIENT_ID` | `Fluxmail Self-Hosted Entra app` | Immediate; env: restart | Override the built-in Microsoft Entra application client ID. |
| `oauth.microsoft.client_secret` | Encrypted SQLite | `MICROSOFT_CLIENT_SECRET`<br>`MICROSOFT_CLIENT_SECRET_FILE` | `required for hosted Outlook connections` | Immediate; env: restart | Microsoft Entra application client secret. |
| `oauth.microsoft.tenant_id` | Encrypted SQLite | `MICROSOFT_TENANT_ID` | `common` | Immediate; env: restart | Microsoft Entra tenant ID or verified domain. |
| `license.key` | Encrypted SQLite | `FLUXMAIL_LICENSE_KEY`<br>`FLUXMAIL_LICENSE_KEY_FILE` | `none` | Immediate; env: restart | Paid-plan license key, normally stored with fluxmail license activate. |
| `telemetry.enabled` | Data directory marker | `FLUXMAIL_TELEMETRY` | `1` | Before startup | Set to 0 to turn off anonymous CLI, MCP, and REST usage telemetry. |
| `telemetry.do_not_track` | Data directory marker | `DO_NOT_TRACK` | `unset` | Before startup | Set to 1 to turn off anonymous usage telemetry. |
<!-- END GENERATED:configuration -->

HTTP MCP requests require an API key. REST requests accept an active member session or API key. See [Permissions](/docs/permissions) and [Authentication and instances](/docs/authentication-and-instances).

## Telemetry

Fluxmail sends anonymous operation events and grouped error reports by default. They exclude email content, credentials, command arguments, and original error text. See [Telemetry](/docs/telemetry) for the event fields and exclusions.

To turn it off for this installation:

```bash
fluxmail telemetry disable
```

You can also set `FLUXMAIL_TELEMETRY=0` or `DO_NOT_TRACK=1`. Any disabling source takes priority. Run `fluxmail telemetry status` to check the effective state.
