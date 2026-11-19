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
  replyToMessageId?: string;
  replyAll?: boolean;
}

function addressArgument(address: EmailAddress): string {
  // The argument is parsed back as one address, which can't hold a double quote in its name.
  return address.name ? `"${address.name.replace(/"/g, '')}" <${address.email}>` : address.email;
}

/** Whether the HTML refers to the inline image with this Content-ID. */
function referencesContentId(html: string | undefined, contentId: string): boolean {
  return html?.toLowerCase().includes(`cid:${contentId.toLowerCase()}`) ?? false;
}

/**
 * The draft attachments an update keeps. A replaced body drops the inline images it no longer shows, such as
 * those of a reply quote the new body leaves out.
 */
export function keptDraftAttachments(
  args: Pick<DraftUpdateFields, 'attachments' | 'bodyText' | 'bodyHtml'>,
  current: Message,
): AttachmentMeta[] {
  if (args.attachments !== undefined) return [];
  const bodyReplaced = args.bodyText !== undefined || args.bodyHtml !== undefined;
  return (current.attachments ?? []).filter(
    (attachment) =>
      !bodyReplaced ||
      attachment.disposition !== 'inline' ||
      !attachment.contentId ||
      referencesContentId(args.bodyHtml, attachment.contentId),
  );
}

/**
 * The update_draft arguments with every field the call left out taken from the draft as it is now, so an
 * update changes only what it names. An empty list or string clears a field. bodyText and bodyHtml are one
 * body: passing either replaces both. The draft's attachments are kept, with their content read through
 * readAttachment, unless the call passes attachments, which replace all of them. A reply that asks for its
 * recipients again, with replyAll or an empty to, takes to and cc from the original message instead of the draft.
 */
export async function mergeDraftUpdate<T extends DraftUpdateFields>(
  args: T,
  current: Message,
  readAttachment: (attachment: AttachmentMeta) => Promise<Buffer>,
): Promise<T> {
  const merged: T = { ...args };
  const replyRecipients =
    args.replyToMessageId !== undefined && (args.replyAll === true || (args.to !== undefined && !args.to.length));
  for (const field of ['to', 'cc', 'bcc'] as const) {
    if (replyRecipients && field !== 'bcc') continue;
    const kept = current[field];
    if (merged[field] === undefined && kept?.length) merged[field] = kept.map(addressArgument);
  }
  if (merged.subject === undefined && current.subject) merged.subject = current.subject;
  if (merged.bodyText === undefined && merged.bodyHtml === undefined) {
    if (current.body?.text !== undefined) merged.bodyText = current.body.text;
    if (current.body?.html !== undefined) merged.bodyHtml = current.body.html;
  }
  if (merged.attachments === undefined && current.attachments?.length) {
    const kept = keptDraftAttachments(args, current);
    merged.attachments = await Promise.all(
      kept.map(async (attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: (await readAttachment(attachment)).toString('base64'),
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
        ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
      })),
    );
  }
  return merged;
}
