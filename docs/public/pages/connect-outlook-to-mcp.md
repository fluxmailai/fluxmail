---
title: 'Connect Outlook / Exchange'
description: 'Connect a Microsoft 365 or Outlook.com mailbox, or register your own Microsoft Entra application.'
updated: '2026-10-26'
---

Fluxmail connects to Microsoft 365 and Outlook.com through Microsoft Graph. It includes Fluxmail's Microsoft Entra app, so you can connect a mailbox locally without registering your own. The local flow uses PKCE, and your OAuth tokens stay with the Fluxmail server you run.

This integration supports Exchange Online mailboxes in Microsoft 365 and personal Outlook.com accounts, including Hotmail addresses. For an on-premises Exchange server without Microsoft Graph access, use [IMAP and SMTP](/docs/connect-an-imap-mailbox).

Fluxmail requests these delegated Microsoft Graph permissions, plus the standard OpenID Connect and offline access scopes it needs to identify the mailbox and refresh access tokens:

- `User.Read`
- `Mail.ReadWrite`
- `Mail.Send`
- `MailboxSettings.Read`

An Entra administrator may need to grant consent when organizational policy blocks user consent.

## 1. Choose a setup

| Setup | OAuth app | Next step |
| --- | --- | --- |
| CLI or Docker on the same computer as your browser | Fluxmail's Entra app | Connect locally below. |
| Public server with a hosted callback | Your Entra app with a client secret | [Register the app](#use-your-own-entra-app), then follow [Remote server](#remote-server). |
| CLI over SSH without a hosted callback | Fluxmail's Entra app or your public client | Follow [Browser on a different computer](#browser-on-a-different-computer). |

For a fresh local instance, create the first administrator and log in:

```bash
fluxmail setup --name "Your name" --email you@example.com
```

## 2. Connect the mailbox

### Local stdio

Start the browser consent flow:

```bash
fluxmail accounts add outlook
```

Fluxmail listens on `http://localhost:8976`, prints a Microsoft authorization URL, and waits for the redirect. Choose the mailbox you want to connect and approve access.

### Local Docker

Leave `FLUXMAIL_PUBLIC_URL` unset, start Fluxmail, and run the mailbox command inside the container:

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail setup --name "Your name" --email you@example.com
docker compose exec fluxmail \
  fluxmail accounts add outlook
```

Docker Compose publishes the callback listener to `localhost:8976` on the host, so the browser can return to the waiting command.

### Remote server

Fluxmail uses the hosted flow whenever `FLUXMAIL_PUBLIC_URL` is set to a public address. Fluxmail's Entra app only accepts local callbacks, so the hosted flow needs [your own Entra app](#use-your-own-entra-app) with a Web redirect URI and a client secret.

Set the public server URL in the Docker environment, then configure the OAuth application through the running instance:

```dotenv
FLUXMAIL_PUBLIC_URL=https://mail.example.com
```

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail oauth configure outlook \
  --client-id <application-client-id> \
  --tenant-id common
```

Fluxmail prompts for the client secret and stores the complete application encrypted in SQLite. The change takes effect immediately. Managed deployments can use `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, and `MICROSOFT_CLIENT_SECRET_FILE` instead.

Start the mailbox command:

```bash
docker compose exec fluxmail \
  fluxmail accounts add outlook
```

Open the printed connection link in your browser, continue to Microsoft, and approve access. The link expires after 10 minutes and works once. For troubleshooting, pass `--hosted` or `--local` to choose a flow explicitly.

### Browser on a different computer

If your browser runs on a different computer, such as when you use the CLI over SSH, the redirect to `localhost` fails to load after you approve access. Copy the full URL from the browser's address bar and paste it into the waiting terminal. Pasting needs an interactive terminal. You can also forward the port first with `ssh -L 8976:127.0.0.1:8976 you@server`. The command stops waiting after 10 minutes.

## Use your own Entra app

Register your own app if your organization only allows approved applications, or if you run a remote server with a hosted callback.

### Register the application

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/).
2. Go to **Identity > Applications > App registrations**, then select **New registration**.
3. Enter a name for the app.
4. Choose the supported account types. Select an option that includes personal Microsoft accounts if you need Outlook.com or Hotmail.
5. Register the application, then copy its **Application (client) ID**.

The default `MICROSOFT_TENANT_ID=common` accepts work, school, and personal accounts when the app registration supports them. For a single-tenant app, set `MICROSOFT_TENANT_ID` to its Directory (tenant) ID or verified tenant domain.

Open **API permissions** for the app registration and add the delegated Microsoft Graph permissions listed at the top of this page.

### Add a callback

Add the redirect URI for each way you plan to run Fluxmail. One app registration can contain both local and hosted callbacks.

| Setup | Platform | Redirect URI |
| --- | --- | --- |
| Local stdio or local Docker | Mobile and desktop applications | `http://localhost:8976/oauth/microsoft/callback` |
| Remote server | Web | `<your FLUXMAIL_PUBLIC_URL>/auth/microsoft/callback` |

For the local callback, open **Authentication**, add the Mobile and desktop applications platform with the custom redirect URI, and enable **Allow public client flows**.

For a remote server, add the Web platform and its public HTTPS callback. For example, a server at `https://mail.example.com` uses:

```text
https://mail.example.com/auth/microsoft/callback
```

Create a client secret under **Certificates & secrets** for hosted connections. Copy the secret value when Entra displays it. Fluxmail does not need a client secret for the local callback.

### Configure Fluxmail

For a local connection, configure the app as a public client:

```bash
fluxmail oauth configure outlook \
  --client-id <application-client-id> \
  --public-client
```

If the app is restricted to one tenant, include it when configuring the client:

```bash
fluxmail oauth configure outlook \
  --client-id <application-client-id> \
  --tenant-id <tenant-id-or-domain> \
  --public-client
```

For a remote server, follow [Remote server](#remote-server). To go back to Fluxmail's Entra app, run `fluxmail oauth reset outlook`. Mailboxes keep the app that connected them, so you do not need to reconnect them after you change apps.

## 3. Verify the connection

List the connected mailboxes, then use the Outlook account ID to fetch its folders:

```bash
fluxmail accounts list
fluxmail --mail-account <account-id> folders list
```

For Docker, prefix both commands with `docker compose exec fluxmail`. The folder call checks Microsoft access without reading message bodies or changing mail. Continue with [MCP setup](/docs/connect-an-mcp-client) or [REST](/docs/build-with-rest) to verify access through your client as well.

## Create hosted connection links through the API

A product backend can create a hosted link without running the CLI. The API key needs `admin.accounts`, and its owner must still be an administrator:

```bash
curl -X POST "$FLUXMAIL_PUBLIC_URL/api/v1/admin/connections" \
  -H "Authorization: Bearer $FLUXMAIL_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"outlook","ownerMemberId":"you@example.com"}'
```

The response contains `data.connectionUrl` and `data.expiresAt`. Send the URL to the user, but keep the admin API key on your backend. To reconnect an existing mailbox, send `reauthorizeAccountId` instead of `ownerMemberId`. The endpoint also accepts `provider: "gmail"`.

## Reconnect Outlook later

List accounts to find the account ID:

```bash
fluxmail accounts list
```

Reconnect the mailbox with the same flow used during setup:

```bash
fluxmail accounts add outlook --reauthorize <account-id>
```

For Docker, prefix the command with `docker compose exec fluxmail`. Choose the Microsoft account that matches the mailbox you are reconnecting. Reauthorization updates the stored tokens without changing the mailbox owner or access rules.

Accounts connected before category support can keep reading and sending mail without reconnecting. Listing Outlook categories requires `MailboxSettings.Read`. If Fluxmail reports that this permission is missing, reauthorize the account. With your own Entra app, add the permission to the app registration first.

## How Outlook categories work

Mailbox aliases can be registered in Fluxmail and selected when sending. The alias must already belong to the mailbox in Microsoft 365 or Outlook.com. Fluxmail does not create aliases or grant delegated mailbox access. See [Send from another address](/docs/send-as-addresses).

Fluxmail exposes Outlook mail folders as folders and Outlook master categories as labels. Message label lists contain category names. Adding or removing a label updates the message's categories without replacing its other categories. If a category name is not in the master list, Outlook adds the name to the message without assigning a color. It does not appear in label listings.

Continue with [Connect an MCP client](/docs/connect-an-mcp-client), [Build with REST](/docs/build-with-rest), or [Use the CLI](/docs/use-the-cli).
