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

For HTTP connections, permissions belong to the API key. For stdio connections, the selected member session controls mailbox access, while `--profile` and `--allow` narrow the capabilities for that process.

## Tool reference

<!-- BEGIN GENERATED:mcp-tool-reference -->
| Tool | Description | Capabilities |
| --- | --- | --- |
| [`add_labels`](/docs/tools/add-labels) | Add labels, or Outlook categories, to messages. | `mail.organize` |
| [`archive_emails`](/docs/tools/archive-emails) | Move messages out of the inbox into the archive. | `mail.organize` |
| [`cancel_scheduled_email`](/docs/tools/cancel-scheduled-email) | Cancel a pending scheduled send by scheduleId (from send_email with sendAt, or list_scheduled_emails). The draft stays in the Drafts folder, so the content is not lost. | `mail.drafts` |
| [`create_draft`](/docs/tools/create-draft) | Create a draft. For a reply draft, pass replyToMessageId (recipients/subject are derived; replyAll for reply-all). | `mail.drafts` |
| [`delete_draft`](/docs/tools/delete-draft) | Delete a draft. | `mail.drafts` |
| [`delete_emails`](/docs/tools/delete-emails) | Permanently delete messages. This cannot be undone. Gmail accounts connected through Fluxmail's built-in Google app cannot delete permanently; move their messages to the trash instead. | `mail.delete` |
| [`download_attachment`](/docs/tools/download-attachment) | Get metadata and a resource link for one attachment, up to 10 MB. With inline, the result also includes the content. For a PDF, inline adds extracted text, and pages returns the text of a page range such as 201-400. | `mail.read` |
| [`forward_email`](/docs/tools/forward-email) | Forward an email to new recipients: quoted original body, "Fwd:" subject, original attachments included unless includeAttachments=false. Optional comment appears above the forwarded content. | `mail.read` + `mail.send` |
| [`get_delivery_operation`](/docs/tools/get-delivery-operation) | Check whether a send or forward succeeded, failed, or has an uncertain outcome. | `mail.send` |
| [`get_draft`](/docs/tools/get-draft) | Read an existing draft by its draft ID. | `mail.drafts` |
| [`get_email`](/docs/tools/get-email) | Fetch one email in full: body (text and/or HTML), recipients, attachment metadata. | `mail.read` |
| [`get_email_body`](/docs/tools/get-email-body) | Read a bounded portion of one email body. Use nextOffset to continue. | `mail.read` |
| [`get_status`](/docs/tools/get-status) | Account connection and scheduled-send status, including accounts that need re-authentication. Administrators also see plan details. | `mail.read` |
| [`get_thread`](/docs/tools/get-thread) | Fetch a page of conversation messages with bounded body content. | `mail.read` |
| [`list_accounts`](/docs/tools/list-accounts) | List connected email accounts (id, provider, email, status, capabilities). | `mail.read` |
| [`list_emails`](/docs/tools/list-emails) | List emails from the user's connected mailbox with metadata and optional previews. Filter by folder, sender, unread, dates, etc. Paginate with pageToken. Use get_email for full bodies. | `mail.read` |
| [`list_folders`](/docs/tools/list-folders) | List navigable folders for an account, with roles (inbox, sent, drafts, trash, spam, starred). | `mail.read` |
| [`list_labels`](/docs/tools/list-labels) | List Gmail user labels or Outlook categories for an account. | `mail.read` |
| [`list_scheduled_emails`](/docs/tools/list-scheduled-emails) | List scheduled sends: pending ones first (with sendAt), then past ones (sent, failed, canceled). For failed entries, lastError says what went wrong. Pending sends only fire while the Fluxmail server is running. | `mail.read` |
| [`list_send_as`](/docs/tools/list-send-as) | List sender addresses available for an account. | `mail.read` |
| [`mark_emails_read`](/docs/tools/mark-emails-read) | Mark messages as read. | `mail.organize` |
| [`mark_emails_unread`](/docs/tools/mark-emails-unread) | Mark messages as unread. | `mail.organize` |
| [`move_emails`](/docs/tools/move-emails) | Move messages to a folder other than the archive or trash. | `mail.organize` |
| [`preview_send`](/docs/tools/preview-send) | Show the resolved sender, recipients, subject, and attachments without sending. | `mail.send` |
| [`remove_labels`](/docs/tools/remove-labels) | Remove labels, or Outlook categories, from messages. | `mail.organize` |
| [`restore_emails`](/docs/tools/restore-emails) | Move messages out of the trash. | `mail.trash` |
| [`search_emails`](/docs/tools/search-emails) | Search one account with typed portable syntax. The query supports text, from:, to:, subject:, in:, read and starred states, attachments, and date filters. | `mail.read` |
| [`search_emails_batch`](/docs/tools/search-emails-batch) | Search up to 20 accounts with one portable query and return one result group per account. | `mail.read` |
| [`send_email`](/docs/tools/send-email) | Send an email from the user's connected account. Three modes: direct (to + subject + body), sending an existing draft (draftId), or replying (replyToMessageId, optionally replyAll) where recipients, subject, and threading are derived from the original. Confirm with the user when intent is ambiguous. Add sendAt to any mode to schedule instead of sending now. | `mail.send` |
| [`star_emails`](/docs/tools/star-emails) | Star messages. | `mail.organize` |
| [`trash_emails`](/docs/tools/trash-emails) | Move messages to the trash, where they can be restored until the provider empties it. | `mail.trash` |
| [`unstar_emails`](/docs/tools/unstar-emails) | Remove the star from messages. | `mail.organize` |
| [`update_draft`](/docs/tools/update-draft) | Replace the content of an existing draft (full replacement, not a patch). | `mail.drafts` |
<!-- END GENERATED:mcp-tool-reference -->

## Common behavior

- `accountId` is optional when the connection can access exactly one mailbox.
- List and search tools return message metadata and optional snippets. Set `includeSearchContext` with literal search text when you need an excerpt around the body match. Use `get_email` to retrieve a complete message body.
- Paginated tools return a page token that you can pass to the next request.
- Scheduled messages are sent only while the Fluxmail server is running.
