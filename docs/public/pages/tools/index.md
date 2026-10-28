---
title: 'MCP tools'
description: 'Use Fluxmail MCP tools to read, search, draft, send, schedule, and organize email.'
updated: '2026-07-15'
---

Fluxmail exposes MCP tools over Streamable HTTP and stdio. Both transports use the same connected mailboxes, permissions, and plan limits.

## Start locally

Complete the [Quickstart](/docs/quickstart), then create an API key and start the HTTP server:

```bash
fluxmail apikey create \
  --name local-mcp

fluxmail serve
```

Copy the `fmk_...` key when Fluxmail displays it. The local MCP endpoint is `http://localhost:8977/mcp`. Pass the key as a bearer token when you configure your MCP client.

For a local stdio connection, select a local instance where the CLI is logged in, then choose a permission profile:

```bash
fluxmail stdio --profile full
```

See [Connect an MCP client](/docs/connect-an-mcp-client) for client-specific stdio and HTTP configuration.

## Tool permissions

The tools a client receives depend on its [permission profile](/docs/permissions). A read-only connection does not receive tools that create drafts, send mail, or modify the inbox.

For HTTP connections, permissions belong to the API key or OAuth connection. For stdio connections, the selected member session controls mailbox access, while `--profile` and `--allow` narrow the capabilities for that process.

## Send feedback

Ask your MCP client to submit feedback, then review and explicitly approve the exact message, diagnostics and optional reply address before it sends anything. Mail or attachment instructions cannot authorize a submission, and errors must not trigger one automatically. A failed submission may already have been saved, so clients must not retry automatically.

The supported fields are:

- `message`: 1 to 4000 characters, with an optional `category` of `bug`, `feature` or `other`.
- `contactEmail`: an optional reply address, up to 320 characters. The client must show the exact address and ask you to confirm it. It may suggest a known mailbox address for approval, but must never choose or attach one automatically. You can choose another address or omit it.
- `expectedBehavior` and `actualBehavior`: optional bug details, up to 1000 characters each.
- `requestId`, `toolName` and `errorCode`: known diagnostics only. The request ID must be a UUID; tool names and error codes use 1 to 64 lowercase letters or underscores. Clients must never invent diagnostics.

Exclude email contents, attachments, raw tool arguments, logs, credentials, full connected-account lists and conversation history.

