import type { AttachmentInput, AttachmentMeta, EmailAddress, Message } from '../types.js';

/** The update_draft arguments that change a draft's content. */
export interface DraftUpdateFields {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: AttachmentInput[];
}

function addressArgument(address: EmailAddress): string {
  // The argument is parsed back as one address, which can't hold a double quote in its name.
  return address.name ? `"${address.name.replace(/"/g, '')}" <${address.email}>` : address.email;
}

/**
 * The update_draft arguments with every field the call left out taken from the draft as it is now, so an
 * update changes only what it names. An empty list or string clears a field. bodyText and bodyHtml are one
 * body: passing either replaces both. The draft's attachments are kept, with their content read through
 * readAttachment, unless the call passes attachments, which replace all of them.
 */
export async function mergeDraftUpdate<T extends DraftUpdateFields>(
  args: T,
  current: Message,
  readAttachment: (attachment: AttachmentMeta) => Promise<Buffer>,
): Promise<T> {
  const merged: T = { ...args };
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const kept = current[field];
    if (merged[field] === undefined && kept?.length) merged[field] = kept.map(addressArgument);
  }
  if (merged.subject === undefined && current.subject) merged.subject = current.subject;
  if (merged.bodyText === undefined && merged.bodyHtml === undefined) {
    if (current.body?.text !== undefined) merged.bodyText = current.body.text;
    if (current.body?.html !== undefined) merged.bodyHtml = current.body.html;
  }
  if (merged.attachments === undefined && current.attachments?.length) {
    const attachments: AttachmentInput[] = [];
    for (const attachment of current.attachments) {
      attachments.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: (await readAttachment(attachment)).toString('base64'),
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
        ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
      });
    }
    merged.attachments = attachments;
  }
  return merged;
}
