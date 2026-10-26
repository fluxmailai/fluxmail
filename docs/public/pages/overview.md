---
title: "Overview"
description: "Connect your existing mailboxes to agents and apps with a Fluxmail server you control."
updated: '2026-10-09'
---

> **Prefer a hosted setup?** Fluxmail Cloud gives your agents and apps access to email without running your own server. [Get started with Cloud](https://fluxmail.ai/docs/cloud/quickstart).

Fluxmail connects Gmail, Microsoft 365, Outlook.com, and IMAP/SMTP mailboxes to your agents and apps. Run it on your computer or server, then use MCP, REST, or the CLI to work with email.

## Start here

| What you want to do | Where to start |
| --- | --- |
| Have a coding agent set up Fluxmail | [Agent-first setup](/docs/quickstart#agent-first-setup) |
| Connect a mailbox and use it locally | [Local quickstart](/docs/quickstart#manual-setup) |
| Run a server for remote or shared access | [Deploy with Docker](/docs/deploy-with-docker) |
| Connect a client to an existing installation | [MCP clients](/docs/connect-an-mcp-client), [REST](/docs/build-with-rest), or [CLI](/docs/use-the-cli) |

## What you can do

Search and read messages or complete threads, download attachments, and work across several mailboxes. You can draft, reply, forward, send, and schedule email. Organization actions include marking mail as read, starring, archiving, moving between folders, and using Gmail labels or Outlook categories.

MCP, REST, and CLI use the same mailbox operations and provider integrations. Each client can have its own permissions and mailbox scope. Business and Enterprise plans also support members with their own mailbox access. See [Permissions](/docs/permissions) and [Teams and plans](/docs/teams-and-plans).

## Choose where to run Fluxmail

| Setup | Use it for | Client connection |
| --- | --- | --- |
| Local process | An agent on the same computer | MCP over stdio; the client launches Fluxmail |
| Local HTTP server | Apps, scripts, or MCP clients that connect by URL | REST or MCP over Streamable HTTP |
| Docker server | Remote access or several clients sharing an instance | REST or MCP over Streamable HTTP |

A local MCP client uses your saved member session. HTTP MCP clients use scoped API keys. The CLI can manage local and remote instances. [Authentication and instances](/docs/authentication-and-instances) explains login and instance selection.

## Connect your email provider

| Provider | What you need |
| --- | --- |
| [Gmail / Google Workspace](/docs/connect-gmail-to-mcp) | Local connections can use Fluxmail's bundled Google OAuth app. Hosted callbacks require your own Google Web app. |
| [Microsoft 365 / Outlook.com](/docs/connect-outlook-to-mcp) | Local connections can use Fluxmail's Entra app. Hosted callbacks require your own Entra app with a client secret. |
| [IMAP/SMTP](/docs/connect-an-imap-mailbox) | Your provider's server settings and password or app password. |

A *mailbox* is a connected email address. Commands and API fields call it an *account*, as in `fluxmail accounts list` and `accountId`. A *member* is a person who signs in to Fluxmail. An *instance* is the Fluxmail installation those members and mailboxes belong to.

## Where your data goes

Fluxmail keeps its SQLite database and encrypted provider credentials on the machine where you run it. It does not copy email content to a service operated by Fluxmail. Your MCP client may send retrieved email to its model provider, depending on the client and its settings.

See [Architecture](/docs/architecture) for request flow and storage, [Configuration](/docs/configuration#telemetry) for usage telemetry, and [Back up and restore](/docs/backup-and-restore) before moving or upgrading an installation.
