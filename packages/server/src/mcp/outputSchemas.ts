import { z } from 'zod';

const address = z.object({ email: z.string(), name: z.string().optional() }).passthrough();
const attachment = z
  .object({ id: z.string(), filename: z.string(), mimeType: z.string(), sizeBytes: z.number() })
  .passthrough();
const message = z
  .object({
    id: z.string(),
    threadId: z.string(),
    accountId: z.string(),
    to: z.array(address),
    subject: z.string(),
    date: z.string(),
    flags: z.object({ read: z.boolean(), starred: z.boolean(), draft: z.boolean() }).passthrough(),
    body: z.object({ text: z.string().optional(), html: z.string().optional() }).optional(),
    bodyTruncation: z
      .record(z.string(), z.object({ totalChars: z.number(), nextOffset: z.number().optional() }))
      .optional(),
    attachments: z.array(attachment).optional(),
  })
  .passthrough();
const account = z.object({ id: z.string(), provider: z.string(), email: z.string(), status: z.string() }).passthrough();
const page = z
  .object({ items: z.array(message), exhausted: z.boolean(), nextPageToken: z.string().optional() })
  .passthrough();
const delivery = z
  .object({
    operationId: z.string(),
    accountId: z.string(),
    kind: z.string(),
    status: z.string(),
    result: z.object({ id: z.string(), threadId: z.string() }).passthrough().optional(),
    error: z.object({ code: z.string() }).optional(),
    scheduleId: z.string().optional(),
  })
  .passthrough();
const schedule = z
  .object({ scheduleId: z.string(), accountId: z.string(), draftId: z.string(), status: z.string() })
  .passthrough();
const modify = z
  .object({
    action: z.string(),
    succeededIds: z.array(z.string()),
    failed: z.array(z.object({ messageId: z.string(), code: z.string() })),
    uncertainIds: z.array(z.string()),
  })
  .passthrough();

export const outputSchemas = {
  list_accounts: { data: z.array(account) },
  get_status: { data: z.object({ accounts: z.array(account), providersAvailable: z.array(z.string()) }).passthrough() },
  list_folders: { data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) },
  list_labels: { data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) },
  list_send_as: {
    data: z.array(z.object({ email: z.string(), isPrimary: z.boolean(), source: z.string() }).passthrough()),
  },
  list_emails: { data: page },
  search_emails: { data: page },
  search_emails_batch: {
    data: z
      .object({ groups: z.array(z.object({ accountId: z.string() }).passthrough()), exhausted: z.boolean() })
      .passthrough(),
  },
  get_email: { data: message.extend({ headers: z.record(z.string(), z.string()).optional() }) },
  get_email_body: {
    data: z.object({
      format: z.string(),
      text: z.string(),
      offset: z.number(),
      totalChars: z.number(),
      nextOffset: z.number().optional(),
    }),
  },
  get_thread: {
    data: z.object({
      id: z.string(),
      subject: z.string(),
      messages: z.array(message),
      nextPageToken: z.string().optional(),
    }),
  },
  get_draft: { data: message },
  create_draft: { data: message },
  update_draft: { data: message },
  delete_draft: { data: z.object({ deleted: z.string() }) },
  preview_send: {
    data: z.object({
      accountId: z.string(),
      from: z.string(),
      to: z.array(address),
      cc: z.array(address),
      bcc: z.array(address),
      subject: z.string(),
      attachments: z.array(z.object({ filename: z.string(), mimeType: z.string(), sizeBytes: z.number() })),
      bodyTextChars: z.number(),
      bodyHtmlChars: z.number(),
    }),
  },
  send_email: { data: delivery },
  get_delivery_operation: { data: delivery },
  list_scheduled_emails: { data: z.array(schedule) },
  cancel_scheduled_email: {
    data: z.object({ scheduleId: z.string(), draftId: z.string(), draftKept: z.literal(true) }),
  },
  forward_email: { data: delivery },
  mark_emails_read: { data: modify },
  mark_emails_unread: { data: modify },
  star_emails: { data: modify },
  unstar_emails: { data: modify },
  archive_emails: { data: modify },
  move_emails: { data: modify },
  add_labels: { data: modify },
  remove_labels: { data: modify },
  trash_emails: { data: modify },
  restore_emails: { data: modify },
  delete_emails: { data: modify },
  download_attachment: { data: attachment },
} as const;
