---
title: "Quickstart"
description: "Install Fluxmail, connect a mailbox, and verify your first agent or CLI connection."
updated: '2026-10-09'
---

Set up Fluxmail on the computer where your agent runs. You'll need Node.js 22.22 or newer and a mailbox you can authorize. For a remote or shared server, start with [Deploy with Docker](/docs/deploy-with-docker).

## Agent-first setup

Paste this prompt into your coding agent from the project where you want to use Fluxmail. The agent will inspect your setup, help you choose access, configure your client, and verify the connection. You'll enter passwords and complete provider consent yourself.

```text
Set up Fluxmail Self-Hosted for this project. Read
https://fluxmail.ai/docs/self-hosted/setup.txt and follow the setup guide.
Ask me where I want to run it, which mailboxes to connect, and what the
agent should be allowed to do. Configure my client and verify the
connection without reading message bodies or changing mail. Guide me
through password entry and provider consent.
```

The [agent setup instructions](https://fluxmail.ai/docs/self-hosted/setup.txt) cover local and Docker installations. Agents can read the [self-hosted documentation as plain text](https://fluxmail.ai/docs/self-hosted/llms.txt).

## Manual setup

### 1. Install Fluxmail

```bash
npm install -g fluxmail
```

To run without a global installation, replace `fluxmail` in local commands with `npx -y fluxmail@latest`.

### 2. Create your administrator

For a new installation, run:

```bash
fluxmail setup --name "Your name" --email you@example.com
```

Enter your password at the private terminal prompt. This creates a local instance profile and saves a member session for up to 90 days. For an existing installation, use [login](/docs/authentication-and-instances#log-in-to-an-existing-local-instance) instead of setup.

### 3. Connect one mailbox

Choose your provider. Complete only its steps.

#### Gmail or Google Workspace

```bash
fluxmail accounts add gmail
```

Open the consent URL, choose your Google account, and approve access. Local connections use Fluxmail's bundled Google OAuth app. See the [Gmail guide](/docs/connect-gmail-to-mcp) if you need your own app or your browser runs on a different computer.

#### Microsoft 365 or Outlook.com

First [register your Microsoft Entra app](/docs/connect-outlook-to-mcp). For a local connection, configure the public client and authorize your mailbox:

```bash
fluxmail oauth configure outlook \
  --client-id <application-client-id> \
  --public-client
fluxmail accounts add outlook
```

#### IMAP and SMTP

Use your provider's server names. Fluxmail prompts for the password without displaying it:

```bash
fluxmail accounts add imap \
  --email you@example.com \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

See the [IMAP guide](/docs/connect-an-imap-mailbox) for app passwords and provider settings.

### 4. Check the mailbox

```bash
fluxmail status
fluxmail accounts list
```

Your mailbox should appear in the account list. Use its account ID to check that Fluxmail can reach the provider:

```bash
fluxmail --mail-account <account-id> folders list
```

A folder listing verifies provider access without reading message bodies or changing mail. If a command fails, use [Troubleshooting](/docs/troubleshooting).

### 5. Connect your agent

We recommend Full access for normal MCP use. It allows reading, sending, scheduling, drafts, organization, and moving mail into or out of Trash. It excludes permanent deletion. Choose `read-write` or `read-only` for [restricted access](/docs/permissions). Bare stdio and API-key creation without permission options remain read-only.

Stdio can create schedules but does not deliver them. To deliver scheduled mail, keep `fluxmail serve` or `fluxmail scheduled run` running with the same data directory. If you reused an existing installation, [review pending schedules](/docs/sending-and-retries#before-restarting-an-existing-instance) before starting either worker; overdue sends may resume even with a read-only client.

For Claude Code:

```bash
claude mcp add fluxmail -- fluxmail stdio --profile full
```

For other clients, follow [Connect an MCP client](/docs/connect-an-mcp-client). Add `--account <account-id>` to the stdio arguments to limit the client to one mailbox. Your client starts Fluxmail itself; you do not need to run `fluxmail serve` for stdio.

Reload your client, then ask:

```text
Use Fluxmail to list my connected mailboxes, then list the folders for
my selected mailbox. Report whether both calls succeeded. Do not read
message bodies, send mail, create drafts, or change messages.
```

A successful folder call from the agent verifies the MCP connection and provider access. A successful CLI check alone does not verify MCP.

### 6. Try your first email task

When you're ready to let the agent retrieve email, ask:

```text
Show the five most recent messages in my inbox, with sender and subject.
Do not change any messages.
```

You can also list inbox messages directly:

```bash
fluxmail --mail-account <account-id> emails list --folder inbox --page-size 5
```

For an app or script, continue with [Build with REST](/docs/build-with-rest). For more terminal workflows, see [Use the CLI](/docs/use-the-cli).

## If your client cannot find Fluxmail

Some desktop apps start with a limited `PATH`. Run `which fluxmail` (`where fluxmail` on Windows) and use the returned absolute path in the client's configuration. The client must run as the same operating-system user and use the same data directory as setup. See [local instance settings](/docs/connect-an-mcp-client#local-instance-settings) for custom paths and multiple instances.
