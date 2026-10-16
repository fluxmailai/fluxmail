---
title: 'Connect an MCP client'
description: 'Choose your MCP client, configure local or HTTP access, and verify the mailbox connection.'
updated: '2026-10-09'
---

Connect your client after installing Fluxmail and connecting a mailbox through the [local quickstart](/docs/quickstart) or [Docker guide](/docs/deploy-with-docker). For an agent to do the configuration, use [agent-first setup](/docs/quickstart#agent-first-setup).

Stdio can create and inspect schedules within the client's permissions, but it does not deliver them. For a stdio installation, keep `fluxmail serve` or `fluxmail scheduled run` running with the same data directory. Remote HTTP installations already deliver schedules through `serve`, including after a client disconnects. Before starting a delivery worker, [review pending schedules](/docs/sending-and-retries#before-restarting-an-existing-instance).

## Choose one transport

| Where Fluxmail runs | Transport | Authentication |
| --- | --- | --- |
| On the same computer as the client | stdio | Your saved local member session |
| In Docker or on another machine | Streamable HTTP | A Fluxmail API key |

Use one transport per connection. We recommend Full access for normal MCP use, and the examples below select it explicitly. Full allows reading, sending, scheduling, drafts, organization, and moving mail into or out of Trash. It excludes permanent deletion. Choose `read-write` or `read-only` for [restricted access](/docs/permissions). Bare stdio and API-key creation without permission options remain read-only.

HTTP clients must support an Authorization header or a compatible local bridge. Check your client's entry before creating a key. Regular ChatGPT developer-mode connections cannot use Fluxmail's bearer API keys; the Codex connection is a separate client setup.

## Option 1: Connect over stdio

Your client launches `fluxmail stdio --profile full` using the member session saved during setup. You do not need to start `fluxmail serve`. The client must run as the same operating-system user and use the same data directory as setup.

Add `--account <account-id>` to the arguments to limit the client to one mailbox. Repeat it for several mailboxes. For multiple local instances or a custom installation path, see [Local instance settings](#local-instance-settings).

## Option 2: Connect over Streamable HTTP

Create a named API key on the instance your client will use. This example grants Full access to one mailbox:

```bash
fluxmail apikey create --name my-agent --profile full --account <account-id>
```

For Docker, prefix that command with `docker compose exec fluxmail`. The key is shown once. Store it in the client's secret store or private configuration; never commit a real key or paste it into a chat.

A local installation also needs a running HTTP server:

```bash
fluxmail serve
```

Docker Compose already starts the server. The local endpoint is `http://localhost:8977/mcp`. For a remote server, use its public HTTPS URL followed by `/mcp`.

## Choose your client

Use the local or HTTP instructions within your client's section. In HTTP examples, replace the URL with your server's endpoint and enter the key privately wherever `fmk_...` appears. Preserve other servers in your configuration.

### Claude Code

#### Local connection

```bash
claude mcp add fluxmail -- fluxmail stdio --profile full
```

#### HTTP connection

```bash
claude mcp add --transport http fluxmail http://localhost:8977/mcp \
  --header "Authorization: Bearer fmk_..."
```

### Claude Desktop

#### Local connection

Add this server to `claude_desktop_config.json` under Settings > Developer > Edit Config:

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "fluxmail",
      "args": ["stdio", "--profile", "full"]
    }
  }
}
```

#### HTTP connection

Claude Desktop's built-in remote connectors accept OAuth or no authentication, so they cannot send a Fluxmail API key. Use the local [`mcp-remote`](https://github.com/geelen/mcp-remote) bridge.

Add this server to `claude_desktop_config.json` under Settings > Developer > Edit Config:

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://localhost:8977/mcp",
        "--allow-http",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${FLUXMAIL_AUTH_HEADER}"
      ],
      "env": {
        "FLUXMAIL_AUTH_HEADER": "Bearer fmk_..."
      }
    }
  }
}
```

Replace `fmk_...` with the API key, then restart Claude Desktop. The bridge requires Node.js and npm on the same computer as Claude Desktop.

### ChatGPT / Codex app

#### Local connection

Open Settings > Plugins > MCPs > Add server, then enter:

