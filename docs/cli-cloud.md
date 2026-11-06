# The CLI's Cloud connection

The CLI can use Fluxmail Cloud as an instance. A `cloud` profile sits beside `local` and `remote` in `instances.json`, and `fluxmail login --cloud` creates it. Cloud needs no changes for this: the CLI uses the same OAuth routes and `/mcp` endpoint as any other MCP client.

## Transport

Cloud has two agent APIs. `POST /api/mail/:operation` accepts only agent keys. `POST /mcp` accepts agent keys and OAuth access tokens, whose sole audience is `/mcp`. The CLI always uses `/mcp`, so browser logins and keys share one code path. `CloudClient` (`cliCloudClient.ts`) holds an SDK client per command. It negotiates the protocol in `auto` mode, which costs one `server/discover` on current Cloud. Cloud counts every `/mcp` request against the workspace's hourly limit.

## Mail commands

`cliMail.ts` depends on the `MailBackend` interface in `cliMailBackend.ts`. `RestMailBackend` calls the self-hosted REST API. `CloudMailBackend` calls tools and returns the same envelopes, so scripts see the same output on either kind of instance:

- REST message bodies become tool arguments (`body.text` to `bodyText`, address objects to strings). `--input` files therefore work on both.
- MCP limits body length and pages threads, while `emails get` and `threads get` promise the whole thing, so the backend follows `get_email_body` and `pageToken` until it has everything.
- Attachments come from `resources/read` with a placeholder filename. `download_attachment` would fetch from the provider twice for the same bytes.
- `emails search` sends its query to `list_emails` once Cloud advertises a `query` argument on that tool, and to `search_emails` until then. Cloud releases before that change ignore unknown arguments, so `list_emails` would return unfiltered mail. The check lists Cloud's tools once per command, which counts as one more request against the hourly limit.
- Mailbox lookup uses `get_connection_status`, which any scope can call and which isn't metered as mail usage. This is the one Cloud-only tool the CLI needs, and `status` prints its result.

Tools hidden by a connection's scopes return JSON-RPC `-32602`, which the CLI reports as `permission_denied`. Commands that administer an instance go through `instanceClient`, which rejects Cloud profiles and points at the dashboard.

## Credentials

Browser login registers a new public client, runs S256 PKCE through the existing loopback callback flow, and stores the session in `cloud-credentials.json`. It registers on every login because Cloud prunes clients without tokens, and a stale client ID would only fail in the browser. The registration asks for every mail scope so `--profile` alone decides what the authorization requests. A repeat login revokes the previous connection, since each approval is a separate grant. Each stored session records the origin that issued it, and the CLI never sends it anywhere else: a session whose origin differs from the profile's counts as logged out. Login, logout, refresh and `instances remove` change sessions only under the refresh lock, and login saves the session and the profile's URL together. A refresh in flight therefore can't write back a connection that a login replaced or a removal deleted, and a profile moved with `--server` never pairs old tokens with the new server or new tokens with the old one. The previous connection is revoked at its own origin. API-key login checks the key before storing it.

Refresh is the sensitive path. Refresh tokens rotate, and Cloud revokes the whole grant when a rotated token comes back. CLI processes running in parallel share one refresh token, so `cloudAccessToken` refreshes under a file lock and reads the session again inside it. Credential writes use a rename so no reader sees a partial file. Member sessions stay in `credentials.json` so a rotation can't race an unrelated login.

`cloudFetch` carries every Cloud request. It rejects other origins, including OAuth endpoints named in server metadata, and refuses redirects, so credentials stay on the profile's origin.

## Telemetry

See `instance_kind` in [Telemetry](telemetry.md).

## Possible follow-up

A Client ID Metadata Document hosted by Fluxmail would give the CLI one stable client ID. That avoids a new row per login against Cloud's 1,000-client ceiling, and the consent page could name the host instead of showing the unverified-app warning. Cloud already accepts these documents, and it matches loopback redirects on any port.
