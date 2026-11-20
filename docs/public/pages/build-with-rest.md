---
title: "Build with REST"
description: "Create a scoped key, verify provider access, and read your first inbox messages."
updated: '2026-10-06'
---

Use the REST API to work with Gmail, Outlook, and IMAP mailboxes from an app or script. Start with a connected mailbox from the [local quickstart](/docs/quickstart) or [Docker guide](/docs/deploy-with-docker).

This walkthrough uses read-only access. It verifies the connection, lists inbox messages, and fetches a message you choose.

## 1. Start the API and create a key

Before starting an existing stopped instance, [review pending schedules](/docs/sending-and-retries#before-restarting-an-existing-instance). Starting the server can resume overdue sends independently of this tutorial's read-only API key.

Find the mailbox ID with `fluxmail accounts list`, then create a key for your app:

```bash
fluxmail apikey create --name my-app --profile read-only --account <account-id>
```

For Docker, run that command with `docker compose exec fluxmail`. Docker already runs the HTTP server. For a local installation, start it in a separate terminal:

```bash
fluxmail serve
```

Fluxmail displays the key once. Store it in your app's secret store. For the requests below, load it into `FLUXMAIL_API_KEY` in a private terminal without putting the value in shell history. Set the base URL and account ID:

```bash
export FLUXMAIL_API_URL='http://localhost:8977/api/v1'
export FLUXMAIL_ACCOUNT_ID='<account-id>'
```

For a remote server, use its public HTTPS URL followed by `/api/v1`.

## 2. Find your mailbox

```bash
curl --fail-with-body "$FLUXMAIL_API_URL/accounts" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

The response has a `data` array. A shortened example:

```json
{
  "data": [
    {
      "id": "acct_123",
      "provider": "gmail",
      "email": "you@example.com",
      "status": "active"
    }
  ]
}
```

Set `FLUXMAIL_ACCOUNT_ID` to the returned `id`. An empty array means this key has no visible mailboxes; check the member's mailbox access and the key's allowlist. See [Permissions](/docs/permissions).

## 3. Verify provider access

```bash
curl --fail-with-body \
  "$FLUXMAIL_API_URL/accounts/$FLUXMAIL_ACCOUNT_ID/folders" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

A successful folder listing confirms that the key works and Fluxmail can reach your provider. It does not read message bodies or change mail. You can stop here when you only want to verify setup.

Folders describe navigable mailbox locations. The separate `/accounts/<account-id>/labels` endpoint returns Gmail user labels or Outlook categories. Gmail user labels appear in both listings; IMAP does not support the labels endpoint.

## 4. List inbox messages

When you're ready to retrieve email, request five inbox messages:

```bash
curl --fail-with-body \
  "$FLUXMAIL_API_URL/accounts/$FLUXMAIL_ACCOUNT_ID/messages?folder=inbox&pageSize=5" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

The response contains metadata for each message. This shortened example shows the fields to use in the next request:

```json
{
  "data": [
    {
      "id": "msg_123",
      "accountId": "acct_123",
      "subject": "Project update",
      "from": { "email": "ann@example.com" }
    }
  ],
  "meta": {
    "nextPageToken": "opaque-continuation-token",
    "exhausted": false
  }
}
```

If `meta.nextPageToken` is present, send it as `pageToken` with the same account and request settings. Treat an empty page as a confirmed end only when `meta.exhausted` is `true`. Tokens are opaque; URL-encode them when constructing requests.

Gmail and Outlook include native snippets by default. Use `includeSnippet=true` for IMAP previews, or `false` to suppress previews for any provider. Filters such as `read=false`, `from=person@example.com`, and `text=invoice` narrow the results. The `query` parameter supports [portable search syntax](/docs/email-search); `includeSearchContext=true` requests an excerpt around a literal body match.

See [List messages](/docs/rest-api/list-messages) for all parameters and the complete response schema.

## 5. Read a message

Use an ID returned by the list request:

```bash
curl --fail-with-body \
  "$FLUXMAIL_API_URL/accounts/$FLUXMAIL_ACCOUNT_ID/messages/<message-id>" \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

This retrieves the message body and attachment metadata. Use [Get a thread](/docs/rest-api/get-thread) for a conversation. Keep attachment IDs exactly as returned, including IMAP IDs such as `part:1.2`, and pass them to the [download operation](/docs/rest-api/download-attachment).

## Handle errors

Check the HTTP status before reading `data`. Errors include a safe code and request ID. An [attachment download](/docs/rest-api/download-attachment) can fail after its `200` status, so also check that the body is as long as its `Content-Length`; curl and `fetch` report a short body as an error. Input errors describe the invalid field, and search errors include `error.data.diagnostics`. Provider error text is not returned.

A `401` usually requires checking the bearer token. A `403` requires checking the requested operation and mailbox against the key's permissions. Use [Troubleshooting](/docs/troubleshooting) for the next checks.

## Continue building

Use [batch search](/docs/rest-api/search-messages) to search several mailboxes in one request. Results are grouped by account; inspect each group's errors even when another account succeeds.

For writes, create or update a key with the capabilities your workflow needs. `read-write` permits drafts and organization; sending requires `mail.send`. Read [Sending and retries](/docs/sending-and-retries) before implementing delivery, and [Modify messages](/docs/rest-api/modify-messages) before bulk changes. Bulk results report `succeededIds`, `failed`, and `uncertainIds`; inspect uncertain messages before retrying and send at most 100 distinct IDs per request.

The [REST reference](/docs/rest-api) lists all endpoints. Your running instance serves its OpenAPI 3.1 document at `/api/v1/openapi.json`.
