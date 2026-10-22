---
title: 'REST API'
description: 'Use Fluxmail from local scripts and applications through the versioned JSON API.'
updated: '2026-07-15'
---

Fluxmail exposes a REST API at `/api/v1` alongside its MCP endpoint. It uses the same connected mailboxes, permissions, and plan limits as MCP.

## Start locally

Complete the [quickstart](/docs/quickstart), then create an API key and start the HTTP server:

```bash
fluxmail apikey create \
  --name local-script

fluxmail serve
```

Copy the `fmk_...` key when Fluxmail displays it. The local base URL is `http://localhost:8977/api/v1`.

Pass the key as a bearer token. For example, list the accounts available to the key:

```bash
export FLUXMAIL_API_KEY='fmk_...'

curl http://localhost:8977/api/v1/accounts \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

Use the returned account ID in mailbox routes. If you expose the HTTP server outside your computer, protect it with HTTPS and a firewall or reverse proxy.

## Administrative access

Routes under `/api/v1/admin` accept a member session or API key. A session must belong to a current administrator. An API key must belong to a current administrator and include the capability for the requested operation:

| Capability | Access |
| --- | --- |
| `admin.accounts` | Connect or reauthorize mailboxes, update IMAP settings, and configure Outlook or IMAP sender addresses. |
| `admin.api_keys` | List, create, update, and revoke API keys. |
| `admin.members` | Manage members, invitations, roles, statuses, and sessions. |
| `admin.audit` | Read security audit events. |
| `admin.license` | Read license status and activate a license key. |

The first member is the initial administrator. Administrators can use their CLI session directly. Create an administrative API key only when automation needs these routes:

```bash
fluxmail apikey create \
  --name instance-admin \
  --profile full \
  --admin admin.accounts \
  --admin admin.api_keys \
  --admin admin.members \
  --admin admin.audit \
  --admin admin.license
