import { describe, expect, it } from 'vitest';
import { providerNotFoundMessage, providerNotFoundTarget } from '../src/mcp/index.js';

describe('provider not_found explanations', () => {
  it.each([
    ['get_draft', { draftId: 'm1' }, 'draft', 'This mailbox has no draft with this draftId.'],
    ['send_email', { draftId: 'm1' }, 'draft', 'This mailbox has no draft with this draftId.'],
    [
      'update_draft',
      { draftId: 'd1', replyToMessageId: 'm1' },
      'draft_or_reply_original',
      'This mailbox has no draft with this draftId, or no message with this replyToMessageId.',
    ],
    [
      'create_draft',
      { replyToMessageId: 'm1' },
      'reply_original',
      'This mailbox has no message with this replyToMessageId.',
    ],
    ['get_thread', { threadId: 'm1' }, 'thread', 'This mailbox has no thread with this threadId.'],
    ['forward_email', { messageId: 'm1' }, 'message', 'This mailbox has no message with this messageId.'],
    [
      'download_attachment',
      { messageId: 'm1', attachmentId: 'a1' },
      'message_or_attachment',
      'This mailbox has no message or attachment with these IDs.',
    ],
    ['list_emails', { folder: 'Gone' }, 'folder', 'This mailbox has no folder with this name.'],
    ['search_emails', { folder: 'Gone', query: 'x' }, 'folder', 'This mailbox has no folder with this name.'],
  ])('names the argument %s could not match', (tool, input, target, start) => {
    expect(providerNotFoundTarget(tool, input)).toBe(target);
    expect(providerNotFoundMessage(tool, input)?.startsWith(start)).toBe(true);
  });

  it.each([
    ['list_emails', {}],
    // A later page can point at mail that no longer exists.
    ['list_emails', { folder: 'Archive', pageToken: 'page-2' }],
    ['move_emails', { messageIds: ['m1'] }],
    ['list_emails', { folder: '  ' }],
    // The batch tools name folders by role and page each mailbox separately.
    ['list_emails_batch', { folder: 'archive', accounts: [{ accountId: 'a', pageToken: 'p2' }] }],
  ])('leaves %s unexplained when its arguments do not say what was missing', (tool, input) => {
    expect(providerNotFoundTarget(tool, input)).toBe('other');
    expect(providerNotFoundMessage(tool, input)).toBeUndefined();
  });
});
