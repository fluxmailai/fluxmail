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
### Accounts

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts`](/docs/rest-api/list-accounts) | List the email accounts available to the API key. |
| [`GET /api/v1/admin/accounts`](/docs/rest-api/list-admin-accounts) | List mailbox metadata across the instance without granting access to private mail. Requires admin.accounts. |
| [`POST /api/v1/accounts/connections`](/docs/rest-api/connect-own-account) | Connect a Gmail, Outlook or IMAP mailbox, or reauthorize an existing mailbox you own or administer. |
| [`POST /api/v1/admin/connections`](/docs/rest-api/create-administrative-connection) | Create or reauthorize a Gmail, Outlook, or IMAP connection. Requires admin.accounts. |
| [`POST /api/v1/admin/imap/tests`](/docs/rest-api/test-administrative-imap-connection) | Test IMAP and SMTP settings without saving an account. Requires admin.accounts. |
| [`PATCH /api/v1/admin/accounts/{accountId}`](/docs/rest-api/update-account-access) | Change mailbox ownership, instance-wide sharing or member grants. Requires admin.accounts. |
| [`DELETE /api/v1/accounts/{accountId}/connection`](/docs/rest-api/remove-own-account) | Disconnect a mailbox you own or administer and remove its stored credentials. |
| [`DELETE /api/v1/admin/accounts/{accountId}`](/docs/rest-api/delete-admin-account) | Disconnect a mailbox and remove its stored credentials. Requires admin.accounts. |

### API keys

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/admin/api-keys`](/docs/rest-api/list-administrative-api-keys) | List API key metadata without returning plaintext secrets. Requires admin.api_keys. |
| [`GET /api/v1/me/api-keys`](/docs/rest-api/list-own-api-keys) | List your API key metadata without returning plaintext secrets. |
| [`POST /api/v1/admin/api-keys`](/docs/rest-api/create-administrative-api-key) | Create an API key and return its plaintext secret once. Requires admin.api_keys. |
| [`POST /api/v1/me/api-keys`](/docs/rest-api/create-own-api-key) | Create an API key for yourself and return its secret once. |
| [`PATCH /api/v1/admin/api-keys/{keyId}`](/docs/rest-api/update-administrative-api-key) | Update the permissions or mailbox scope of an API key. Requires admin.api_keys. |
| [`DELETE /api/v1/admin/api-keys/{keyId}`](/docs/rest-api/revoke-administrative-api-key) | Revoke an API key. Requires admin.api_keys. |
| [`DELETE /api/v1/me/api-keys/{keyId}`](/docs/rest-api/revoke-own-api-key) | Revoke an API key you own. |

### Attachments

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/messages/{messageId}/attachments/{attachmentId}`](/docs/rest-api/download-attachment) | Download one attachment as raw bytes. |

### Audit events

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/admin/audit-events`](/docs/rest-api/list-audit-events) | List recent security audit events. Requires admin.audit. |

### Authentication

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/me/sessions`](/docs/rest-api/list-sessions) | List your member sessions and identify the current session. |
| [`POST /api/v1/auth/enroll`](/docs/rest-api/enroll-member) | Set your first password with an enrollment code and receive a member session. |
| [`POST /api/v1/auth/login`](/docs/rest-api/login) | Sign in with a member email and password and receive a member session. |
| [`POST /api/v1/auth/logout`](/docs/rest-api/logout) | Revoke the session used for this request. |
| [`POST /api/v1/auth/password-reset`](/docs/rest-api/reset-password) | Set a new password with a reset code and receive a member session. |
| [`PUT /api/v1/me/password`](/docs/rest-api/change-password) | Change your password and revoke your other sessions and OAuth connections. |
| [`DELETE /api/v1/me/sessions/{sessionId}`](/docs/rest-api/revoke-session) | Revoke one of your member sessions. |

### Delivery operations

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/delivery-operations/{operationId}`](/docs/rest-api/get-delivery-operation) | Check whether a send or forward succeeded, failed or has an uncertain outcome. Requires mail.send. |

### Drafts

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/drafts/{draftId}`](/docs/rest-api/get-draft) | Read an existing draft by its provider ID. Requires mail.drafts. |
| [`POST /api/v1/accounts/{accountId}/drafts`](/docs/rest-api/create-draft) | Create a new draft or a reply draft in an email account. |
| [`PUT /api/v1/accounts/{accountId}/drafts/{draftId}`](/docs/rest-api/update-draft) | Replace the full content of an existing draft. |
| [`DELETE /api/v1/accounts/{accountId}/drafts/{draftId}`](/docs/rest-api/delete-draft) | Delete an existing draft from an email account. |

### Folders

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/folders`](/docs/rest-api/list-folders) | List folders in an email account. |
| [`PATCH /api/v1/accounts/{accountId}/imap/folders`](/docs/rest-api/update-owned-imap-folders) | Update special-folder overrides for an IMAP mailbox you own or administer. |
| [`PATCH /api/v1/admin/accounts/{accountId}/imap/folders`](/docs/rest-api/update-administrative-imap-folders) | Update the folder overrides for an IMAP account. Requires admin.accounts. |

### Labels

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/labels`](/docs/rest-api/list-labels) | List Gmail user labels or Outlook categories in an email account. |

### License

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/admin/license`](/docs/rest-api/get-administrative-license) | Get license status and usage without returning the configured license key. Requires admin.license. |
| [`POST /api/v1/admin/license/activate`](/docs/rest-api/activate-administrative-license) | Validate and activate a Fluxmail license key. Requires admin.license. |
| [`DELETE /api/v1/admin/license`](/docs/rest-api/deactivate-administrative-license) | Release the stored license and return this instance to Personal limits. Requires admin.license. |