```

Remote administrative requests require HTTPS. Requests from the local computer can use HTTP.

If a reverse proxy terminates TLS and connects to Fluxmail from a non-loopback address, set `FLUXMAIL_TRUST_PROXY=1`. Enable it only when the proxy overwrites forwarded headers and prevents clients from reaching Fluxmail directly.

## Endpoint reference

<!-- BEGIN GENERATED:rest-api-endpoints -->
| Endpoint | Description |
| --- | --- |
| [Log in with a member email and password](/docs/rest-api/login) | Log in with a member email and password |
| [Enroll a member](/docs/rest-api/enroll-member) | Enroll a member |
| [Redeem a password reset](/docs/rest-api/reset-password) | Redeem a password reset |
| [Get the authenticated member](/docs/rest-api/get-current-member) | Get the authenticated member |
| [Update the current member profile](/docs/rest-api/update-current-member) | Update the current member profile |
| [Revoke the current member session](/docs/rest-api/logout) | Revoke the current member session |
| [Change the current member password](/docs/rest-api/change-password) | Change the current member password |
| [List current member sessions](/docs/rest-api/list-sessions) | List current member sessions |
| [Revoke a member session](/docs/rest-api/revoke-session) | Revoke a member session |
| [List API keys owned by the current member](/docs/rest-api/list-own-api-keys) | List API keys owned by the current member |
| [Create an API key for the current member](/docs/rest-api/create-own-api-key) | Create an API key for the current member |
| [Revoke an API key owned by the current member](/docs/rest-api/revoke-own-api-key) | Revoke an API key owned by the current member |
| [List MCP clients the current member connected with OAuth](/docs/rest-api/list-own-oauth-connections) | List MCP clients the current member connected with OAuth |
| [Change the mailboxes an OAuth connection can use](/docs/rest-api/update-own-oauth-connection) | Change the mailboxes an OAuth connection can use |
| [Disconnect an MCP client the current member connected with OAuth](/docs/rest-api/revoke-own-oauth-connection) | Disconnect an MCP client the current member connected with OAuth |
| [List OAuth connections for every member or one member](/docs/rest-api/list-oauth-connections) | List OAuth connections for every member or one member |
| [Disconnect a member's OAuth connection](/docs/rest-api/revoke-oauth-connection) | Disconnect a member's OAuth connection |
| [Connect or reauthorize a mailbox account](/docs/rest-api/connect-own-account) | Connect or reauthorize a mailbox account |
| [Remove a mailbox account owned by the current member](/docs/rest-api/remove-own-account) | Remove a mailbox account owned by the current member |
| [Update folder settings for an owned IMAP mailbox](/docs/rest-api/update-owned-imap-folders) | Update folder settings for an owned IMAP mailbox |
| [List members](/docs/rest-api/list-members) | List members |
| [Create and invite a member](/docs/rest-api/create-member) | Create and invite a member |
| [Update a member](/docs/rest-api/update-member) | Update a member |
| [Remove a member](/docs/rest-api/delete-member) | Remove a member |
| [Issue a member invitation](/docs/rest-api/invite-member) | Issue a member invitation |
| [Issue a member password reset](/docs/rest-api/create-member-password-reset) | Issue a member password reset |
| [List a member's sessions](/docs/rest-api/list-member-sessions) | List a member's sessions |
| [Revoke a member's session](/docs/rest-api/revoke-member-session) | Revoke a member's session |
| [List all mailbox account metadata](/docs/rest-api/list-admin-accounts) | List all mailbox account metadata |
| [Update mailbox ownership and access](/docs/rest-api/update-account-access) | Update mailbox ownership and access |
| [Remove a mailbox account](/docs/rest-api/delete-admin-account) | Remove a mailbox account |
| [List security audit events](/docs/rest-api/list-audit-events) | List security audit events |
| [Create or reauthorize a connection](/docs/rest-api/create-administrative-connection) | Create or reauthorize a Gmail, Outlook, or IMAP connection. Requires admin.accounts. |
| [Test an IMAP connection](/docs/rest-api/test-administrative-imap-connection) | Test IMAP and SMTP settings without saving an account. Requires admin.accounts. |
| [Update IMAP folders](/docs/rest-api/update-administrative-imap-folders) | Update the folder overrides for an IMAP account. Requires admin.accounts. |
| [List API keys](/docs/rest-api/list-administrative-api-keys) | List API key metadata without returning plaintext secrets. Requires admin.api_keys. |
| [Create an API key](/docs/rest-api/create-administrative-api-key) | Create an API key and return its plaintext secret once. Requires admin.api_keys. |
| [Update an API key](/docs/rest-api/update-administrative-api-key) | Update the permissions or mailbox scope of an API key. Requires admin.api_keys. |
| [Revoke an API key](/docs/rest-api/revoke-administrative-api-key) | Revoke an API key. Requires admin.api_keys. |
| [Get OAuth application status](/docs/rest-api/get-administrative-oauth-apps) | Get safe OAuth application metadata without returning client secrets. Requires admin.accounts. |
| [Configure an OAuth application](/docs/rest-api/put-administrative-oauth-app) | Save an OAuth application in encrypted instance settings. Requires admin.accounts. |
| [Reset an OAuth application](/docs/rest-api/delete-administrative-oauth-app) | Remove a stored OAuth application. Requires admin.accounts. |
| [Get license status](/docs/rest-api/get-administrative-license) | Get license status and usage without returning the configured license key. Requires admin.license. |
| [Deactivate a license](/docs/rest-api/deactivate-administrative-license) | Release the stored license and return this instance to Personal limits. Requires admin.license. |
| [Activate a license](/docs/rest-api/activate-administrative-license) | Validate and activate a Fluxmail license key. Requires admin.license. |
| [Get API information](/docs/rest-api/get-api-info) | Return the Fluxmail version and the URL of the OpenAPI document. |
| [Get server status](/docs/rest-api/get-status) | Return provider and mailbox status for the accounts available to the API key. |
| [List accounts](/docs/rest-api/list-accounts) | List the email accounts available to the API key. |
| [List folders](/docs/rest-api/list-folders) | List folders in an email account. |
| [List labels](/docs/rest-api/list-labels) | List Gmail user labels or Outlook categories in an email account. |
| [List sender addresses](/docs/rest-api/list-send-as) | List sender addresses available for an email account. |
| [Replace configured sender addresses](/docs/rest-api/replace-send-as) | Replace the configured Outlook or IMAP aliases for an email account. |
| [List messages](/docs/rest-api/list-messages) | List and filter messages in an email account. |
| [Search multiple accounts](/docs/rest-api/search-messages) | Search up to 20 email accounts with one portable query. |
| [Get a message](/docs/rest-api/get-message) | Get one message by its provider ID. |
| [Get a thread](/docs/rest-api/get-thread) | Get a complete email thread by its provider ID. |
| [Get a draft](/docs/rest-api/get-draft) | Get a draft |
| [Replace a draft](/docs/rest-api/update-draft) | Replace the full content of an existing draft. |
| [Delete a draft](/docs/rest-api/delete-draft) | Delete an existing draft from an email account. |
| [Create a draft](/docs/rest-api/create-draft) | Create a new draft or a reply draft in an email account. |
| [Preview a send](/docs/rest-api/preview-send) | Preview a send |
| [Send or schedule a message](/docs/rest-api/send-message) | Send a message now or schedule it for a specified time. |
| [Get a delivery outcome](/docs/rest-api/get-delivery-operation) | Get a delivery outcome |
| [List scheduled sends](/docs/rest-api/list-scheduled-sends) | List scheduled messages in an email account. |
| [Cancel a scheduled send](/docs/rest-api/cancel-scheduled-send) | Cancel a pending scheduled send and keep its provider draft. |
| [Forward a message](/docs/rest-api/forward-message) | Forward a message to one or more recipients. |
| [Modify messages](/docs/rest-api/modify-messages) | Apply one mailbox action to a batch of messages. |
| [Download an attachment](/docs/rest-api/download-attachment) | Download one attachment as raw bytes. |
<!-- END GENERATED:rest-api-endpoints -->

## Common behavior

- JSON responses put results in `data`. Paginated responses provide `meta.nextPageToken`.
- Send and forward requests require an `Idempotency-Key` header. Their endpoint pages explain safe retries.
- API keys use the profiles and capabilities described in [Permissions](/docs/permissions).
- Errors return an `error` object with a stable `code` and `message`.

## OpenAPI schema

The OpenAPI 3.1 schema is public:

```text
curl http://localhost:8977/api/v1/openapi.json \
  -H "Authorization: Bearer $FLUXMAIL_API_KEY"
```

Use the schema or the endpoint pages for request parameters, JSON bodies, and response details.
