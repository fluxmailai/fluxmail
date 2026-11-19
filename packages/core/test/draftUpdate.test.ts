import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/types.js';
import { mergeDraftUpdate } from '../src/mcp/draftUpdate.js';

const draft: Message = {
  id: 'm1',
  threadId: 't1',
  accountId: 'a1',
  draftId: 'd1',
  folder: { id: 'Drafts', name: 'Drafts', role: 'drafts' },
  to: [{ name: 'Ann "A" Lee', email: 'ann@example.com' }, { email: 'bo@example.com' }],
  cc: [{ email: 'cy@example.com' }],
  subject: 'Plan',
  date: '2026-11-19T10:00:00.000Z',
  flags: { read: true, starred: false, draft: true },
  body: { text: 'Old text', html: '<p>Old <img src="cid:logo"></p>' },
  attachments: [
    { id: 'p1', filename: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 3, disposition: 'attachment' },
    { id: 'p2', filename: 'logo.png', mimeType: 'image/png', sizeBytes: 3, contentId: 'logo', disposition: 'inline' },
  ],
};

describe('mergeDraftUpdate', () => {
  it('keeps every field the update leaves out', async () => {
    const read = vi.fn(async (attachment: { id: string }) => Buffer.from(attachment.id));

    const merged = await mergeDraftUpdate({ accountId: 'a1', draftId: 'd1' }, draft, read);

    expect(merged).toEqual({
      accountId: 'a1',
      draftId: 'd1',
      to: ['"Ann A Lee" <ann@example.com>', 'bo@example.com'],
      cc: ['cy@example.com'],
      subject: 'Plan',
      bodyText: 'Old text',
      bodyHtml: '<p>Old <img src="cid:logo"></p>',
      attachments: [
        { filename: 'notes.pdf', mimeType: 'application/pdf', content: 'cDE=', disposition: 'attachment' },
        { filename: 'logo.png', mimeType: 'image/png', content: 'cDI=', contentId: 'logo', disposition: 'inline' },
      ],
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('replaces the named fields and clears empty ones', async () => {
    const read = vi.fn();

    const merged = await mergeDraftUpdate(
      { to: ['dee@example.com'], cc: [], subject: '', bodyText: 'New text', attachments: [] },
      draft,
      read,
    );

    expect(merged).toEqual({ to: ['dee@example.com'], cc: [], subject: '', bodyText: 'New text', attachments: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it('replaces both body parts when only the HTML is given', async () => {
    const merged = await mergeDraftUpdate({ bodyHtml: '<p>New</p>', attachments: [] }, draft, vi.fn());

    expect(merged.bodyHtml).toBe('<p>New</p>');
    expect(merged.bodyText).toBeUndefined();
  });

  it('leaves recipients and subject to a reply when the draft has none', async () => {
    const empty: Message = { ...draft, to: [], cc: undefined, subject: '', attachments: [] };

    const merged = await mergeDraftUpdate({ replyToMessageId: 'orig' }, empty, vi.fn());

    expect(merged).toEqual({
      replyToMessageId: 'orig',
      bodyText: 'Old text',
      bodyHtml: '<p>Old <img src="cid:logo"></p>',
    });
  });

  it("keeps the draft's recipients and subject over the original's when replying", async () => {
    const merged = await mergeDraftUpdate({ replyToMessageId: 'orig', attachments: [] }, draft, vi.fn());

    expect(merged).toMatchObject({ to: ['"Ann A Lee" <ann@example.com>', 'bo@example.com'], subject: 'Plan' });
  });
});
