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
| [`cancel_scheduled_email`](/docs/tools/cancel-scheduled-email) | Cancel a pending scheduled send by its scheduleId. The draft stays in the Drafts folder, so the content is not lost. Get the scheduleId from send_email or forward_email with sendAt, or from list_scheduled_emails. | `mail.drafts` |
| [`create_draft`](/docs/tools/create-draft) | Create a draft in the mailbox. With replyToMessageId, the draft is a reply: recipients and a subject left out come from the original message, replyAll includes all of its recipients, and the original message is quoted below the body unless quoteOriginal is false. | `mail.drafts` |
| [`create_folder`](/docs/tools/create-folder) | Create a folder in a mailbox. For a subfolder, give the full path with the separator the mailbox already uses in its folder names, such as Projects/2026. Missing parent folders are created too. If the folder already exists, it is returned unchanged. System folder names, including Inbox, Sent and Trash, are rejected. In Gmail, the folder is a label. Call list_folders first to see how the mailbox writes folder paths. | `mail.organize` |
| [`create_label`](/docs/tools/create-label) | Create a Gmail label or an Outlook category in a mailbox. If the mailbox already has one with that name, it is returned unchanged. In Gmail, a name such as Projects/2026 creates a nested label and any missing parent labels, and the label also works as a folder. Gmail refuses names it uses for system labels and folders, such as Inbox, Archive and Starred. A new Outlook category has no color. IMAP mailboxes don't have labels. | `mail.organize` |
| [`delete_draft`](/docs/tools/delete-draft) | Delete a draft. | `mail.drafts` |
| [`delete_emails`](/docs/tools/delete-emails) | Permanently delete messages. This cannot be undone. Gmail accounts connected through Fluxmail's built-in Google app cannot delete permanently; move their messages to the trash instead. | `mail.delete` |
| [`delete_folder`](/docs/tools/delete-folder) | Delete an empty folder from a mailbox. The folder must have no messages and no subfolders: move or trash its mail and delete its subfolders first. In Gmail, where the folder is a label, remove the label from its messages. System folders such as Inbox, Sent and Trash can't be deleted, and neither can a folder the account settings use as one. Call list_folders first to find the folder ID. | `mail.organize` |
| [`delete_label`](/docs/tools/delete-label) | Delete a Gmail label or an Outlook category from a mailbox. In Gmail, the label is removed from its messages, which stay in the mailbox, and a label with nested labels can't be deleted until they are. Gmail system labels such as Inbox and Starred can't be deleted. In Outlook, the category leaves the mailbox's category list, but messages that have it keep its name. Call list_labels first to find the label ID. | `mail.organize` |
| [`download_attachment`](/docs/tools/download-attachment) | Get metadata and a resource link for one attachment. With inline, the result also includes the content. For a PDF, inline adds extracted text, and pages returns the text of a page range such as 201-400. The size limit is 10 MB. | `mail.read` |
| [`forward_email`](/docs/tools/forward-email) | Forward an email to new recipients with a "Fwd:" subject and the quoted original. The original attachments are included unless includeAttachments is false, and an optional comment appears above the forwarded content. Repeating a successful forward with the same idempotencyKey and arguments returns the saved result instead of sending again. Add sendAt to schedule the forward instead of sending it now. Scheduled mail is delivered by fluxmail serve or fluxmail scheduled run using the same store. Stdio does not deliver schedules. Overdue mail may send when a worker starts. | `mail.read` + `mail.send` |
| [`get_delivery_operation`](/docs/tools/get-delivery-operation) | Check the saved result of a send or forward, including whether it succeeded, failed or has an uncertain outcome. | `mail.send` |
| [`get_draft`](/docs/tools/get-draft) | Read an existing draft by its draft ID. | `mail.drafts` |
| [`get_email`](/docs/tools/get-email) | Read one email with its recipients, body and attachment metadata. The body returns at most 50,000 characters, and bodyTruncation reports where each part continues. Use get_email_body to read the rest. | `mail.read` |
| [`get_email_body`](/docs/tools/get-email-body) | Read a bounded portion of one email body. Use nextOffset to continue. | `mail.read` |
| [`get_status`](/docs/tools/get-status) | Account connection and scheduled-send status, including accounts that need re-authentication, the time zone for the date above the quoted message in replies, and the running Fluxmail version. Administrators also see plan details. | `mail.read` |
| [`get_thread`](/docs/tools/get-thread) | Read a page of messages in an email thread, with at most 50,000 body characters per page. In an IMAP mailbox, finding the replies means searching each folder. When that search runs out of time, the result has the messages found so far and incomplete is true. | `mail.read` |
| [`list_accounts`](/docs/tools/list-accounts) | List the connected mailboxes this connection can access. Each entry includes the account ID, provider, email address, status and capabilities. | `mail.read` |
| [`list_emails`](/docs/tools/list-emails) | List or search emails in a mailbox, with metadata and optional previews. Filter with query, which takes typed search such as from:ann@example.com is:unread after:2026-01-01, and use folder for custom folders and labels. Paginate with pageToken. Use get_email for full bodies. | `mail.read` |
| [`list_emails_batch`](/docs/tools/list-emails-batch) | List or search emails in up to 20 accounts at once, with one result group per account. Filter with query, which takes typed search such as from:ann@example.com is:unread, and use folder for a folder role. Each account pages with its own pageToken. | `mail.read` |
| [`list_folders`](/docs/tools/list-folders) | List the folders in a mailbox, with roles such as inbox, sent, drafts, trash, spam and starred. | `mail.read` |
| [`list_labels`](/docs/tools/list-labels) | List the Gmail labels or Outlook categories in a mailbox. | `mail.read` |
| [`list_scheduled_emails`](/docs/tools/list-scheduled-emails) | List scheduled sends: pending ones first, with sendAt, then past ones that were sent, failed or canceled. For failed entries, lastError says what went wrong. Pending sends only fire while the Fluxmail server is running. | `mail.read` |
| [`list_send_as`](/docs/tools/list-send-as) | List the sender addresses available for a mailbox. | `mail.read` |
| [`mark_emails_read`](/docs/tools/mark-emails-read) | Mark messages as read. | `mail.organize` |
| [`mark_emails_unread`](/docs/tools/mark-emails-unread) | Mark messages as unread. | `mail.organize` |
| [`move_emails`](/docs/tools/move-emails) | Move messages to a folder other than the archive or trash. | `mail.organize` |
| [`move_folder`](/docs/tools/move-folder) | Move a folder under another folder, or to the top level of the mailbox. The folder keeps its own name, its messages and its subfolders. Give either the destination as parent or topLevel: true, not both. The destination can't be the folder itself, one of its subfolders, or the trash, and it can't already hold a folder with the same name. In Gmail, where the folder is a label, the labels nested under it move with it. System folders such as Inbox, Sent and Trash can't be moved, and neither can a folder the account settings use as one. Use the folder ID in the result afterwards: in an IMAP mailbox the folder and its subfolders always get new IDs. Message IDs normally stay the same. If one stops working, list the folder again. Call list_folders first to find the folder IDs. | `mail.organize` |
| [`preview_send`](/docs/tools/preview-send) | Show the resolved sender, recipients, subject and attachments without sending mail. | `mail.send` |
| [`remove_labels`](/docs/tools/remove-labels) | Remove labels, or Outlook categories, from messages. | `mail.organize` |
| [`rename_folder`](/docs/tools/rename-folder) | Rename a folder in a mailbox. Give the new name on its own, without the parent path: the folder stays under the same parent and keeps its messages and subfolders. The new name must not be one another folder has. In Gmail, where the folder is a label, the labels nested under it are renamed to match. System folders such as Inbox, Sent and Trash can't be renamed, and neither can a folder the account settings use as one. In an IMAP mailbox, the folder and its subfolders get new IDs, so use the ID in the result or list the folders again. Message IDs normally stay the same. If one stops working, list the folder again. Call list_folders first to find the folder ID. | `mail.organize` |
| [`restore_emails`](/docs/tools/restore-emails) | Move messages out of the trash. | `mail.trash` |
| [`save_attachment`](/docs/tools/save-attachment) | Save one attachment as a new file in the attachment folder, instead of returning its content. Give the path relative to the folder. The file mustn't exist yet: Fluxmail never replaces one. The attachment size limit does not apply. | `mail.read` |
| [`search_emails`](/docs/tools/search-emails) | Another name for `list_emails`, with the same arguments, permissions and results. | `mail.read` |
| [`search_emails_batch`](/docs/tools/search-emails-batch) | Another name for `list_emails_batch`, with the same arguments, permissions and results. | `mail.read` |
| [`send_email`](/docs/tools/send-email) | Send an email from a connected mailbox. There are three modes: direct (to, subject and body), an existing draft (draftId), or a reply (replyToMessageId, optionally with replyAll) that takes its recipients, subject and threading from the original and quotes it below the body unless quoteOriginal is false. Repeating a successful send with the same idempotencyKey and arguments returns the saved result instead of sending again. Reusing a key with different arguments, or after a failed or uncertain send, returns an error. Add sendAt to any mode to schedule the message instead of sending it now. Confirm with the user when the intent is ambiguous. Scheduled mail is delivered by fluxmail serve or fluxmail scheduled run using the same store. Stdio does not deliver schedules. Overdue mail may send when a worker starts. | `mail.send` |
| [`send_feedback`](/docs/tools/send-feedback) | Submit feedback about Fluxmail with your approval, optional reply address and supported diagnostics. | None |
| [`star_emails`](/docs/tools/star-emails) | Star messages. | `mail.organize` |
| [`trash_emails`](/docs/tools/trash-emails) | Move messages to the trash, where they can be restored until the provider empties it. | `mail.trash` |
| [`unstar_emails`](/docs/tools/unstar-emails) | Remove the star from messages. | `mail.organize` |
| [`update_draft`](/docs/tools/update-draft) | Change an existing draft. Fields left out keep their current values. To clear to, cc or bcc, pass an empty list, and to clear the subject, an empty string. bodyText and bodyHtml replace the whole body together, and attachments replaces all of the attachments. To keep the quoted original when you replace a reply draft's body, pass its replyToMessageId again. A quote Fluxmail added earlier is replaced, not repeated. | `mail.drafts` |
<!-- END GENERATED:mcp-tool-reference -->

## Common behavior

- `accountId` is optional when the connection can access exactly one mailbox.
- List and search tools return message metadata and optional snippets. Set `includeSearchContext` with literal search text when you need an excerpt around the body match. Use `get_email` to retrieve a complete message body.
- Paginated tools return a page token that you can pass to the next request.
- Scheduled messages are sent only while the Fluxmail server is running.
