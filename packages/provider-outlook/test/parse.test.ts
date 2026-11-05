import { describe, expect, it } from 'vitest';
import { parseGraphMessage } from '../src/parse.js';

describe('Microsoft Graph message parsing', () => {
  it('maps addresses, folders, flags, bodies, attachments, and headers', () => {
    const message = parseGraphMessage(
      {
        id: 'msg-1',
        conversationId: 'conversation-1',
        parentFolderId: 'inbox-id',
        from: { emailAddress: { name: 'Alex', address: 'alex@example.com' } },
        toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
        ccRecipients: [{ emailAddress: { name: 'Casey', address: 'casey@example.com' } }],
        replyTo: [{ emailAddress: { address: 'reply@example.com' } }],
        subject: 'Status',
        receivedDateTime: '2026-07-14T12:00:00Z',
        bodyPreview: 'A short preview',
        body: { contentType: 'html', content: '<p>Hello</p>' },
        isRead: false,
        isDraft: true,
        flag: { flagStatus: 'flagged' },
        attachments: [
          {
            id: 'attachment-1',
            name: 'chart.png',
            contentType: 'image/png',
            size: 42,
            isInline: true,
            contentId: '<chart>',
          },
        ],
        internetMessageHeaders: [{ name: 'Message-ID', value: '<one@example.com>' }],
      },
      {
        accountId: 'acct-1',
        folder: { id: 'inbox-id', name: 'Inbox', role: 'inbox' },
        includeBody: true,
        includeAttachments: true,
        includeHeaders: true,
      },
    );

    expect(message).toMatchObject({
      id: 'msg-1',
      threadId: 'conversation-1',
      draftId: 'msg-1',
      from: { name: 'Alex', email: 'alex@example.com' },
      to: [{ email: 'me@example.com' }],
      cc: [{ name: 'Casey', email: 'casey@example.com' }],
      replyTo: [{ email: 'reply@example.com' }],
      folder: { role: 'inbox' },
      body: { html: '<p>Hello</p>' },
      flags: { read: false, starred: true, draft: true },
      headers: { 'Message-ID': '<one@example.com>' },
    });
    expect(message.attachments).toEqual([
      {
        id: 'attachment-1',
        filename: 'chart.png',
        mimeType: 'image/png',
        sizeBytes: 42,
        contentId: 'chart',
        disposition: 'inline',
      },
    ]);
  });

  it('returns text bodies and omits optional list-only fields', () => {
    const message = parseGraphMessage(
      {
        id: 'msg-2',
        subject: null,
        body: { contentType: 'text', content: 'Plain text\r\n\r\n' },
        sentDateTime: '2026-07-14T12:00:00Z',
      },
      { accountId: 'acct-1', includeBody: true },
    );
    expect(message.body).toEqual({ text: 'Plain text' });
    expect(message.attachments).toBeUndefined();
    expect(message.headers).toBeUndefined();
  });
});