- Name: `Fluxmail`
- Type: `STDIO`
- Command to launch: `fluxmail`
- Arguments: `stdio --profile full`

Save the server and restart the app.

#### HTTP connection

Open Settings > Plugins > MCPs > Add server, then enter:

- Name: `Fluxmail`
- Type: `Streamable HTTP`
- URL: `http://localhost:8977/mcp`
- Header name: `Authorization`
- Header value: `Bearer fmk_...`

Save the server and restart the app.

### Codex CLI

#### Local connection

```bash
codex mcp add fluxmail -- fluxmail stdio --profile full
```

You can also add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.fluxmail]
command = "fluxmail"
args = ["stdio", "--profile", "full"]
```

#### HTTP connection

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.fluxmail]
url = "http://localhost:8977/mcp"
http_headers = { Authorization = "Bearer fmk_..." }
```

### Cursor

#### Local connection

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "fluxmail",
      "args": ["stdio", "--profile", "full"]
    }
  }
}
```

#### HTTP connection

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "fluxmail": {
      "url": "http://localhost:8977/mcp",
      "headers": { "Authorization": "Bearer fmk_..." }
    }
  }
}
```

### Cline

#### Local connection

These commands grant Full access: reading, sending, scheduling, drafts, organization, and moving mail into or out of Trash. Full excludes permanent deletion. Use `read-write` or `read-only` for [restricted access](https://fluxmail.ai/docs/permissions).

Open Cline's MCP Servers view, edit its MCP settings, and add this entry under `mcpServers` alongside any existing servers:

```json
{
  "mcpServers": {
    "fluxmail": {
      "command": "/absolute/path/to/fluxmail",
      "args": ["stdio", "--profile", "full"]
    }
  }
}
```

Replace the command with your Fluxmail executable's absolute path.

For Cline CLI, run in an interactive terminal:

```bash
cline mcp install fluxmail -- fluxmail stdio --profile full
```

Review and save the configuration in the add-server wizard.

#### HTTP connection

Create a named key with the [chosen permission profile and mailbox scope](https://fluxmail.ai/docs/connect-an-mcp-client#option-2-connect-over-streamable-http). We recommend `--profile full` for normal MCP use.

Open Cline's MCP settings and add this entry under `mcpServers` alongside any existing servers:

```json
{
  "mcpServers": {
    "fluxmail": {
      "type": "streamableHttp",
      "url": "http://localhost:8977/mcp",
      "headers": { "Authorization": "Bearer fmk_..." }
    }
  }
}
```

Set `type` to `streamableHttp`; omitting it makes Cline use the legacy SSE transport. Replace the URL with your server's endpoint and enter your Fluxmail API key privately in place of `fmk_...`.

For Cline CLI, run `cline mcp` in an interactive terminal, add a server, choose Streamable HTTP, and enter the same URL and Authorization header.

### Hermes

#### Local connection

Add the server to `~/.hermes/config.yaml`, then run `/reload-mcp`. You can also use the dashboard opened by `hermes dashboard`.

```yaml
mcp_servers:
  fluxmail:
    command: 'fluxmail'
    args: ['stdio', '--profile', 'full']
```

#### HTTP connection

Add the server to `~/.hermes/config.yaml`, then run `/reload-mcp`:

```yaml
mcp_servers:
  fluxmail:
    url: 'http://localhost:8977/mcp'
    headers:
      Authorization: 'Bearer fmk_...'
```

### ChatGPT.com

To use Fluxmail from ChatGPT.com without running a server, use [Fluxmail Cloud](https://cloud.fluxmail.ai). Cloud provides a hosted MCP endpoint with OAuth sign-in. Follow the [ChatGPT.com setup guide](https://fluxmail.ai/docs/cloud/mcp#chatgpt-remote-app). Your ChatGPT account needs access to developer mode, and organization policies may require administrator setup.

### Other clients

For stdio, register `fluxmail` as the command and `stdio`, `--profile`, and `full` as its arguments. Add mailbox restrictions with repeated `--account` options.

For HTTP, use your server's `/mcp` URL and send `Authorization: Bearer fmk_...`. Clients that cannot supply an authorization header are not compatible with the HTTP endpoint without a suitable bridge.

## Test the connection

Reload or restart your client, then check that its discovered tools match your chosen permissions. With read access, ask:

```text
Use Fluxmail to list the mailboxes I can access. For my selected mailbox,
call list_folders with its accountId. Report whether both calls succeed.
Do not read message bodies, send mail, create drafts, or modify messages.
```

The account list checks the connection and mailbox visibility. A successful folder call also checks provider access. If the list is empty, confirm that you connected a mailbox to this instance and that the member and client can access it.

For a custom policy without `mail.read`, check tool discovery only. Do not add permissions or send a message just to test the connection. If your client needs a restart, report verification as pending. A [REST check](/docs/build-with-rest#3-verify-provider-access) can verify an existing read-scoped HTTP key, but it does not prove that MCP works.

When you want the agent to retrieve email, ask it to list the five latest inbox messages. See [MCP tools](/docs/tools) for available operations and [Troubleshooting](/docs/troubleshooting) for connection failures.

## MCPB bundle permissions

The MCPB bundle selects `full` automatically when no permission profile is saved. It grants the Full access described above and cannot permanently delete messages. Scheduled delivery still requires `fluxmail serve` or `fluxmail scheduled run` with the same data directory.

A saved profile overrides the bundle default. If you upgrade an installation without a saved profile, it can receive Full access automatically. To retain read-only access, explicitly save `read-only` in the bundle's Permission profile setting before upgrading. Save `read-write` to allow drafts, organization, and Trash without sending or scheduling.

## Limit access

For stdio, put the permission profile and mailbox allowlist in the server arguments. For HTTP, those settings belong to the API key and can be changed without editing client configuration. See [Permissions](/docs/permissions) for custom policies and key updates.

## Local instance settings

Every stdio client launches `fluxmail stdio`. Without `--instance`, Fluxmail selects the active local profile first, then a local profile named `local`, then the sole local profile under any other name. It uses the member session saved for that profile. You do not need to run `fluxmail serve`.

Before connecting, run `fluxmail setup` for a new installation. For an existing installation, list profiles with `fluxmail instances list` and log in to the local profile the client will use with `fluxmail --instance <name> login`. Use `local` for the default profile created by setup or when recreating a missing local profile. The MCP client must run as the same operating-system user and use the same Fluxmail data directory as the setup or login command.

To pin the client to a particular local profile, add `--instance <name>` before `stdio` in the client command. You must choose a profile this way if several local profiles exist and none is active or named `local`. An explicit remote profile is rejected; use Streamable HTTP for remote instances. The stdio selection does not change the active profile for other CLI commands.

If a desktop client cannot find `fluxmail`, use the absolute executable path returned by `which fluxmail` (`where fluxmail` on Windows). For a project-local installation, use `/absolute/path/to/installation/node_modules/.bin/fluxmail` and keep that installation directory available.

For a custom data directory, set `FLUXMAIL_DATA_DIR` in the MCP server's environment to the same absolute path used during setup. In JSON configurations, add `"env": { "FLUXMAIL_DATA_DIR": "/absolute/path/to/data" }` to the server entry.

## Work with messages

See [Sending and retries](/docs/sending-and-retries) before enabling sends or forwards. It explains delivery status, retry keys, and previews.

Mail tools return typed `structuredContent` and readable text. `get_email` and `get_thread` accept `bodyFormat` to select text, HTML, both, or no body. Large bodies include truncation metadata; use `get_email_body` to read the remaining text. Thread messages are paged. `download_attachment` returns the attachment's metadata and a protected resource link. Set `inline` to include the file in the tool response. UTF-8 text files such as plain text, CSV, and JSON come back as text. Inline PNG, JPEG, GIF, and WebP images come back as image content, and an inline PDF also includes the text of its first pages. Each PDF text result covers up to 200 pages or 80,000 characters and names the pages it includes. To read further, set `pages` to a page or range such as `201-400`. Clients that use an MCP protocol version older than 2025-06-18 receive the link as a `uri` field in the JSON text.

Input errors explain which field needs attention. Search syntax errors include `data.diagnostics`. Provider error text is replaced with a safe message. Bulk changes with failed or uncertain messages are marked as MCP tool errors; inspect the per-message results before retrying.