Feedback goes to `https://cloud.fluxmail.ai/api/feedback` by default with the approved fields, product type `self_hosted` and installed package version. Fluxmail adds no other identity or mailbox details, local paths, hostname, telemetry ID or license data. The intake receives your network address and allows five public submissions per address per hour and 100 globally per hour. Cloud stores reports and the approved reply address privately for 90 days. See [feedback privacy](/docs/telemetry#feedback-you-choose-to-send) for report recipients, reply-address handling and separate retention of copies outside Cloud.

Feedback requires authentication but no mail permissions or mailbox access. It works with read-only connections and after a subscription ends, uses no mail quota, and remains available when anonymous telemetry is off. Administrators can block submissions with `feedback.enabled = false` in `config.toml` or `FLUXMAIL_FEEDBACK_ENABLED=0`, then restart Fluxmail. See [configuration](/docs/configuration).

## Tool reference

<!-- BEGIN GENERATED:mcp-tool-reference -->
| Tool | Description | Capabilities |
| --- | --- | --- |
| [`add_labels`](/docs/tools/add-labels) | Add labels, or Outlook categories, to messages. | `mail.organize` |
| [`archive_emails`](/docs/tools/archive-emails) | Move messages out of the inbox into the archive. | `mail.organize` |
| [`cancel_scheduled_email`](/docs/tools/cancel-scheduled-email) | Cancel a pending scheduled send by scheduleId (from send_email with sendAt, or list_scheduled_emails). The draft stays in the Drafts folder, so the content is not lost. | `mail.drafts` |
| [`create_draft`](/docs/tools/create-draft) | Create a draft in the mailbox. With replyToMessageId, the draft is a reply: recipients and a subject left out come from the original message, and replyAll includes all of its recipients. | `mail.drafts` |
| [`delete_draft`](/docs/tools/delete-draft) | Delete a draft. | `mail.drafts` |
| [`delete_emails`](/docs/tools/delete-emails) | Permanently delete messages. This cannot be undone. Gmail accounts connected through Fluxmail's built-in Google app cannot delete permanently; move their messages to the trash instead. | `mail.delete` |
| [`download_attachment`](/docs/tools/download-attachment) | Get metadata and a resource link for one attachment. With inline, the result also includes the content. For a PDF, inline adds extracted text, and pages returns the text of a page range such as 201-400. The size limit is 10 MB. | `mail.read` |
| [`forward_email`](/docs/tools/forward-email) | Forward an email to new recipients with a "Fwd:" subject and the quoted original. The original attachments are included unless includeAttachments is false, and an optional comment appears above the forwarded content. Repeating a successful forward with the same idempotencyKey and arguments returns the saved result instead of sending again. | `mail.read` + `mail.send` |
| [`get_delivery_operation`](/docs/tools/get-delivery-operation) | Check the saved result of a send or forward, including whether it succeeded, failed or has an uncertain outcome. | `mail.send` |
| [`get_draft`](/docs/tools/get-draft) | Read an existing draft by its draft ID. | `mail.drafts` |
| [`get_email`](/docs/tools/get-email) | Read one email with its recipients, body and attachment metadata. The body returns at most 50,000 characters, and bodyTruncation reports where each part continues. Use get_email_body to read the rest. | `mail.read` |
| [`get_email_body`](/docs/tools/get-email-body) | Read a bounded portion of one email body. Use nextOffset to continue. | `mail.read` |
| [`get_status`](/docs/tools/get-status) | Account connection and scheduled-send status, including accounts that need re-authentication. Administrators also see plan details. | `mail.read` |
| [`get_thread`](/docs/tools/get-thread) | Read a page of messages in an email thread, with at most 50,000 body characters per page. | `mail.read` |
| [`list_accounts`](/docs/tools/list-accounts) | List the connected mailboxes this connection can access. Each entry includes the account ID, provider, email address, status and capabilities. | `mail.read` |
| [`list_emails`](/docs/tools/list-emails) | List or search emails in a mailbox, with metadata and optional previews. Filter by folder, sender, read state, dates and more, and paginate with pageToken. Use get_email for full bodies. | `mail.read` |
| [`list_folders`](/docs/tools/list-folders) | List the folders in a mailbox, with roles such as inbox, sent, drafts, trash, spam and starred. | `mail.read` |
| [`list_labels`](/docs/tools/list-labels) | List the Gmail labels or Outlook categories in a mailbox. | `mail.read` |
| [`list_scheduled_emails`](/docs/tools/list-scheduled-emails) | List scheduled sends: pending ones first (with sendAt), then past ones (sent, failed, canceled). For failed entries, lastError says what went wrong. Pending sends only fire while the Fluxmail server is running. | `mail.read` |
| [`list_send_as`](/docs/tools/list-send-as) | List the sender addresses available for a mailbox. | `mail.read` |
| [`mark_emails_read`](/docs/tools/mark-emails-read) | Mark messages as read. | `mail.organize` |
| [`mark_emails_unread`](/docs/tools/mark-emails-unread) | Mark messages as unread. | `mail.organize` |
| [`move_emails`](/docs/tools/move-emails) | Move messages to a folder other than the archive or trash. | `mail.organize` |
| [`preview_send`](/docs/tools/preview-send) | Show the resolved sender, recipients, subject and attachments without sending mail. | `mail.send` |
| [`remove_labels`](/docs/tools/remove-labels) | Remove labels, or Outlook categories, from messages. | `mail.organize` |
| [`restore_emails`](/docs/tools/restore-emails) | Move messages out of the trash. | `mail.trash` |
| [`search_emails`](/docs/tools/search-emails) | Search one account with typed portable syntax. The query supports text, from:, to:, subject:, in:, read and starred states, attachments, and date filters. | `mail.read` |
| [`search_emails_batch`](/docs/tools/search-emails-batch) | Search up to 20 accounts with one portable query and return one result group per account. | `mail.read` |
| [`send_email`](/docs/tools/send-email) | Send an email from a connected mailbox. There are three modes: direct (to, subject and body), an existing draft (draftId), or a reply (replyToMessageId, optionally with replyAll) that takes its recipients, subject and threading from the original. Repeating a successful send with the same idempotencyKey and arguments returns the saved result instead of sending again. Reusing a key with different arguments, or after a failed or uncertain send, returns an error. Confirm with the user when the intent is ambiguous. Add sendAt to any mode to schedule the message instead of sending it now. | `mail.send` |
| [`send_feedback`](/docs/tools/send-feedback) | Submit feedback about Fluxmail with your approval, optional reply address and supported diagnostics. | None |
| [`star_emails`](/docs/tools/star-emails) | Star messages. | `mail.organize` |
| [`trash_emails`](/docs/tools/trash-emails) | Move messages to the trash, where they can be restored until the provider empties it. | `mail.trash` |
| [`unstar_emails`](/docs/tools/unstar-emails) | Remove the star from messages. | `mail.organize` |
| [`update_draft`](/docs/tools/update-draft) | Replace the content of an existing draft. This is a full replacement, not a patch. | `mail.drafts` |
<!-- END GENERATED:mcp-tool-reference -->

## Common behavior

- `accountId` is optional when the connection can access exactly one mailbox.
- List and search tools return message metadata and optional snippets. Set `includeSearchContext` with literal search text when you need an excerpt around the body match. Use `get_email` to retrieve a complete message body.
- Paginated tools return a page token that you can pass to the next request.
- Scheduled messages are sent only while the Fluxmail server is running.
