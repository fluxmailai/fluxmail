<p align="center">
  <img src="docs/assets/fluxmail-banner.png" alt="Fluxmail" width="100%">
</p>

<p align="center"><a href="https://github.com/fluxmailai/fluxmail/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/fluxmailai/fluxmail/ci.yml?branch=main&amp;style=flat-square&amp;label=CI&amp;logo=github"></a> <a href="https://www.npmjs.com/package/fluxmail"><img alt="npm version" src="https://img.shields.io/npm/v/fluxmail?style=flat-square&amp;logo=npm&amp;color=1f4fcc"></a> <a href="https://github.com/fluxmailai/fluxmail/pkgs/container/fluxmail"><img alt="Container image" src="https://img.shields.io/badge/GHCR-container-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white"></a></p>

Fluxmail is a self-hosted email MCP server with a versioned REST API and CLI, supporting Gmail, Google Workspace, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes. Agents use MCP, apps and backend workflows use the REST API, and operators use the CLI to connect mailboxes, manage access, and run the service. [Fluxmail Cloud](https://fluxmail.ai/docs/cloud/quickstart) provides a hosted option.

## Features

- 📬 Connect Gmail, Google Workspace, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes to one instance.
- 🤖 Give agents MCP tools to list, search, read, draft, reply, forward, send, schedule, and organize email.
- 🔌 Use the same mailbox operations from the versioned REST API and CLI.
- 🧵 Fetch complete messages and threads, work across several mailboxes, and download attachments.
- 🗂️ Mark mail as read, star or archive it, move it between folders, send it to Trash, and manage Gmail labels or Outlook categories.
- 🔐 Limit each client to selected mailboxes and actions with permission profiles or custom policies.
- 👥 Add members and choose which mailboxes each can access on Business and Enterprise plans.
- 🏠 Run Fluxmail locally or in Docker while keeping its database and encrypted provider credentials on your infrastructure.

## Get started

Fluxmail requires Node.js 22.22 or later.

```bash
npm install -g fluxmail
fluxmail setup --name "Your name" --email you@example.com
```

Then follow the [quickstart](https://fluxmail.ai/docs/quickstart) to connect a mailbox and choose how you want to use Fluxmail: MCP, REST API, or CLI.

We recommend Full access for normal MCP use. It allows reading, sending, scheduling, drafts, organization, and moving mail into or out of Trash. It excludes permanent deletion. Choose `read-write` or `read-only` for [restricted access](https://fluxmail.ai/docs/permissions). Bare stdio and API-key creation without permission options remain read-only.

For a local MCP connection, configure your client to launch `fluxmail` with arguments `["stdio", "--profile", "full"]`. The client must run as the same operating-system user and use the same Fluxmail data directory as setup. Stdio uses the local member session; it does not need an API key or a separate HTTP server. Ask the client to call `list_accounts` to check the connection. A fresh instance returns an empty account list. To deliver scheduled mail, keep `fluxmail serve` or `fluxmail scheduled run` running with the same data directory.

See [Connect an MCP client](https://fluxmail.ai/docs/connect-an-mcp-client) for client configuration and HTTP connections. Its Cline section covers MCP settings and Cline CLI setup, also available as `llms-install.md` in this repository.

## Documentation

- [Overview](https://fluxmail.ai/docs/overview)
- [MCP tools](https://fluxmail.ai/docs/tools)
- [Build with REST](https://fluxmail.ai/docs/build-with-rest)
- [REST API](https://fluxmail.ai/docs/rest-api)
- [Permissions](https://fluxmail.ai/docs/permissions)
- [Configuration](https://fluxmail.ai/docs/configuration)
- [CLI reference](https://fluxmail.ai/docs/cli)
- [Gmail setup](https://fluxmail.ai/docs/connect-gmail-to-mcp)
- [Outlook setup](https://fluxmail.ai/docs/connect-outlook-to-mcp)
- [IMAP setup](https://fluxmail.ai/docs/connect-an-imap-mailbox)
- [Architecture](https://fluxmail.ai/docs/architecture)
- [Teams and plans](https://fluxmail.ai/docs/teams-and-plans)
- [Authentication and instances](https://fluxmail.ai/docs/authentication-and-instances)

## Plans and license

The Personal plan supports three mailboxes and one member. Paid plans raise those limits for teams that share an instance. See [Fluxmail pricing](https://fluxmail.ai/pricing) for current details.

Fluxmail is source available under the [Elastic License 2.0](LICENSE.md). You may use, modify, create derivative works, and redistribute Fluxmail subject to that license. Running a fork does not by itself require a paid Fluxmail subscription, and the built-in Personal plan supports three mailboxes and one member without a paid key.

Official Pro, Business, and Enterprise entitlements require a valid Fluxmail license key. ELv2 does not allow you to change or circumvent license key functionality, remove protected functionality, or provide Fluxmail itself as a hosted or managed service that exposes a substantial set of its features. Use of the Fluxmail name and logos is also subject to the [Fluxmail Terms of Service](https://fluxmail.ai/terms).