### Members

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/admin/members`](/docs/rest-api/list-members) | List members with their roles, status and mailbox and API key counts. Requires admin.members. |
| [`GET /api/v1/admin/members/{memberId}/sessions`](/docs/rest-api/list-member-sessions) | List a member's sessions. Requires admin.members. |
| [`GET /api/v1/me`](/docs/rest-api/get-current-member) | Get the name, role and status of the authenticated member. |
| [`POST /api/v1/admin/members`](/docs/rest-api/create-member) | Create a pending member and return a one-time enrollment code. Requires admin.members. |
| [`POST /api/v1/admin/members/{memberId}/invitation`](/docs/rest-api/invite-member) | Issue a new one-time enrollment code for a pending member. Requires admin.members. |
| [`POST /api/v1/admin/members/{memberId}/password-reset`](/docs/rest-api/create-member-password-reset) | Issue a one-time password reset code for a member. Requires admin.members. |
| [`PATCH /api/v1/admin/members/{memberId}`](/docs/rest-api/update-member) | Change a member's name, email, role or status. Requires admin.members. |
| [`PATCH /api/v1/me`](/docs/rest-api/update-current-member) | Change the name of the signed-in member. |
| [`DELETE /api/v1/admin/members/{memberId}`](/docs/rest-api/delete-member) | Remove a member after reassigning or removing their mailboxes. Requires admin.members. |
| [`DELETE /api/v1/admin/members/{memberId}/sessions/{sessionId}`](/docs/rest-api/revoke-member-session) | Revoke one of a member's sessions. Requires admin.members. |

### Messages

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/messages`](/docs/rest-api/list-messages) | List and filter messages in an email account. |
| [`GET /api/v1/accounts/{accountId}/messages/{messageId}`](/docs/rest-api/get-message) | Get one message by its provider ID. |
| [`POST /api/v1/accounts/{accountId}/messages/actions`](/docs/rest-api/modify-messages) | Apply one mailbox action to a batch of messages. |
| [`POST /api/v1/messages/search`](/docs/rest-api/search-messages) | Search up to 20 email accounts with one portable query. |

### OAuth applications

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/admin/oauth-apps`](/docs/rest-api/get-administrative-oauth-apps) | Get safe OAuth application metadata without returning client secrets. Requires admin.accounts. |
| [`PUT /api/v1/admin/oauth-apps/{provider}`](/docs/rest-api/put-administrative-oauth-app) | Save an OAuth application in encrypted instance settings. Requires admin.accounts. |
| [`DELETE /api/v1/admin/oauth-apps/{provider}`](/docs/rest-api/delete-administrative-oauth-app) | Remove a stored OAuth application. Requires admin.accounts. |

### OAuth connections

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/admin/oauth-connections`](/docs/rest-api/list-oauth-connections) | List OAuth connections for all members or one member. Requires admin.api_keys. |
| [`GET /api/v1/me/oauth-connections`](/docs/rest-api/list-own-oauth-connections) | List the MCP clients you have connected with OAuth. |
| [`PATCH /api/v1/me/oauth-connections/{grantId}`](/docs/rest-api/update-own-oauth-connection) | Replace or clear the mailbox allowlist for an OAuth connection you own. |
| [`DELETE /api/v1/admin/oauth-connections/{grantId}`](/docs/rest-api/revoke-oauth-connection) | Disconnect a member's MCP client and revoke its OAuth tokens. Requires admin.api_keys. |
| [`DELETE /api/v1/me/oauth-connections/{grantId}`](/docs/rest-api/revoke-own-oauth-connection) | Disconnect one of your MCP clients and revoke its OAuth tokens. |

### Scheduled sends

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/scheduled-sends`](/docs/rest-api/list-scheduled-sends) | List scheduled messages in an email account. |
| [`DELETE /api/v1/accounts/{accountId}/scheduled-sends/{scheduleId}`](/docs/rest-api/cancel-scheduled-send) | Cancel a pending scheduled send and keep its provider draft. |

### Sender addresses

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/send-as`](/docs/rest-api/list-send-as) | List sender addresses available for an email account. |
| [`PUT /api/v1/accounts/{accountId}/send-as`](/docs/rest-api/replace-send-as) | Replace the configured Outlook or IMAP aliases for an email account. |

### Sending

| Endpoint | Description |
| --- | --- |
| [`POST /api/v1/accounts/{accountId}/messages/{messageId}/forward`](/docs/rest-api/forward-message) | Forward a message to one or more recipients. |
| [`POST /api/v1/accounts/{accountId}/send`](/docs/rest-api/send-message) | Send a message now or schedule it for a specified time. |
| [`POST /api/v1/accounts/{accountId}/send/preview`](/docs/rest-api/preview-send) | Resolve the sender, recipients and attachments without sending mail. Requires mail.send, plus mail.drafts for an existing draft or mail.read for a reply. |

### Server

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1`](/docs/rest-api/get-api-info) | Return the Fluxmail version and the URL of the OpenAPI document. |
| [`GET /api/v1/status`](/docs/rest-api/get-status) | Return provider and mailbox status for the accounts available to the API key. |

### Threads

| Endpoint | Description |
| --- | --- |
| [`GET /api/v1/accounts/{accountId}/threads/{threadId}`](/docs/rest-api/get-thread) | Get a complete email thread by its provider ID. |
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
