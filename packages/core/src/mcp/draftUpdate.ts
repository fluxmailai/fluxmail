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

/** Whether the HTML refers to the inline image with this Content-ID, and not only to one it begins. */
function referencesContentId(html: string | undefined, contentId: string): boolean {
  if (!html) return false;
  const lower = html.toLowerCase();
  const reference = `cid:${contentId.toLowerCase()}`;
  for (let at = lower.indexOf(reference); at >= 0; at = lower.indexOf(reference, at + 1)) {
    const next = lower[at + reference.length];
    // A reference ends at a quote, which HTML may write as &quot;, or at another character a URL can't continue with.
    if (next === undefined || /["'\s)>;&,]/.test(next)) return true;
  }
  return false;
}

type RecipientField = 'to' | 'cc' | 'bcc';

/**
 * The draft's recipients an update keeps, by field: those the call leaves out, except the to and cc a reply asks
 * for again with replyAll or an empty to. A caller can use these addresses as they are instead of the strings
 * mergeDraftUpdate writes, which can't carry every display name.
 */
export function keptDraftRecipients(
  args: Pick<DraftUpdateFields, RecipientField | 'replyToMessageId' | 'replyAll'>,
  current: Message,
): Partial<Record<RecipientField, EmailAddress[]>> {
  // A reply computes its recipients only when it has no to, so only then do the draft's to and cc stay out.
  const replyRecipients =
    args.replyToMessageId !== undefined && (args.to === undefined ? args.replyAll === true : !args.to.length);
  const kept: Partial<Record<RecipientField, EmailAddress[]>> = {};
  for (const field of ['to', 'cc', 'bcc'] as const) {
    if (replyRecipients && field !== 'bcc') continue;
    const addresses = current[field];
    if (args[field] === undefined && addresses?.length) kept[field] = addresses;
  }
  return kept;
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
      !attachment.mimeType.toLowerCase().startsWith('image/') ||
      referencesContentId(args.bodyHtml, attachment.contentId),
  );
}

/**
 * The update_draft arguments with every field the call left out taken from the draft as it is now, so an
 * update changes only what it names. An empty list or string clears a field. bodyText and bodyHtml are one
 * body: passing either replaces both. The draft's attachments are kept, with their content read through
 * readAttachment one at a time, unless the call passes attachments, which replace all of them. A reply that asks for its
 * recipients again, with replyAll or an empty to, takes to and cc from the original message instead of the draft.
 */
export async function mergeDraftUpdate<T extends DraftUpdateFields>(
  args: T,
  current: Message,
  readAttachment: (attachment: AttachmentMeta) => Promise<Buffer>,
): Promise<T> {
  const merged: T = { ...args };
  for (const [field, addresses] of Object.entries(keptDraftRecipients(args, current)) as [
    RecipientField,
    EmailAddress[],
  ][]) {
    merged[field] = addresses.map(addressArgument);
  }
  if (merged.subject === undefined && current.subject) merged.subject = current.subject;
  if (merged.bodyText === undefined && merged.bodyHtml === undefined) {
    if (current.body?.text !== undefined) merged.bodyText = current.body.text;
    if (current.body?.html !== undefined) merged.bodyHtml = current.body.html;
  }
  if (merged.attachments === undefined && current.attachments?.length) {
    // One at a time, so a caller can stop at its attachment budget before reading the rest.
    const attachments: AttachmentInput[] = [];
    for (const attachment of keptDraftAttachments(args, current)) {
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
