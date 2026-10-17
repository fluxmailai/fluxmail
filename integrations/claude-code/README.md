# Fluxmail Self-Hosted plugin for Claude Code

Use a local [Fluxmail](https://fluxmail.ai) instance to search and read Gmail, Outlook, Exchange, and IMAP/SMTP mail. This plugin starts Fluxmail as a stdio server with the `read-only` permission profile. The Fluxmail version matches the plugin version, and the plugin includes a lockfile for its dependencies.

## Setup

Fluxmail requires Node.js 22.22 or later, npm, and a current version of Claude Code that provides `CLAUDE_PLUGIN_DATA`. Before enabling the plugin, set up Fluxmail in a terminal:

```sh
npx -y fluxmail@latest setup --name "Your name" --email you@example.com
```

Complete the password prompt and connect a mailbox using the [quickstart](https://fluxmail.ai/docs/quickstart). The plugin uses the authenticated member session from the selected local Fluxmail profile. It cannot connect to a remote instance through stdio.

The free Personal plan supports one member and three mailboxes. No paid key is required for that plan.

On its first start, the plugin installs the versions in its lockfile into Claude Code's plugin data directory. This needs network access and may take a few minutes. Later starts reuse that installation. If setup fails, check the MCP server logs and restart the server to retry.

For the first start or after an update, allow up to five minutes for MCP startup by launching Claude Code from your terminal:

```sh
MCP_TIMEOUT=300000 claude
```

Stable Fluxmail releases update the plugin's package version and dependency lockfile. Update the plugin after the new version becomes available in the directory, then restart its MCP server.

## Permissions

The bundled configuration allows reading and searching. To enable drafting, sending, scheduling, or mailbox changes, explicitly choose a suitable permission profile in the MCP configuration. You can narrow access to particular mailboxes with `--account`. See [permissions](https://fluxmail.ai/docs/permissions) before changing the scope.

The plugin launcher installs its locked dependencies with lifecycle scripts disabled. SQLite and password hashing use the prebuilt binaries included in their npm packages. The plugin includes no hooks or bundled credentials. Mailbox credentials and local session secrets are managed by Fluxmail in its data directory. Do not paste passwords, OAuth tokens, or API keys into chat.

## Network access

- `registry.npmjs.org`: npm downloads the Fluxmail package and dependencies specified in the lockfile.
- Google OAuth and Gmail API hosts (`accounts.google.com`, `oauth2.googleapis.com`, `gmail.googleapis.com`, and `www.googleapis.com`): used when a Gmail mailbox is connected.
- Microsoft OAuth and Graph hosts (`login.microsoftonline.com` and `graph.microsoft.com`), or the configured Exchange host: used for connected Microsoft mailboxes.
- User-configured IMAP and SMTP hosts: used only for connected mailboxes.
- Fluxmail's licensing service at `fluxmail.ai`: used when an operator configures a paid license.
- `t.fluxmail.ai`: anonymous usage telemetry and sanitized error reports, unless you opt out.

## Telemetry

Anonymous telemetry is on by default. Fluxmail sends operation names, outcomes, timings, a random installation ID, runtime information, and aggregate installation details to PostHog through `t.fluxmail.ai`. Error reports contain operation names and safe error codes. Telemetry excludes email content, addresses, search text, credentials, and original error messages. See [configuration](https://fluxmail.ai/docs/configuration#telemetry) for the collected properties and [privacy policy](https://fluxmail.ai/privacy) for data handling.

To turn telemetry off, run this command using the same Fluxmail data directory as the plugin:

```sh
npx -y fluxmail@latest telemetry disable
```

The plugin also honors `FLUXMAIL_TELEMETRY=0` or `DO_NOT_TRACK=1` in its MCP server environment. Restart the plugin's MCP server after changing these environment variables. Existing opt-outs remain in effect.

## Source and license

Richard Chu maintains Fluxmail at [fluxmailai/fluxmail](https://github.com/fluxmailai/fluxmail). The plugin wrapper and Fluxmail are source available under the [Elastic License 2.0](LICENSE.md).
