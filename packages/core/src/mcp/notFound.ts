import { sharedToolTarget } from './tools.js';

/** What a provider's not_found error couldn't find, judged from the tool and its arguments. */
export const PROVIDER_NOT_FOUND_TARGETS = [
  'message',
  'thread',
  'draft',
  'reply_original',
  'draft_or_reply_original',
  'message_or_attachment',
  'folder',
  'other',
] as const;
export type ProviderNotFoundTarget = (typeof PROVIDER_NOT_FOUND_TARGETS)[number];

// Providers report every missing item with the same code. Agents most often
// pass the wrong kind of ID, such as a Gmail message id as a draftId, or an ID
// from another mailbox, so the message names the argument that didn't match
// and where a valid value comes from.
const MESSAGES: Partial<Record<ProviderNotFoundTarget, string>> = {
  message: 'This mailbox has no message with this messageId. Use a message id from list_emails or get_thread.',
  thread:
    'This mailbox has no thread with this threadId. Use the threadId field from list_emails or get_email, which can differ from the message id.',
  draft:
    'This mailbox has no draft with this draftId. Use the draftId field from create_draft or list_emails, which can differ from the message id.',
  reply_original:
    'This mailbox has no message with this replyToMessageId. Use a message id from list_emails or get_thread.',
  draft_or_reply_original:
    'This mailbox has no draft with this draftId, or no message with this replyToMessageId. Use the draftId field from create_draft or list_emails, which can differ from the message id.',
  message_or_attachment:
    'This mailbox has no message or attachment with these IDs. Use an attachment id that get_email returns for the same message.',
  folder: 'This mailbox has no folder with this name. Use a folder id or name from list_folders.',
};

const DRAFT_TOOLS = new Set<string>(['update_draft', 'preview_send', 'send_email']);
const MESSAGE_TOOLS = new Set<string>(['get_email', 'get_email_body', 'forward_email']);

function filled(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '';
}

/** What a shared tool's provider not_found refers to, or `other` when its arguments don't say. */
export function providerNotFoundTarget(name: string, input: unknown): ProviderNotFoundTarget {
  const tool = sharedToolTarget(name);
  const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (tool === 'get_draft' || tool === 'delete_draft') return 'draft';
  if (tool === 'get_thread') return 'thread';
  if (MESSAGE_TOOLS.has(tool)) return 'message';
  if (tool === 'download_attachment') return 'message_or_attachment';
  const draftTool = DRAFT_TOOLS.has(tool);
  if (draftTool || tool === 'create_draft') {
    const draft = draftTool && filled(args, 'draftId');
    const original = filled(args, 'replyToMessageId');
    if (draft && original) return 'draft_or_reply_original';
    if (draft) return 'draft';
    if (original) return 'reply_original';
  }
  // A later page can also point at mail that no longer exists. The batch
  // tools name folders by role, so list_folders doesn't help there.
  if (tool === 'list_emails' && filled(args, 'folder') && !filled(args, 'pageToken')) return 'folder';
  return 'other';
}

/** Explains a shared tool's provider not_found error, or undefined when its arguments don't say what was missing. */
export function providerNotFoundMessage(tool: string, input: unknown): string | undefined {
  return MESSAGES[providerNotFoundTarget(tool, input)];
}
