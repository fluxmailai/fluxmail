import {
  withoutTrailingLineBreaks,
  type AttachmentMeta,
  type EmailAddress,
  type Folder,
  type Message,
} from '@fluxmail/core';
import type { GraphAttachment, GraphMessage, GraphRecipient } from './types.js';

function address(recipient: GraphRecipient | null | undefined): EmailAddress | undefined {
  const email = recipient?.emailAddress?.address?.trim();
  if (!email) return undefined;
  const name = recipient?.emailAddress?.name?.trim();
  return { ...(name ? { name } : {}), email };
}

function addresses(recipients: GraphRecipient[] | null | undefined): EmailAddress[] {
  return (recipients ?? []).map(address).filter((value): value is EmailAddress => !!value);
}

export function parseGraphAttachment(raw: GraphAttachment, index = 0): AttachmentMeta | undefined {
  if (!raw.id) return undefined;
  const filename = raw.name?.trim() || `attachment-${index + 1}`;
  return {
    id: raw.id,
    filename,
    mimeType: raw.contentType?.trim() || 'application/octet-stream',
    sizeBytes: raw.size ?? 0,
    ...(raw.contentId ? { contentId: raw.contentId.replace(/^<|>$/g, '') } : {}),
    disposition: raw.isInline ? 'inline' : 'attachment',
  };
}

export function parseGraphMessage(
  raw: GraphMessage,
  context: {
    accountId: string;
    folder?: Folder;
    includeBody?: boolean;
    includeAttachments?: boolean;
    includeHeaders?: boolean;
  },
): Message {
  const id = raw.id ?? '';
  const date = raw.receivedDateTime ?? raw.sentDateTime ?? raw.createdDateTime ?? new Date(0).toISOString();
  const message: Message = {
    id,
    threadId: raw.conversationId ?? id,
    accountId: context.accountId,
    ...(raw.isDraft ? { draftId: id } : {}),
    ...(context.folder ? { folder: context.folder } : {}),
    ...(raw.categories?.length ? { labels: raw.categories } : {}),
    ...(address(raw.from) ? { from: address(raw.from) } : {}),
    to: addresses(raw.toRecipients),
    ...(addresses(raw.ccRecipients).length ? { cc: addresses(raw.ccRecipients) } : {}),
    ...(addresses(raw.bccRecipients).length ? { bcc: addresses(raw.bccRecipients) } : {}),
    ...(addresses(raw.replyTo).length ? { replyTo: addresses(raw.replyTo) } : {}),
    subject: raw.subject ?? '',
    date: new Date(date).toISOString(),
    ...(raw.bodyPreview != null ? { snippet: raw.bodyPreview } : {}),
    flags: {
      read: raw.isRead ?? false,
      starred: raw.flag?.flagStatus === 'flagged',
      draft: raw.isDraft ?? false,
    },
  };
  if (context.includeBody) {
    const content = raw.body?.content ?? '';
    message.body =
      raw.body?.contentType?.toLowerCase() === 'text'
        ? { text: withoutTrailingLineBreaks(content) }
        : { html: content };
  }
  if (context.includeAttachments) {
    message.attachments = (raw.attachments ?? [])
      .map(parseGraphAttachment)
      .filter((item): item is AttachmentMeta => !!item);
  }
  if (context.includeHeaders) {
    message.headers = Object.fromEntries(
      (raw.internetMessageHeaders ?? [])
        .filter((header) => header.name && header.value != null)
        .map((header) => [header.name!, header.value!]),
    );
  }
  return message;
}

export function toGraphRecipients(values: EmailAddress[] | undefined): GraphRecipient[] {
  return (values ?? []).map((value) => ({
    emailAddress: { address: value.email, ...(value.name ? { name: value.name } : {}) },
  }));
}
