---
title: 'Architecture'
description: 'Understand local storage, mailbox access, provider differences, and the data your MCP client receives.'
updated: '2026-09-16'
---

## Where your data lives

Fluxmail keeps its SQLite database on the machine where it runs. Google and Microsoft OAuth tokens, OAuth application secrets, license state, and IMAP/SMTP passwords are encrypted at rest with AES-256-GCM. Deployment settings live in `<data dir>/config.toml`; the encryption key remains outside that file. Back up the database with its matching key and deployment settings. See [Back up and restore](/docs/backup-and-restore).

Your client talks to your email provider through the self-hosted Fluxmail process. Fluxmail does not copy email content to a service operated by Fluxmail. Content returned through MCP may be sent to the client's model provider, depending on how that client runs. The [code is source available](https://github.com/fluxmailai/fluxmail) under the [Elastic License 2.0](https://github.com/fluxmailai/fluxmail/blob/main/LICENSE.md).

## How requests flow

Agents connect through MCP, apps and backend workflows use REST, and people or scripts can use the CLI. All three interfaces send email requests through the same service. Fluxmail selects the mailbox, checks access and plan limits, then passes the operation to Gmail, Microsoft Graph, or an IMAP/SMTP server. Mailbox routing, replies, forwards, and provider capabilities stay consistent across CLI, MCP, and REST.

The CLI also connects mailboxes, manages members and API keys, changes configuration, and starts the MCP and REST services. Remote CLI profiles connect to your server over HTTPS.

Provider differences still affect the available behavior. Folders are places you can navigate, such as Inbox or Archive. Labels are tags that a message can have alongside its folder. Gmail user labels work as both navigable views and tags, so they appear in folder and label listings. Outlook folders appear as folders, while Outlook categories appear as labels. IMAP has folders but does not support label actions. It also uses the mail server's basic search and has no server-side thread model. Fluxmail reconstructs IMAP threads from standard email headers.

## How permissions are enforced

Every authenticated request acts for one active member. Fluxmail first checks whether the member owns the mailbox, has an explicit grant, or can use it through `sharedWithAll`. It then applies an API key's optional account allowlist. An administrator can manage members and mailbox access, but the role does not grant access to private mailboxes.

Stdio reads the selected local member session. HTTP MCP accepts OAuth access tokens and scoped API keys. REST accepts sessions and API keys. Session authority follows the member's current role. OAuth connections and API keys are limited by their permissions, optional mailbox allowlist, and the member's current mailbox access. OAuth connections cannot perform administrative operations.

Administrative REST routes add a second check. A session owner must currently be an administrator. An API key also needs the capability for that route. Fluxmail has no memberless keys or unauthenticated mail mode.

Fluxmail keeps a local security audit history of authentication and management operations. It records identifiers and outcomes, excluding passwords, tokens, request bodies and provider credentials. Actor and resource identifiers are not sent through anonymous telemetry.

Attachments are returned as embedded MCP resources or raw REST responses. Attachment IDs are opaque strings and can contain punctuation such as `part:1.2`. Every provider enforces the configured decoded-size limit before returning the file. The default limit is 10 MB, and the hard maximum is 25 MB.

Sends and forwards through REST, MCP, and CLI use delivery operations in SQLite. Each idempotency key is scoped to the authenticated credential and has no automatic expiry. Reusing a key with the same request returns the saved operation without sending again. If an operation is uncertain, check the Sent folder or recipient before creating another request. REST keys created before the delivery-operation upgrade keep their original 24 hour lifetime.
