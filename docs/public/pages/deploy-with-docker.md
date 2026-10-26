---
title: "Deploy with Docker"
description: "Run a persistent Fluxmail server, configure HTTPS, and verify a client connection."
updated: '2026-10-09'
---

Use Docker when clients connect over a network or share one Fluxmail instance. The [Fluxmail image](https://github.com/fluxmailai/fluxmail/pkgs/container/fluxmail) supports amd64 and arm64.

For remote access without maintaining a server or configuring HTTPS, use [Fluxmail Cloud](https://fluxmail.ai/docs/cloud/quickstart).

You'll need Docker with Compose. For remote access, also prepare a domain pointing to your server and an HTTPS reverse proxy. If your agent should guide the setup, use the [agent-first prompt](/docs/quickstart#agent-first-setup) and tell it you want Docker.

## 1. Download the server files

```bash
mkdir fluxmail && cd fluxmail
curl -fsSLO https://raw.githubusercontent.com/fluxmailai/fluxmail/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/fluxmailai/fluxmail/main/.env.example -o .env
```

Review both files before starting. The Compose service stores its database, configuration, and generated encryption key in the `fluxmail-data` volume mounted at `/data`. Keep that volume when recreating the container. See [Back up and restore](/docs/backup-and-restore) before replacing storage.

The downloaded file uses the `latest` image. For controlled upgrades, replace that tag with the release tag or image digest you intend to run and record it with your backups.

If your existing Compose file uses `ghcr.io/churichard/fluxmail`, change the image name to `ghcr.io/fluxmailai/fluxmail` and keep your current tag or digest. Published release images are available at the new location. Keep the existing volume and configuration, then run `docker compose pull` and `docker compose up -d` when you are ready to restart. Future releases use the new image name.

## 2. Choose local or remote access

### Docker on your computer

Leave `FLUXMAIL_PUBLIC_URL` unset when the browser and Docker run on the same computer. The local OAuth callback uses port 8976.

For access only from this computer, edit the existing HTTP port mapping in `docker-compose.yml` to bind it to loopback:

```yaml
ports:
  - '127.0.0.1:8977:8977'
  - '127.0.0.1:8976:8976'
```

### Docker on a remote server

Set the public HTTPS URL in `.env`:

```dotenv
FLUXMAIL_PUBLIC_URL=https://mail.example.com
```

Forward HTTPS requests to Fluxmail on port 8977. The following example uses [Caddy installed on the Docker host](https://caddyserver.com/docs/quick-starts/reverse-proxy). Point your domain's DNS records at that host and allow public traffic to Caddy on ports 80 and 443.

Use the loopback port mappings above so clients cannot bypass the proxy. Add this site to the host's Caddyfile and reload Caddy:

```text
mail.example.com {
    reverse_proxy 127.0.0.1:8977
}
```

Caddy obtains and renews the HTTPS certificate for the domain. This example assumes Caddy runs on the host; inside a separate container, `127.0.0.1` would refer to that container.

If the proxy reaches Fluxmail from a non-loopback address, set `FLUXMAIL_TRUST_PROXY=1` in `.env`. Docker networking can make the host proxy appear this way. Enable this only when the proxy overwrites forwarded headers and direct access to Fluxmail is blocked. See [remote authentication](/docs/authentication-and-instances#log-in-to-a-remote-instance).

Hosted OAuth requires your own Google Web app or Microsoft Entra app with a Web callback, depending on the provider. Configure those in step 4.

## 3. Start the server and create an administrator

If you are reusing an existing data volume, [review pending schedules](/docs/sending-and-retries#before-restarting-an-existing-instance) before starting the service. Startup can send overdue mail, including mail outside a new client's read-only scope.

```bash
docker compose up -d
docker compose exec fluxmail \
  fluxmail setup --name "Your name" --email you@example.com
docker compose exec fluxmail fluxmail status
```

Enter the password at the terminal prompt. Run setup only for a new instance. For an existing instance, [log in](/docs/authentication-and-instances) instead.

If startup fails, inspect the container before continuing:

```bash
docker compose ps
docker compose logs --tail=100 fluxmail
```

## 4. Connect a mailbox

Follow the provider guide for your deployment:

| Provider | Setup |
| --- | --- |
| [Gmail / Google Workspace](/docs/connect-gmail-to-mcp#docker-or-a-remote-server) | Local Docker can use the bundled Google app. A public callback requires your own Google Web app. |
| [Microsoft 365 / Outlook.com](/docs/connect-outlook-to-mcp#remote-server) | Local Docker can use Fluxmail's Entra app. A public callback requires your own Entra app with a client secret. |
| [IMAP/SMTP](/docs/connect-an-imap-mailbox) | Use your provider's server settings and enter the password privately. |

Run configuration and mailbox commands inside the container with `docker compose exec fluxmail`. For example, after configuring Google OAuth for your deployment:

```bash
docker compose exec fluxmail fluxmail accounts add gmail
```

Open the URL printed by the command and complete provider consent. Hosted connection links expire after 10 minutes. If your browser and server are on different computers without a hosted callback, follow the provider guide's SSH or callback-paste instructions.

After connecting, find the mailbox ID and verify its folders:

```bash
docker compose exec fluxmail fluxmail accounts list
docker compose exec fluxmail \
  fluxmail --mail-account <account-id> folders list
```

A successful folder listing confirms provider access without changing mail.

## 5. Create a client key

We recommend Full access for normal MCP use. It allows reading, sending, scheduling, drafts, organization, and moving mail into or out of Trash. It excludes permanent deletion. Choose `read-write` or `read-only` for [restricted access](/docs/permissions). Creating a key without permission options still grants read-only access. This example grants Full access to one mailbox:

```bash
docker compose exec fluxmail \
  fluxmail apikey create --name my-agent \
  --profile full --account <account-id>
```

Fluxmail shows the key once. Save it in the client's secret store or private configuration. Use a separate key for each client so it can be revoked independently.

Connect an [MCP client](/docs/connect-an-mcp-client#option-2-connect-over-streamable-http) to `https://mail.example.com/mcp`, or use [REST](/docs/build-with-rest) at `https://mail.example.com/api/v1`. For local Docker, use `http://localhost:8977` as the base URL. Docker already runs the HTTP server; do not start a second `fluxmail serve` process.

Verify through the client as well as inside the container. A container-only check does not test your public URL, proxy, or client key.

## Keep the server running

The Compose service restarts unless you explicitly stop it. Its existing `serve` process delivers scheduled mail after clients disconnect; no additional worker is needed. Queued mail remains in the data volume, overdue mail may send on startup, and retry delays survive restarts.

The shipped Compose file sets `stop_grace_period: 45s`. Keep that allowance when customizing it. Other supervisors should also allow at least 45 seconds: Fluxmail stops accepting requests and new deliveries, then waits up to 30 seconds for active work before closing providers and storage.

Before updating the image, follow [Upgrade Fluxmail](/docs/upgrade-fluxmail). Set up [backups](/docs/backup-and-restore) and use [Local logs](/docs/logging) or [Troubleshooting](/docs/troubleshooting) when a connection fails.
