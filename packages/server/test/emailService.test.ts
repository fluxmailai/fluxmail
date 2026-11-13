import { describe, expect, it, vi } from 'vitest';
import { EmailError, type Message, type SearchCapabilities } from '@fluxmail/core';
import { EmailService, resolveSendAt } from '../src/service/emailService.js';
import { DeliveryCoordinator } from '../src/service/deliveryCoordinator.js';
import { ClientInputError, publicError } from '../src/service/publicErrors.js';
import {
  accountSendAs,
  accounts,
  deliveryOperations,
  members,
  openDb,
  scheduledSends,
  type FluxmailDb,
} from '../src/storage/db.js';
import { eq } from 'drizzle-orm';
import { createScheduledSend, listScheduledSends } from '../src/storage/scheduledSends.js';
import { FULL_PERMISSION_POLICY, permissionPolicyForProfile, type PermissionPolicy } from '../src/permissions.js';
import { listConfiguredSendAs, replaceConfiguredSendAs } from '../src/storage/sendAs.js';

function testDb(): FluxmailDb {
  const db = openDb(':memory:');
  db.insert(accounts)
    .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
    .run();
  return db;
}

const original: Message = {
  id: 'm1',
  threadId: 't1',
  accountId: 'acct_1',
  from: { name: 'Ann', email: 'ann@example.com' },
  to: [{ email: 'me@example.com' }],
  cc: [{ email: 'carol@example.com' }],
  subject: 'Report',
  date: '2026-07-01T12:00:00.000Z',
  body: { text: 'original text', html: '<p>original <b>html</b></p>' },
  attachments: [],
  flags: { read: true, starred: false, draft: false },
};

describe('EmailService.forward', () => {
  it('preserves inline attachment metadata', async () => {
    const message: Message = {
      ...original,
      body: { html: '<img src="cid:chart@example.com">' },
      attachments: [
        {
          id: 'attachment_1',
          filename: 'chart.png',
          mimeType: 'image/png',
          sizeBytes: 10,
          contentId: 'chart@example.com',
          disposition: 'inline',
        },
      ],
    };
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 'thread_1' });
    const provider = {
      getMessage: vi.fn().mockResolvedValue(message),
      getAttachment: vi.fn().mockResolvedValue({
        meta: message.attachments![0],
        content: Buffer.from('image data'),
      }),
      send,
      markReplied: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => ({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'active',
        capabilities: {},
      }),
      getProvider: () => provider,
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb());

    await service.forward(undefined, {
      messageId: message.id,
      to: [{ email: 'bob@example.com' }],
    });
    // Without its attachments, a forward still carries the images its HTML shows.
    message.attachments!.push({
      id: 'attachment_2',
      filename: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    });
    await service.forward(undefined, {
      messageId: message.id,
      to: [{ email: 'bob@example.com' }],
      includeAttachments: false,
    });

    for (const [draft] of send.mock.calls)
      expect(draft.attachments).toEqual([
        expect.objectContaining({
          filename: 'chart.png',
          contentId: 'chart@example.com',
          disposition: 'inline',
        }),
      ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(provider.markReplied.mock.calls).toEqual([
      [message.id, 'forward'],
      [message.id, 'forward'],
    ]);
  });
});

describe('EmailService bulk and content limits', () => {
  function serviceWith(provider: Record<string, unknown>, attachmentLimit = 1024) {
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => ({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'active',
        capabilities: {},
      }),
      getProvider: () => provider,
      markStatus: vi.fn(),
    };
    return new EmailService(registry as never, testDb(), undefined, undefined, attachmentLimit);
  }

  it('deduplicates IDs, continues after failures, and reports ambiguous changes', async () => {
    let active = 0;
    let peak = 0;
    const modify = vi.fn(async (ids: string[]) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      if (ids.includes('m2')) throw new EmailError('not_found', 'missing');
      if (ids.includes('m3')) throw new EmailError('provider_unavailable', 'ambiguous');
    });
    const service = serviceWith({ modify });
    const result = await service.modify('acct_1', ['m1', 'm2', 'm1', 'm3', 'm4', 'm5'], 'markRead');
    expect(result).toEqual({
      action: 'markRead',
      succeededIds: ['m1', 'm4', 'm5'],
      failed: [{ messageId: 'm2', code: 'not_found' }],
      uncertainIds: ['m3'],
    });
    expect(modify.mock.calls.map(([ids]) => ids)).toEqual([
      ['m1', 'm2', 'm3', 'm4', 'm5'],
      ['m1'],
      ['m2'],
      ['m3'],
      ['m4'],
      ['m5'],
    ]);
    expect(peak).toBeLessThanOrEqual(4);
    await expect(
      service.modify(
        'acct_1',
        Array.from({ length: 101 }, (_, index) => `m${index}`),
        'markRead',
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(modify).toHaveBeenCalledTimes(6);
  });

  it('changes every message in one provider call when the batch succeeds', async () => {
    const modify = vi.fn().mockResolvedValue(undefined);
    const service = serviceWith({ modify });
    await expect(service.modify('acct_1', ['m1', 'm2', 'm1', 'm3'], 'archive')).resolves.toEqual({
      action: 'archive',
      succeededIds: ['m1', 'm2', 'm3'],
      failed: [],
      uncertainIds: [],
    });
    expect(modify).toHaveBeenCalledExactlyOnceWith(['m1', 'm2', 'm3'], 'archive');
  });

  it('deletes one message per provider call so each outcome is known', async () => {
    const modify = vi.fn().mockResolvedValue(undefined);
    const service = serviceWith({ modify });
    await service.modify('acct_1', ['m1', 'm2'], 'delete');
    expect(modify.mock.calls).toEqual([
      [['m1'], 'delete'],
      [['m2'], 'delete'],
    ]);
  });

  it.each(['active', 'auth_error'] as const)(
    'keeps account authentication status accurate after a bulk auth failure from %s',
    async (initialStatus) => {
      const account = {
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: initialStatus as 'active' | 'auth_error',
        capabilities: {},
      };
      const markStatus = vi.fn((_id: string, status: 'active' | 'auth_error') => {
        account.status = status;
      });
      const service = new EmailService(
        {
          resolveAccountId: () => account.id,
          getAccount: () => account,
          getProvider: () => ({ modify: vi.fn().mockRejectedValue(new EmailError('auth_expired', 'expired')) }),
          markStatus,
        } as never,
        testDb(),
      );

      const result = await service.modify(account.id, ['m1'], 'markRead');

      expect(result.failed).toEqual([{ messageId: 'm1', code: 'auth_expired' }]);
      expect(account.status).toBe('auth_error');
      expect(markStatus).toHaveBeenLastCalledWith(account.id, 'auth_error');
    },
  );

  it.each(['rate_limited', 'permission_denied', 'provider_unavailable'] as const)(
    'reports every message as uncertain without retrying after a %s batch failure',
    async (code) => {
      const modify = vi.fn().mockRejectedValue(new EmailError(code, 'failed after changing some messages'));
      const service = serviceWith({ modify });

      await expect(service.modify('acct_1', ['m1', 'm2', 'm3'], 'trash')).resolves.toEqual({
        action: 'trash',
        succeededIds: [],
        failed: [],
        uncertainIds: ['m1', 'm2', 'm3'],
      });
      expect(modify).toHaveBeenCalledOnce();
    },
  );

  it('marks the account for reauthorization after an auth_expired batch failure', async () => {
    const account = { id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', capabilities: {} };
    const markStatus = vi.fn();
    const modify = vi.fn().mockRejectedValue(new EmailError('auth_expired', 'expired'));
    const service = new EmailService(
      {
        resolveAccountId: () => account.id,
        getAccount: () => account,
        getProvider: () => ({ modify }),
        markStatus,
      } as never,
      testDb(),
    );

    const result = await service.modify(account.id, ['m1', 'm2'], 'markRead');

    expect(result).toMatchObject({ failed: [], uncertainIds: ['m1', 'm2'] });
    expect(modify).toHaveBeenCalledOnce();
    expect(markStatus).toHaveBeenLastCalledWith(account.id, 'auth_error');
  });

  it('previews reply-all recipients and subject without sending', async () => {
    const send = vi.fn();
    const getMessage = vi.fn().mockResolvedValue(original);
    const service = serviceWith({ send, getMessage });
    const preview = await service.previewSend('acct_1', {
      replyToMessageId: 'm1',
      replyAll: true,
      body: { text: 'Thanks' },
    });
    expect(preview).toMatchObject({
      from: 'me@example.com',
      to: [{ email: 'ann@example.com' }],
      cc: [{ email: 'carol@example.com' }],
      subject: 'Re: Report',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['', 'Zg==', 'Zm8=', 'Zm9v'])('accepts base64 attachment content %j', async (content) => {
    const createDraft = vi.fn().mockResolvedValue(original);
    const service = serviceWith({ createDraft });
    await service.createDraft('acct_1', {
      body: { text: 'hi' },
      to: [{ email: 'recipient@example.com' }],
      attachments: [{ filename: 'a', mimeType: 'text/plain', content }],
    });
    expect(createDraft).toHaveBeenCalledOnce();
  });

  it.each(['Zg', 'Zg=', 'Z===', '====', 'Zm=v', 'Zm9v====', 'Zm-v', 'AAA\n', 'Zm9v\n', 'Zm9 '])(
    'rejects malformed base64 attachment content %j before provider work',
    async (content) => {
      const createDraft = vi.fn();
      const service = serviceWith({ createDraft });
      await expect(
        service.createDraft('acct_1', {
          body: { text: 'hi' },
          attachments: [{ filename: 'a', mimeType: 'text/plain', content }],
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(createDraft).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized bodies and combined attachments before provider work', async () => {
    const send = vi.fn();
    const service = serviceWith({ send }, 4);
    await expect(
      service.send('acct_1', { body: { text: 'x'.repeat(1024 * 1024 + 1) }, to: [{ email: 'recipient@example.com' }] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      service.send('acct_1', {
        body: { text: 'hi' },
        attachments: [
          { filename: 'a', mimeType: 'text/plain', content: Buffer.from('abc').toString('base64') },
          { filename: 'b', mimeType: 'text/plain', content: Buffer.from('def').toString('base64') },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      service.send('acct_1', {
        body: { text: 'hi' },
        attachments: Array.from({ length: 21 }, (_, index) => ({
          filename: `a${index}`,
          mimeType: 'text/plain',
          content: '',
        })),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(send).not.toHaveBeenCalled();

    const getAttachment = vi.fn();
    const forwardService = serviceWith(
      {
        getMessage: vi.fn().mockResolvedValue({
          ...original,
          attachments: Array.from({ length: 21 }, (_, index) => ({
            id: `a${index}`,
            filename: 'a',
            mimeType: 'text/plain',
            sizeBytes: 1,
          })),
        }),
        getAttachment,
        send,
      },
      1024,
    );
    await expect(
      forwardService.forward('acct_1', { messageId: 'm1', to: [{ email: 'recipient@example.com' }] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(getAttachment).not.toHaveBeenCalled();
  });
});

describe('EmailService send-as selection', () => {
  const identities = [
    { email: 'me@example.com', name: 'Primary', isPrimary: true, source: 'provider' as const },
    { email: 'sales@example.com', name: 'Sales', isPrimary: false, source: 'provider' as const },
    { email: 'support@example.com', isPrimary: false, source: 'provider' as const },
  ];

  function serviceWith(provider: Record<string, unknown>) {
    const account = {
      id: 'acct_1',
      provider: 'gmail',
      email: 'me@example.com',
      displayName: 'Primary',
      status: 'active',
      capabilities: {},
      ownerMemberId: 'member_1',
      sharedWithAll: false,
      grantedMemberIds: [],
    };
    const registry = {
      getAccount: () => account,
      listAccounts: () => [account],
      getProvider: () => provider,
      markStatus: vi.fn(),
    };
    return new EmailService(registry as never, testDb());
  }

  it('uses the first owned To address before Cc even when explicit recipients are supplied', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const message = {
      ...original,
      to: [{ email: 'SALES@example.com' }],
      cc: [{ email: 'support@example.com' }],
    };
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue(message),
      createDraft,
    });

    await service.createDraft('acct_1', {
      to: [{ email: 'customer@example.com' }],
      replyToMessageId: message.id,
      body: { text: 'Reply' },
    });

    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ from: 'sales@example.com' }));
  });

  it('lets an explicit sender override automatic reply selection', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 'thread_1' });
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue({ ...original, to: [{ email: 'sales@example.com' }] }),
      send,
    });

    await service.send('acct_1', {
      from: 'SUPPORT@example.com',
      replyToMessageId: original.id,
      body: { text: 'Reply' },
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: 'support@example.com' }));
  });

  it('keeps an explicit primary sender when updating a reply draft', async () => {
    const updateDraft = vi.fn().mockResolvedValue({});
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue({ ...original, to: [{ email: 'sales@example.com' }] }),
      updateDraft,
    });

    await service.updateDraft('acct_1', 'draft_1', {
      from: 'ME@example.com',
      replyToMessageId: original.id,
      body: { text: 'Reply' },
    });

    expect(updateDraft).toHaveBeenCalledWith('draft_1', expect.objectContaining({ from: 'me@example.com' }));
  });

  it('quotes the original below a reply draft, send and preview', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 't1' });
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue(original),
      createDraft,
      send,
    });
    const header = 'On Wed, Jul 1, 2026 at 12:00 PM UTC Ann <ann@example.com> wrote:';
    // The original has an HTML part, so the plain-text reply gets one too.
    const quoted = {
      text: `Thanks\n\n${header}\n> original text`,
      html: expect.stringMatching(
        /^<p>Thanks<\/p><div class="fluxmail_quote">.*<p>original <b>html<\/b><\/p><\/blockquote><\/div>$/,
      ),
    };

    await service.createDraft('acct_1', { replyToMessageId: original.id, body: { text: 'Thanks' } });
    await service.send('acct_1', { replyToMessageId: original.id, body: { text: 'Thanks' } });
    const preview = await service.previewSend('acct_1', { replyToMessageId: original.id, body: { text: 'Thanks' } });

    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ body: quoted }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ body: quoted }));
    expect(preview.bodyTextChars).toBe(quoted.text.length);
    expect(preview.bodyHtmlChars).toBeGreaterThan(0);
  });

  it('dates the quoted reply in the configured time zone', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => ({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active' }),
      listAccounts: () => [],
      getProvider: () => ({
        listSendAs: vi.fn().mockResolvedValue(identities),
        getMessage: vi.fn().mockResolvedValue(original),
        createDraft,
      }),
      markStatus: vi.fn(),
    };
    const service = new EmailService(
      registry as never,
      testDb(),
      undefined,
      undefined,
      undefined,
      'America/Los_Angeles',
    );

    await service.createDraft('acct_1', { replyToMessageId: original.id, body: { text: 'Thanks' } });

    expect(createDraft.mock.calls[0]![0].body.text).toContain('On Wed, Jul 1, 2026 at 5:00 AM Ann');

    // A request can override the configured zone; an unknown zone is rejected.
    await service.createDraft('acct_1', {
      replyToMessageId: original.id,
      timeZone: 'Asia/Tokyo',
      body: { text: 'Thanks' },
    });
    expect(createDraft.mock.calls[1]![0].body.text).toContain('On Wed, Jul 1, 2026 at 9:00 PM Ann');
    expect(createDraft.mock.calls[1]![0]).not.toHaveProperty('timeZone');
    await expect(
      service.createDraft('acct_1', { replyToMessageId: original.id, timeZone: 'Eastern', body: { text: 'Hi' } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.status()).resolves.toMatchObject({ timeZone: 'America/Los_Angeles' });
  });

  it('attaches the images the quoted original shows', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const getAttachment = vi.fn().mockResolvedValue({ content: Buffer.from('png') });
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue({
        ...original,
        body: { html: '<p>See <img src="cid:chart@x"></p>' },
        attachments: [
          { id: 'att_1', filename: 'chart.png', mimeType: 'image/png', sizeBytes: 3, contentId: 'chart@x' },
          { id: 'att_2', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
        ],
      }),
      getAttachment,
      createDraft,
    });

    await service.createDraft('acct_1', { replyToMessageId: original.id, body: { html: '<p>Thanks</p>' } });
    await service.createDraft('acct_1', {
      replyToMessageId: original.id,
      quoteOriginal: false,
      body: { html: '<p>Thanks</p>' },
    });

    expect(getAttachment).toHaveBeenCalledOnce();
    expect(getAttachment).toHaveBeenCalledWith(original.id, 'att_1', { maxBytes: expect.any(Number) });
    expect(createDraft.mock.calls[0]![0].attachments).toEqual([
      {
        filename: 'chart.png',
        mimeType: 'image/png',
        content: Buffer.from('png').toString('base64'),
        contentId: 'chart@x',
        disposition: 'inline',
      },
    ]);
    expect(createDraft.mock.calls[1]![0].attachments).toBeUndefined();
  });

  it('leaves out a quoted image the provider fails to return', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const getAttachment = vi.fn();
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue({
        ...original,
        body: { html: '<p>See <img src="cid:chart@x"></p>' },
        attachments: [
          { id: 'att_1', filename: 'chart.png', mimeType: 'image/png', sizeBytes: 3, contentId: 'chart@x' },
        ],
      }),
      getAttachment,
      createDraft,
    });
    const reply = () =>
      service.createDraft('acct_1', { replyToMessageId: original.id, body: { html: '<p>Thanks</p>' } });

    getAttachment.mockRejectedValueOnce(new EmailError('provider_unavailable', 'Try later'));
    await reply();
    expect(createDraft.mock.calls[0]![0].attachments).toBeUndefined();
    expect(createDraft.mock.calls[0]![0].body.html).toContain('cid:chart@x');

    // A failure that isn't the provider's still fails the reply.
    getAttachment.mockRejectedValueOnce(new TypeError('bug'));
    await expect(reply()).rejects.toThrow('bug');
    expect(createDraft).toHaveBeenCalledOnce();
  });

  it('marks the original answered after a reply is sent, and only logs a failure', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 't1' });
    const markReplied = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('flag failed'));
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue(original),
      send,
      markReplied,
    });

    await service.send('acct_1', { to: [{ email: 'bob@example.com' }], body: { text: 'New thread' } });
    expect(markReplied).not.toHaveBeenCalled();
    await service.send('acct_1', { replyToMessageId: original.id, body: { text: 'Thanks' } });
    await expect(service.send('acct_1', { replyToMessageId: original.id, body: { text: 'Thanks' } })).resolves.toEqual({
      id: 'sent_1',
      threadId: 't1',
    });
    expect(markReplied.mock.calls).toEqual([
      [original.id, 'reply'],
      [original.id, 'reply'],
    ]);
  });

  it('leaves the original out when quoteOriginal is false', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue(original),
      createDraft,
    });

    await service.createDraft('acct_1', {
      replyToMessageId: original.id,
      quoteOriginal: false,
      body: { text: 'Thanks' },
    });

    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ body: { text: 'Thanks' }, to: [original.from] }),
    );
    expect(createDraft.mock.calls[0]![0]).not.toHaveProperty('quoteOriginal');
  });

  it('shortens the quote when it would exceed the body limit', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue({ ...original, body: { text: 'x'.repeat(1024 * 1024) } }),
      createDraft,
    });

    await service.createDraft('acct_1', { replyToMessageId: original.id, body: { text: 'Thanks' } });

    const text: string = createDraft.mock.calls[0]![0].body.text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
    expect(text).toMatch(/^Thanks\n\nOn .+ wrote:\n> x+\n> …$/);
  });

  it('reuses an owned sender when replying to a sent message', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue({
        ...original,
        from: { email: 'support@example.com' },
        to: [{ email: 'customer@example.com' }],
      }),
      createDraft,
    });

    await service.createDraft('acct_1', { replyToMessageId: original.id, body: { text: 'Follow up' } });

    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'support@example.com', to: [{ email: 'customer@example.com' }] }),
    );
  });

  it('ignores an owned address that appears only in Bcc', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue({
        ...original,
        to: [{ email: 'customer@example.com' }],
        cc: [],
        bcc: [{ email: 'sales@example.com' }],
      }),
      createDraft,
    });

    await service.createDraft('acct_1', { replyToMessageId: original.id, body: { text: 'Reply' } });

    expect(createDraft).toHaveBeenCalledWith(expect.not.objectContaining({ from: expect.anything() }));
  });

  it('removes every owned identity from reply-all recipients', async () => {
    const createDraft = vi.fn().mockResolvedValue({});
    const service = serviceWith({
      listSendAs: vi.fn().mockResolvedValue(identities),
      getMessage: vi.fn().mockResolvedValue({
        ...original,
        to: [{ email: 'sales@example.com' }, { email: 'customer@example.com' }],
        cc: [{ email: 'support@example.com' }, { email: 'other@example.com' }],
      }),
      createDraft,
    });

    await service.createDraft('acct_1', {
      replyToMessageId: original.id,
      replyAll: true,
      body: { text: 'Reply' },
    });

    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ name: 'Ann', email: 'ann@example.com' }, { email: 'customer@example.com' }],
        cc: [{ email: 'other@example.com' }],
      }),
    );
  });

  it('keeps ordinary new mail available when identity discovery fails', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 'thread_1' });
    const listSendAs = vi.fn().mockRejectedValue(new Error('discovery unavailable'));
    const service = serviceWith({ listSendAs, send });

    await service.send('acct_1', {
      to: [{ email: 'customer@example.com' }],
      body: { text: 'Hello' },
    });

    expect(send).toHaveBeenCalledWith(expect.not.objectContaining({ from: expect.anything() }));
    expect(listSendAs).not.toHaveBeenCalled();
  });

  it('surfaces identity discovery failures for replies', async () => {
    const service = serviceWith({
      listSendAs: vi.fn().mockRejectedValue(new Error('discovery unavailable')),
      getMessage: vi.fn().mockResolvedValue(original),
      createDraft: vi.fn(),
    });

    await expect(
      service.createDraft('acct_1', { replyToMessageId: original.id, body: { text: 'Reply' } }),
    ).rejects.toThrow('discovery unavailable');
  });

  it('rejects an alternate sender when a custom provider cannot discover identities', async () => {
    const service = serviceWith({ send: vi.fn() });

    await expect(
      service.send('acct_1', {
        from: 'unknown@example.com',
        to: [{ email: 'customer@example.com' }],
        body: { text: 'Hello' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('configured send-as storage', () => {
  it('replaces aliases and removes them with their account', () => {
    const db = testDb();
    replaceConfiguredSendAs(db, 'acct_1', [
      { email: 'sales@example.com', name: 'Sales' },
      { email: 'support@example.com' },
    ]);
    expect(listConfiguredSendAs(db, 'acct_1')).toHaveLength(2);

    replaceConfiguredSendAs(db, 'acct_1', [{ email: 'support@example.com' }]);
    expect(listConfiguredSendAs(db, 'acct_1').map((identity) => identity.email)).toEqual(['support@example.com']);

    db.delete(accounts).run();
    expect(db.select().from(accountSendAs).all()).toEqual([]);
  });
});

describe('EmailService account state', () => {
  it('does not call a provider for a disabled account', async () => {
    const getProvider = vi.fn();
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => ({
        id: 'acct_1',
        provider: 'gmail',
        email: 'me@example.com',
        status: 'disabled',
        capabilities: {},
      }),
      getProvider,
    };
    const service = new EmailService(registry as never, testDb());

    await expect(service.listFolders()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('EmailService member scope', () => {
  const shared = {
    id: 'acct_shared',
    provider: 'gmail',
    email: 'shared@example.com',
    status: 'active',
    capabilities: {},
    ownerMemberId: 'member_bob',
    sharedWithAll: true,
    grantedMemberIds: [],
  };
  const ann = {
    id: 'acct_ann',
    provider: 'gmail',
    email: 'ann@example.com',
    status: 'active',
    capabilities: {},
    ownerMemberId: 'member_ann',
    sharedWithAll: false,
    grantedMemberIds: [],
  };
  const bob = {
    id: 'acct_bob',
    provider: 'gmail',
    email: 'bob@example.com',
    status: 'active',
    capabilities: {},
    ownerMemberId: 'member_bob',
    sharedWithAll: false,
    grantedMemberIds: [],
  };
  const selected = {
    id: 'acct_selected',
    provider: 'gmail',
    email: 'selected@example.com',
    status: 'active',
    capabilities: {},
    ownerMemberId: 'member_bob',
    sharedWithAll: false,
    grantedMemberIds: ['member_ann'],
  };

  function apiPrincipal(
    memberId: string,
    role: 'admin' | 'member' = 'member',
    accountIds: string[] | null = null,
    permissions: PermissionPolicy = FULL_PERMISSION_POLICY,
  ) {
    return {
      kind: 'api_key' as const,
      issuerId: null,
      principalId: 'key_test',
      keyId: 'key_test',
      memberId,
      role,
      permissions,
      accountIds,
    };
  }

  function scopedRegistry(all: Array<Record<string, unknown>>, listFolders = vi.fn().mockResolvedValue([])) {
    const byId = new Map(all.map((a) => [a.id as string, a]));
    return {
      listFolders,
      registry: {
        listAccounts: () => all,
        getAccount: (id: string) => {
          const account = byId.get(id);
          if (!account) throw new EmailError('not_found', `No account with id "${id}"`);
          return account;
        },
        resolveAccountId: (id?: string) => {
          if (id) return byId.get(id)?.id;
          if (all.length === 1) return all[0]!.id;
          throw new EmailError('invalid_request', 'Multiple accounts are connected; specify accountId.');
        },
        getProvider: () => ({ listFolders, testConnection: vi.fn().mockResolvedValue(undefined) }),
        markStatus: vi.fn(),
      },
    };
  }

  it('lists only shared and owned mailboxes for a member key', () => {
    const { registry } = scopedRegistry([shared, ann, bob]);
    const service = new EmailService(registry as never, testDb()).withPrincipal(apiPrincipal('member_ann'));

    expect(service.listAccounts().map((a) => a.id)).toEqual(['acct_shared', 'acct_ann']);
  });

  it("reaches shared and owned mailboxes but hides another member's as not_found", async () => {
    const { registry, listFolders } = scopedRegistry([shared, ann, bob]);
    const service = new EmailService(registry as never, testDb()).withPrincipal(apiPrincipal('member_ann'));

    await expect(service.listFolders('acct_shared')).resolves.toEqual([]);
    await expect(service.listFolders('acct_ann')).resolves.toEqual([]);
    await expect(service.listFolders('acct_bob')).rejects.toMatchObject({
      code: 'not_found',
      message: 'No account with id "acct_bob"',
    });
    // The provider is never reached for the forbidden mailbox.
    expect(listFolders).toHaveBeenCalledTimes(2);
  });

  it('defaults a member key to its sole accessible mailbox', async () => {
    const { registry } = scopedRegistry([bob, ann]);
    const service = new EmailService(registry as never, testDb()).withPrincipal(apiPrincipal('member_ann'));

    await expect(service.listFolders()).resolves.toEqual([]);
  });

  it('requires an explicit accountId when a member can reach more than one mailbox', async () => {
    const { registry } = scopedRegistry([shared, ann]);
    const service = new EmailService(registry as never, testDb()).withPrincipal(apiPrincipal('member_ann'));

    await expect(service.listFolders()).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('keeps full access for the internal background service', () => {
    const { registry } = scopedRegistry([shared, ann, bob]);
    const service = new EmailService(registry as never, testDb());

    expect(service.listAccounts().map((a) => a.id)).toEqual(['acct_shared', 'acct_ann', 'acct_bob']);
  });

  it('grants selected sharing and intersects it with a connection allowlist', async () => {
    const { registry, listFolders } = scopedRegistry([ann, bob, selected]);
    const service = new EmailService(registry as never, testDb()).withPrincipal(
      apiPrincipal('member_ann', 'member', ['acct_selected']),
    );

    expect(service.listAccounts().map((account) => account.id)).toEqual(['acct_selected']);
    await expect(service.listFolders('acct_selected')).resolves.toEqual([]);
    await expect(service.listFolders('acct_ann')).rejects.toMatchObject({ code: 'not_found' });
    expect(listFolders).toHaveBeenCalledTimes(1);
  });

  it('lets admins view mailbox metadata without granting private mailbox content', async () => {
    const { registry, listFolders } = scopedRegistry([ann, bob]);
    const service = new EmailService(registry as never, testDb()).withPrincipal(
      apiPrincipal('member_ann', 'admin', null, permissionPolicyForProfile('full', ['admin.accounts'])),
    );

    expect(service.listAccounts().map((account) => account.id)).toEqual(['acct_ann', 'acct_bob']);
    await expect(service.listFolders('acct_bob')).rejects.toMatchObject({ code: 'not_found' });
    expect(listFolders).not.toHaveBeenCalled();
  });

  it('intersects admin metadata views with a connection allowlist', async () => {
    const { registry, listFolders } = scopedRegistry([ann, bob]);
    const service = new EmailService(registry as never, testDb()).withPrincipal(
      apiPrincipal('member_ann', 'admin', ['acct_bob'], permissionPolicyForProfile('full', ['admin.accounts'])),
    );

    expect(service.listAccounts().map((account) => account.id)).toEqual(['acct_bob']);
    const status = await service.status();
    expect(status.accounts.map((account) => account.id)).toEqual(['acct_bob']);
    await expect(service.listFolders('acct_bob')).rejects.toMatchObject({ code: 'not_found' });
    expect(listFolders).not.toHaveBeenCalled();
  });

  it('isolates scheduled sends between members', () => {
    const db = openDb(':memory:');
    db.insert(members)
      .values([
        { id: 'member_ann', name: 'Ann', email: null, createdAt: Date.now() },
        { id: 'member_bob', name: 'Bob', email: null, createdAt: Date.now() },
      ])
      .run();
    db.insert(accounts)
      .values([
        {
          id: 'acct_ann',
          provider: 'gmail',
          email: 'ann@example.com',
          status: 'active',
          createdAt: Date.now(),
          ownerMemberId: 'member_ann',
        },
        {
          id: 'acct_bob',
          provider: 'gmail',
          email: 'bob@example.com',
          status: 'active',
          createdAt: Date.now(),
          ownerMemberId: 'member_bob',
        },
      ])
      .run();
    const annSchedule = createScheduledSend(db, {
      accountId: 'acct_ann',
      draftId: 'draft_ann',
      sendAt: Date.now() + 3_600_000,
    });
    const bobSchedule = createScheduledSend(db, {
      accountId: 'acct_bob',
      draftId: 'draft_bob',
      sendAt: Date.now() + 3_600_000,
    });

    const { registry } = scopedRegistry([ann, bob]);
    const service = new EmailService(registry as never, db).withPrincipal(apiPrincipal('member_ann'));

    expect(service.listScheduled().map((s) => s.scheduleId)).toEqual([annSchedule.id]);
    expect(() => service.cancelScheduled(bobSchedule.id)).toThrow(/No scheduled send/);
    expect(() => service.cancelScheduled(annSchedule.id, 'acct_bob')).toThrow(/No account/);
    expect(service.cancelScheduled(annSchedule.id, 'acct_ann')).toMatchObject({ scheduleId: annSchedule.id });
    // An account that can be reached must still be the schedule's own.
    const internal = new EmailService(registry as never, db);
    expect(() => internal.cancelScheduled(bobSchedule.id, 'acct_ann')).toThrow(/No scheduled send/);
    expect(internal.cancelScheduled(bobSchedule.id, 'acct_bob')).toMatchObject({ scheduleId: bobSchedule.id });
  });

  it('keeps connections without mail.send from changing a scheduled draft', async () => {
    const db = openDb(':memory:');
    db.insert(members).values({ id: 'member_ann', name: 'Ann', email: null, createdAt: Date.now() }).run();
    db.insert(accounts)
      .values({
        id: 'acct_ann',
        provider: 'gmail',
        email: 'ann@example.com',
        status: 'active',
        createdAt: Date.now(),
        ownerMemberId: 'member_ann',
      })
      .run();
    const schedule = createScheduledSend(db, {
      accountId: 'acct_ann',
      draftId: 'draft_scheduled',
      sendAt: Date.now() + 3_600_000,
    });
    const updateDraft = vi.fn().mockResolvedValue({
      id: 'm1',
      draftId: 'draft_scheduled',
      subject: 'Rewritten',
      to: [{ email: 'bob@example.com' }],
    });
    const deleteDraft = vi.fn().mockResolvedValue(undefined);
    const { registry } = scopedRegistry([ann]);
    registry.getProvider = () => ({ updateDraft, deleteDraft, resolveAddress: vi.fn() }) as never;
    const draft = { to: ['bob@example.com'], subject: 'Rewritten', body: { text: 'Changed.' } };
    const readWrite = new EmailService(registry as never, db).withPrincipal(
      apiPrincipal('member_ann', 'member', null, permissionPolicyForProfile('read-write')),
    );

    await expect(readWrite.updateDraft('acct_ann', 'draft_scheduled', draft)).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringContaining('Cancel the scheduled send first'),
    });
    await expect(readWrite.deleteDraft('acct_ann', 'draft_scheduled')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    // An MCP connection reports its own permissions, which override the principal's.
    const internal = new EmailService(registry as never, db);
    await expect(internal.updateDraft('acct_ann', 'draft_scheduled', draft, { canSend: false })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(updateDraft).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();

    // Other drafts, and connections that can send, are unaffected.
    await readWrite.deleteDraft('acct_ann', 'draft_other');
    const full = new EmailService(registry as never, db).withPrincipal(apiPrincipal('member_ann'));
    await full.updateDraft('acct_ann', 'draft_scheduled', draft);
    expect(updateDraft).toHaveBeenCalledTimes(1);
    // The schedule shows what will now go out.
    expect(full.listScheduled('acct_ann')).toMatchObject([{ subject: 'Rewritten', to: 'bob@example.com' }]);

    // A send in progress can't be canceled, so the refusal doesn't suggest it.
    db.update(scheduledSends).set({ status: 'sending' }).where(eq(scheduledSends.id, schedule.id)).run();
    await expect(readWrite.deleteDraft('acct_ann', 'draft_scheduled')).rejects.toThrow(/being sent now/);
    db.update(scheduledSends).set({ status: 'pending' }).where(eq(scheduledSends.id, schedule.id)).run();

    // Once the send is canceled, the draft can change again.
    full.cancelScheduled(schedule.id);
    await readWrite.deleteDraft('acct_ann', 'draft_scheduled');
    expect(deleteDraft).toHaveBeenCalledTimes(2);
  });

  it('keeps instance-wide status details out of member responses', async () => {
    const db = openDb(':memory:');
    db.insert(members)
      .values([
        { id: 'member_ann', name: 'Ann', email: null, createdAt: Date.now() },
        { id: 'member_bob', name: 'Bob', email: null, createdAt: Date.now() },
      ])
      .run();
    db.insert(accounts)
      .values([
        {
          id: 'acct_ann',
          provider: 'gmail',
          email: 'ann@example.com',
          status: 'active',
          createdAt: Date.now(),
          ownerMemberId: 'member_ann',
        },
        {
          id: 'acct_bob',
          provider: 'gmail',
          email: 'bob@example.com',
          status: 'active',
          createdAt: Date.now(),
          ownerMemberId: 'member_bob',
        },
      ])
      .run();
    const annSendAt = Date.now() + 7_200_000;
    createScheduledSend(db, { accountId: 'acct_ann', draftId: 'draft_ann', sendAt: annSendAt });
    createScheduledSend(db, { accountId: 'acct_bob', draftId: 'draft_bob', sendAt: Date.now() + 3_600_000 });

    const { registry } = scopedRegistry([ann, bob]);
    const service = new EmailService(registry as never, db).withPrincipal(apiPrincipal('member_ann'));
    const status = await service.status();

    expect(status.accounts.map((account) => account.id)).toEqual(['acct_ann']);
    expect(status.scheduled).toEqual({ pending: 1, nextSendAt: new Date(annSendAt).toISOString() });
    expect(status).not.toHaveProperty('members');
    expect(status).not.toHaveProperty('entitlements');
    expect(status).not.toHaveProperty('licenseWarning');
  });

  it('keeps instance-wide status details out of administrator keys without matching capabilities', async () => {
    const db = openDb(':memory:');
    db.insert(members)
      .values([
        { id: 'member_ann', name: 'Ann', email: null, role: 'admin', createdAt: Date.now() },
        { id: 'member_bob', name: 'Bob', email: null, createdAt: Date.now() },
      ])
      .run();
    const { registry } = scopedRegistry([ann, bob]);
    const service = new EmailService(registry as never, db).withPrincipal(apiPrincipal('member_ann', 'admin'));

    const status = await service.status();

    expect(status.accounts.map((account) => account.id)).toEqual(['acct_ann']);
    expect(status).not.toHaveProperty('members');
    expect(status).not.toHaveProperty('entitlements');
    expect(status).not.toHaveProperty('licenseWarning');
  });

  it('does not expose instance usage in member quota errors', () => {
    const db = openDb(':memory:');
    db.insert(members)
      .values([
        { id: 'member_ann', name: 'Ann', email: null, createdAt: Date.now() },
        { id: 'member_bob', name: 'Bob', email: null, createdAt: Date.now() },
      ])
      .run();
    const { registry } = scopedRegistry([ann, bob]);
    const service = new EmailService(registry as never, db).withPrincipal(apiPrincipal('member_ann'));

    expect(() => service.enforceQuota()).toThrow(
      'This Fluxmail instance is over its plan limits. Ask an administrator to renew the license or reduce usage.',
    );
  });

  it('does not expose instance usage to administrator keys without admin.license', () => {
    const db = openDb(':memory:');
    db.insert(members)
      .values([
        { id: 'member_ann', name: 'Ann', email: null, role: 'admin', createdAt: Date.now() },
        { id: 'member_bob', name: 'Bob', email: null, createdAt: Date.now() },
      ])
      .run();
    const { registry } = scopedRegistry([ann, bob]);
    const service = new EmailService(registry as never, db).withPrincipal(apiPrincipal('member_ann', 'admin'));

    expect(() => service.enforceQuota()).toThrow(
      'This Fluxmail instance is over its plan limits. Ask an administrator to renew the license or reduce usage.',
    );
  });
});

describe('EmailService search pagination', () => {
  const supportedSearch: SearchCapabilities = {
    filters: ['folder', 'text', 'from', 'to', 'subject', 'read', 'starred', 'hasAttachment', 'after', 'before'],
    folderRoles: {
      inbox: 'available',
      sent: 'available',
      drafts: 'available',
      archive: 'available',
      spam: 'available',
      trash: 'available',
      all: 'available',
    },
    nativeQuery: { syntax: 'gmail', availability: 'available' },
  };

  it('normalizes queries and wraps provider cursors in a signed server token', async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextPageToken: 'provider-page-2', exhausted: false })
      .mockResolvedValueOnce({ items: [], exhausted: true });
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const registry = {
      resolveAccountId: () => account.id,
      getAccount: () => account,
      getProvider: () => ({ capabilities: { search: supportedSearch }, listMessages }),
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb(), undefined, Buffer.alloc(32, 4));

    const first = await service.listMessages(account.id, { text: '  quarterly   report ' }, { pageSize: 10 });
    expect(first.nextPageToken).toMatch(/^[^.]+\.[^.]+$/);
    expect(first.nextPageToken).not.toContain('provider-page-2');
    expect(listMessages).toHaveBeenNthCalledWith(
      1,
      { text: 'quarterly report' },
      expect.objectContaining({ pageSize: 10 }),
    );

    await service.listMessages(
      account.id,
      { text: 'quarterly report' },
      {
        pageSize: 10,
        pageToken: first.nextPageToken,
      },
    );
    expect(listMessages).toHaveBeenNthCalledWith(
      2,
      { text: 'quarterly report' },
      expect.objectContaining({ pageSize: 10, pageToken: 'provider-page-2' }),
    );

    const tampered = await service
      .listMessages(account.id, { text: 'quarterly report' }, { pageSize: 10, pageToken: `${first.nextPageToken}x` })
      .catch((error: unknown) => error);
    expect(tampered).toBeInstanceOf(ClientInputError);
    expect(publicError(tampered, 'request_1')).toMatchObject({
      code: 'invalid_request',
      message: 'Invalid or expired search page token.',
    });
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it('reports invalid list filters before opening the mailbox', async () => {
    const getProvider = vi.fn();
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => ({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active' }),
      getProvider,
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb());

    await expect(service.listMessages('acct_1', { after: '2026-10-24', before: '2026-10-24' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'after must be earlier than before.',
    });
    await expect(
      service.listMessages('acct_1', { from: 'bob@example.org' }, { includeSearchContext: true }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'includeSearchContext requires a portable text query.',
    });
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('validates search-context text and provider capability before provider work', async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [], exhausted: true });
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const registry = {
      resolveAccountId: () => account.id,
      getAccount: () => account,
      getProvider: () => ({ capabilities: { search: supportedSearch }, listMessages }),
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb());

    await expect(
      service.listMessages(account.id, { subject: 'invoice' }, { includeSearchContext: true }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      service.listMessages(account.id, { rawProviderQuery: 'invoice' }, { includeSearchContext: true }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      service.listMessages(account.id, { text: 'invoice' }, { includeSearchContext: true }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('forwards search context and binds it into signed continuation tokens', async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextPageToken: 'provider-page-2', exhausted: false })
      .mockResolvedValueOnce({ items: [], exhausted: true });
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const registry = {
      resolveAccountId: () => account.id,
      getAccount: () => account,
      getProvider: () => ({ capabilities: { search: supportedSearch, searchContext: true }, listMessages }),
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb(), undefined, Buffer.alloc(32, 4));

    const first = await service.listMessages(
      account.id,
      { text: '  invoice   [ORDER_ID] ' },
      { includeSearchContext: true },
    );
    expect(listMessages).toHaveBeenCalledWith(
      { text: 'invoice [ORDER_ID]' },
      expect.objectContaining({ includeSearchContext: true }),
    );
    await expect(
      service.listMessages(account.id, { text: 'invoice [ORDER_ID]' }, { pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    await service.listMessages(
      account.id,
      { text: 'invoice [ORDER_ID]' },
      { pageToken: first.nextPageToken, includeSearchContext: true },
    );
    expect(listMessages).toHaveBeenLastCalledWith(
      { text: 'invoice [ORDER_ID]' },
      expect.objectContaining({ pageToken: 'provider-page-2', includeSearchContext: true }),
    );
  });

  it('rejects continuation requests with a changed query or page size', async () => {
    const provider = {
      capabilities: { search: supportedSearch },
      listMessages: vi.fn().mockResolvedValue({ items: [], nextPageToken: 'provider-page-2' }),
    };
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const registry = {
      resolveAccountId: () => account.id,
      getAccount: () => account,
      getProvider: () => provider,
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb(), undefined, Buffer.alloc(32, 4));
    const first = await service.listMessages(account.id, { read: false }, { pageSize: 10 });

    await expect(
      service.listMessages(account.id, { read: true }, { pageSize: 10, pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      service.listMessages(account.id, { read: false }, { pageSize: 20, pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects search options that the provider marks as unsupported', async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [] });
    const search: SearchCapabilities = {
      ...supportedSearch,
      filters: ['folder', 'text'],
      folderRoles: { ...supportedSearch.folderRoles, archive: 'unavailable' },
      nativeQuery: null,
    };
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const registry = {
      resolveAccountId: () => account.id,
      getAccount: () => account,
      getProvider: () => ({ capabilities: { search }, listMessages }),
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb());

    await expect(
      service.listMessages(account.id, {
        folder: 'archive',
        from: 'ann@example.com',
        rawProviderQuery: 'from:ann@example.com',
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_capability',
      data: {
        unsupportedSearchOptions: ['folder:archive', 'from', 'rawProviderQuery'],
      },
    });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('checks custom folders against folder-filter support', async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [] });
    const search: SearchCapabilities = {
      ...supportedSearch,
      filters: ['text'],
    };
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const registry = {
      resolveAccountId: () => account.id,
      getAccount: () => account,
      getProvider: () => ({ capabilities: { search }, listMessages }),
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb());

    await expect(service.listMessages(account.id, { folder: 'Projects/2026' })).rejects.toMatchObject({
      code: 'unsupported_capability',
      data: { unsupportedSearchOptions: ['folder'] },
    });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('allows unknown folder and native-query capabilities to resolve in the provider', async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [] });
    const search: SearchCapabilities = {
      ...supportedSearch,
      folderRoles: { ...supportedSearch.folderRoles, archive: 'unknown' },
      nativeQuery: { syntax: 'gmail', availability: 'unknown' },
    };
    const account = {
      id: 'acct_1',
      provider: 'imap' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const registry = {
      resolveAccountId: () => account.id,
      getAccount: () => account,
      getProvider: () => ({ capabilities: { search }, listMessages }),
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb());

    await service.listMessages(account.id, { folder: 'archive' });
    await service.listMessages(account.id, { folder: 'Projects/2026' });
    await service.listMessages(account.id, { rawProviderQuery: 'has:attachment' });

    expect(listMessages).toHaveBeenCalledTimes(3);
  });

  it('keeps successful batch groups when another account fails', async () => {
    const accounts = ['acct_1', 'acct_2', 'acct_3'].map((id) => ({
      id,
      provider: 'gmail' as const,
      email: `${id}@example.com`,
      status: 'active' as const,
    }));
    const providers = new Map(
      accounts.map((account, index) => [
        account.id,
        {
          capabilities: { search: supportedSearch },
          listMessages: vi.fn(async () => {
            if (index === 1) throw new EmailError('provider_unavailable', 'temporary provider failure');
            return { items: [], exhausted: index === 0, ...(index === 2 ? { nextPageToken: 'next' } : {}) };
          }),
        },
      ]),
    );
    const registry = {
      getAccount: (id: string) => accounts.find((account) => account.id === id)!,
      getProvider: (id: string) => providers.get(id)!,
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, testDb(), undefined, Buffer.alloc(32, 7));

    const result = await service.searchMessagesBatch({
      accounts: accounts.map((account) => ({ accountId: account.id })),
      query: { subject: 'quarterly report' },
      includeSnippet: true,
    });

    expect(result.groups.map((group) => group.accountId)).toEqual(accounts.map((account) => account.id));
    expect(result.groups[0]?.page?.exhausted).toBe(true);
    expect(result.groups[1]?.error).toMatchObject({ code: 'provider_unavailable', exhausted: false });
    expect(result.groups[2]?.page?.exhausted).toBe(false);
    expect(result.exhausted).toBe(false);

    const continued = await service.searchMessagesBatch({
      accounts: [{ accountId: 'acct_3', pageToken: result.groups[2]!.page!.nextPageToken! }],
      query: { subject: 'quarterly report' },
      includeSnippet: true,
    });
    expect(continued.groups).toHaveLength(1);
    expect(providers.get('acct_3')?.listMessages).toHaveBeenLastCalledWith(
      { subject: 'quarterly report' },
      expect.objectContaining({ pageToken: 'next', includeSnippet: true }),
    );
  });

  it('keeps successful batch groups when another account is unavailable', async () => {
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const listMessages = vi.fn(async () => ({ items: [], exhausted: true }));
    const service = new EmailService(
      {
        getAccount: (id: string) => {
          if (id !== account.id) throw new EmailError('not_found', `No account with id "${id}"`);
          return account;
        },
        getProvider: () => ({ capabilities: { search: supportedSearch }, listMessages }),
        markStatus: vi.fn(),
      } as never,
      testDb(),
    );

    const result = await service.searchMessagesBatch({
      accounts: [{ accountId: account.id }, { accountId: 'acct_missing' }],
      query: { text: 'invoice' },
    });

    expect(result.groups[0]?.page).toMatchObject({ exhausted: true, items: [] });
    expect(result.groups[1]?.error).toMatchObject({ code: 'not_found', exhausted: false });
    expect(listMessages).toHaveBeenCalledOnce();
  });

  it('rejects duplicate batch accounts before calling a provider', async () => {
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const listMessages = vi.fn();
    const service = new EmailService(
      {
        getAccount: () => account,
        getProvider: () => ({ capabilities: { search: supportedSearch }, listMessages }),
        markStatus: vi.fn(),
      } as never,
      testDb(),
    );

    await expect(
      service.searchMessagesBatch({
        accounts: [{ accountId: account.id }, { accountId: account.id }],
        query: { text: 'invoice' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('searches nine accounts with at most three provider calls active', async () => {
    const accounts = Array.from({ length: 9 }, (_, index) => ({
      id: `acct_${index + 1}`,
      provider: 'gmail' as const,
      email: `person${index + 1}@example.com`,
      status: 'active' as const,
    }));
    let active = 0;
    let maxActive = 0;
    const providers = new Map(
      accounts.map((account) => [
        account.id,
        {
          capabilities: { search: supportedSearch },
          listMessages: vi.fn(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return { items: [], exhausted: true };
          }),
        },
      ]),
    );
    const service = new EmailService(
      {
        getAccount: (id: string) => accounts.find((account) => account.id === id)!,
        getProvider: (id: string) => providers.get(id)!,
        markStatus: vi.fn(),
      } as never,
      testDb(),
    );

    const result = await service.searchMessagesBatch({
      accounts: accounts.map((account) => ({ accountId: account.id })),
      query: { text: 'invoice' },
    });

    expect(result.groups.map((group) => group.accountId)).toEqual(accounts.map((account) => account.id));
    expect(result.exhausted).toBe(true);
    expect(maxActive).toBe(3);
  });

  it('gives a search page 15 seconds before it returns what it has', async () => {
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const listMessages = vi.fn(async () => ({ items: [], exhausted: true }));
    const service = new EmailService(
      {
        getAccount: () => account,
        getProvider: () => ({ capabilities: { search: supportedSearch }, listMessages }),
        markStatus: vi.fn(),
      } as never,
      testDb(),
    );
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    try {
      await service.listMessages(account.id, { text: 'invoice' });
    } finally {
      now.mockRestore();
    }

    expect(listMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ softDeadlineAt: 1_015_000 }),
    );
  });

  it('returns a machine-readable timeout when a provider never reaches a checkpoint', async () => {
    vi.useFakeTimers();
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: 'active' as const,
    };
    const service = new EmailService(
      {
        getAccount: () => account,
        getProvider: () => ({
          capabilities: { search: supportedSearch },
          listMessages: vi.fn(() => new Promise(() => {})),
        }),
        markStatus: vi.fn(),
      } as never,
      testDb(),
    );

    try {
      const search = service.listMessages(account.id, { text: 'private search' });
      let settled = false;
      void search.then(
        () => (settled = true),
        () => (settled = true),
      );
      const expected = expect(search).rejects.toMatchObject({
        code: 'provider_unavailable',
        data: { reason: 'search_timeout', exhausted: false },
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EmailService.status', () => {
  function statusService(
    initialStatus: 'active' | 'auth_error',
    testConnection: () => Promise<void>,
    getFolderWarnings?: () => Promise<Array<{ message: string }>>,
  ) {
    const account = {
      id: 'acct_1',
      provider: 'gmail' as const,
      email: 'me@example.com',
      status: initialStatus,
      capabilities: {
        labels: true,
        serverThreads: true,
        serverSearch: 'rich' as const,
        snippets: true,
      },
    };
    const markStatus = vi.fn((_id: string, status: 'active' | 'auth_error' | 'disabled') => {
      account.status = status as typeof initialStatus;
    });
    const registry = {
      listAccounts: () => [account],
      getProvider: () => ({ testConnection, ...(getFolderWarnings ? { getFolderWarnings } : {}) }),
      markStatus,
    };
    return { service: new EmailService(registry as never, testDb()), markStatus };
  }

  it('marks an account when a live connection check finds expired authorization', async () => {
    const { service, markStatus } = statusService('active', async () => {
      throw new EmailError('auth_expired', 'expired');
    });

    await expect(service.status()).resolves.toMatchObject({
      accounts: [{ id: 'acct_1', status: 'auth_error' }],
    });
    expect(markStatus).toHaveBeenCalledWith('acct_1', 'auth_error');
  });

  it('restores an account after a successful live connection check', async () => {
    const { service, markStatus } = statusService('auth_error', async () => {});

    await expect(service.status()).resolves.toMatchObject({
      accounts: [{ id: 'acct_1', status: 'active' }],
    });
    expect(markStatus).toHaveBeenCalledWith('acct_1', 'active');
  });

  it('keeps the stored state when a provider check fails for another reason', async () => {
    const { service, markStatus } = statusService('active', async () => {
      throw new EmailError('provider_unavailable', 'temporary failure');
    });

    await expect(service.status()).resolves.toMatchObject({
      accounts: [
        {
          id: 'acct_1',
          status: 'active',
          error: { code: 'provider_unavailable', message: 'temporary failure' },
        },
      ],
    });
    expect(markStatus).not.toHaveBeenCalled();
  });

  it('includes non-fatal folder warnings for a connected account', async () => {
    const { service } = statusService(
      'active',
      async () => {},
      async () => [{ message: 'no trash folder could be resolved' }],
    );

    await expect(service.status()).resolves.toMatchObject({
      accounts: [{ id: 'acct_1', status: 'active', warnings: ['no trash folder could be resolved'] }],
      providersAvailable: ['gmail', 'outlook', 'imap'],
    });
  });
});

describe('resolveSendAt', () => {
  const now = Date.parse('2026-07-10T12:00:00.000Z');

  it('accepts a future ISO timestamp with offset', () => {
    expect(resolveSendAt('2026-07-11T09:00:00-07:00', now)).toBe(Date.parse('2026-07-11T16:00:00Z'));
  });

  it('accepts a timestamp within the past-grace window', () => {
    expect(resolveSendAt('2026-07-10T11:59:30.000Z', now)).toBe(now - 30_000);
  });

  it('rejects a past timestamp', () => {
    expect(() => resolveSendAt('2026-07-10T11:00:00.000Z', now)).toThrow(/in the past/);
  });

  it('rejects a timestamp more than a year away', () => {
    expect(() => resolveSendAt('2027-08-01T00:00:00.000Z', now)).toThrow(/more than a year/);
  });

  it('rejects garbage', () => {
    expect(() => resolveSendAt('tomorrow at 9', now)).toThrow(/Could not parse/);
  });
});

describe('EmailService scheduling', () => {
  const soon = new Date(Date.now() + 3_600_000).toISOString();

  function schedulingService(provider: Record<string, unknown>) {
    const db = testDb();
    const account = {
      id: 'acct_1',
      provider: 'gmail',
      email: 'me@example.com',
      status: 'active',
      capabilities: {},
      ownerMemberId: 'member_1',
      sharedWithAll: false,
      grantedMemberIds: [],
    };
    const registry = {
      resolveAccountId: () => 'acct_1',
      getAccount: () => account,
      listAccounts: () => [account],
      getProvider: () => provider,
      markStatus: vi.fn(),
    };
    const service = new EmailService(registry as never, db);
    const onScheduleChanged = vi.fn();
    service.onScheduleChanged = onScheduleChanged;
    return { service, db, onScheduleChanged };
  }

  const draftMessage: Message = {
    ...original,
    from: { email: 'me@example.com' },
    draftId: 'draft_1',
    to: [{ email: 'bob@example.com' }],
    subject: 'Later',
    flags: { read: true, starred: false, draft: true },
  };

  it('schedules new content by creating a draft and storing a schedule row', async () => {
    const createDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service, onScheduleChanged } = schedulingService({ createDraft });

    const info = await service.scheduleSend(
      undefined,
      { to: [{ email: 'bob@example.com' }], subject: 'Later', body: { text: 'hi' } },
      soon,
    );

    expect(createDraft).toHaveBeenCalled();
    expect(info).toMatchObject({
      draftId: 'draft_1',
      accountId: 'acct_1',
      status: 'pending',
      subject: 'Later',
      to: 'bob@example.com',
      sendAt: new Date(soon).toISOString(),
    });
    expect(info.scheduleId).toMatch(/^sch_/);
    expect(onScheduleChanged).toHaveBeenCalled();
    expect(service.listScheduled()).toHaveLength(1);
  });

  it('schedules a forward by saving it as a draft with the original attachments and Bcc recipients', async () => {
    const withAttachment: Message = {
      ...original,
      attachments: [{ id: 'att_1', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 3 }],
    };
    const createDraft = vi.fn().mockResolvedValue({ ...draftMessage, subject: 'Fwd: Report' });
    const send = vi.fn();
    const { service, onScheduleChanged } = schedulingService({
      getMessage: vi.fn().mockResolvedValue(withAttachment),
      getAttachment: vi.fn().mockResolvedValue({ content: Buffer.from('pdf') }),
      createDraft,
      send,
    });
    const scoped = service.withPrincipal({
      kind: 'api_key',
      issuerId: null,
      principalId: 'key_1',
      keyId: 'key_1',
      memberId: 'member_1',
      role: 'member',
      permissions: FULL_PERMISSION_POLICY,
      accountIds: null,
    });
    const forward = {
      messageId: 'm1',
      to: [{ email: 'bob@example.com' }],
      bcc: [{ email: 'audit@example.com' }],
      comment: 'See below.',
    };

    const operation = await scoped.scheduleDelivery(undefined, { forward }, soon, 'forward-later');

    expect(operation).toMatchObject({ status: 'queued', scheduleId: expect.stringMatching(/^sch_/) });
    expect(send).not.toHaveBeenCalled();
    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ email: 'bob@example.com' }],
        bcc: [{ email: 'audit@example.com' }],
        subject: 'Fwd: Report',
        attachments: [
          expect.objectContaining({ filename: 'report.pdf', content: Buffer.from('pdf').toString('base64') }),
        ],
      }),
    );
    expect(createDraft.mock.calls[0]![0].body.text).toContain('See below.');
    expect(onScheduleChanged).toHaveBeenCalled();
    // The same key and arguments return the saved schedule instead of creating another.
    await expect(scoped.scheduleDelivery(undefined, { forward }, soon, 'forward-later')).resolves.toMatchObject({
      scheduleId: operation.scheduleId,
    });
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it('sends a forward to Bcc recipients', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 't1' });
    const { service } = schedulingService({ getMessage: vi.fn().mockResolvedValue(original), send });
    await service.forward(undefined, {
      messageId: 'm1',
      to: [{ email: 'bob@example.com' }],
      bcc: [{ email: 'audit@example.com' }],
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ bcc: [{ email: 'audit@example.com' }] }));
  });

  it('marks the original only after the delivery is recorded, including for a saved reply draft', async () => {
    const recorded: unknown[] = [];
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 't1' });
    const findRepliedMessage = vi.fn().mockResolvedValueOnce('m_original').mockRejectedValueOnce(new Error('lookup'));
    const { service, db } = schedulingService({
      getDraft: vi.fn().mockResolvedValue(draftMessage),
      send,
      findRepliedMessage,
      markReplied: vi.fn(async () => {
        recorded.push(
          db
            .select()
            .from(deliveryOperations)
            .all()
            .map((row) => row.status),
        );
      }),
    });
    const scoped = service.withPrincipal({
      kind: 'api_key',
      issuerId: null,
      principalId: 'key_1',
      keyId: 'key_1',
      memberId: 'member_1',
      role: 'member',
      permissions: FULL_PERMISSION_POLICY,
      accountIds: null,
    });

    await expect(scoped.deliver('acct_1', { draftId: 'draft_1' }, 'reply-draft')).resolves.toMatchObject({
      status: 'succeeded',
    });
    // A failed lookup still sends the draft.
    await expect(scoped.deliver('acct_1', { draftId: 'draft_1' }, 'reply-draft-2')).resolves.toMatchObject({
      status: 'succeeded',
    });

    expect(recorded).toEqual([['succeeded']]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('links an immediately due schedule before waking the scheduler', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service, db } = schedulingService({ getDraft });
    const scoped = service.withPrincipal({
      kind: 'api_key',
      issuerId: null,
      principalId: 'key_1',
      keyId: 'key_1',
      memberId: 'member_1',
      role: 'member',
      permissions: FULL_PERMISSION_POLICY,
      accountIds: null,
    });
    const coordinator = new DeliveryCoordinator(db);
    const wake = vi.fn(() => {
      const schedule = listScheduledSends(db)[0]!;
      if (!coordinator.findScheduled(schedule.accountId, schedule.id)) {
        coordinator.queueScheduled(schedule.accountId, schedule.id, schedule.draftId);
      }
    });
    service.onScheduleChanged = wake;

    const operation = await scoped.scheduleDelivery(
      'acct_1',
      { draftId: 'draft_1' },
      new Date(Date.now() - 1_000).toISOString(),
      'due-now',
    );

    expect(operation).toMatchObject({ status: 'queued', scheduleId: expect.stringMatching(/^sch_/) });
    expect(coordinator.findScheduled('acct_1', operation.scheduleId!)).toMatchObject({
      operationId: operation.operationId,
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('rejects recipientless content before creating a draft', async () => {
    const createDraft = vi.fn();
    const { service } = schedulingService({ createDraft });

    await expect(
      service.scheduleSend(undefined, { subject: 'Nobody', body: { text: 'hi' } }, soon),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(createDraft).not.toHaveBeenCalled();
    expect(service.listScheduled()).toHaveLength(0);
  });

  it('accepts a reply after deriving its recipient', async () => {
    const getMessage = vi.fn().mockResolvedValue(original);
    const createDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service } = schedulingService({ getMessage, createDraft });

    await service.scheduleSend(
      undefined,
      { replyToMessageId: original.id, subject: 'Re: Hello', body: { text: 'hi' } },
      soon,
    );

    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ to: [{ email: 'ann@example.com', name: 'Ann' }] }),
    );
  });

  it('schedules an existing draft after verifying it exists', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service } = schedulingService({ getDraft });

    const info = await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);

    expect(getDraft).toHaveBeenCalledWith('draft_1');
    expect(info.draftId).toBe('draft_1');
  });

  it('rejects scheduling a missing draft', async () => {
    const getDraft = vi.fn().mockRejectedValue(new EmailError('not_found', 'no such draft'));
    const { service } = schedulingService({ getDraft });

    await expect(service.scheduleSend(undefined, { draftId: 'nope' }, soon)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(service.listScheduled()).toHaveLength(0);
  });

  it('rejects a second pending schedule for the same draft', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service } = schedulingService({ getDraft });

    await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);
    await expect(service.scheduleSend(undefined, { draftId: 'draft_1' }, soon)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('marks the schedule sent when the draft is sent manually', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 'thread_1' });
    const { service, onScheduleChanged } = schedulingService({ getDraft, send });

    const info = await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);
    onScheduleChanged.mockClear();
    await service.send(undefined, { draftId: 'draft_1' });

    const [row] = service.listScheduled();
    expect(row).toMatchObject({ scheduleId: info.scheduleId, status: 'sent', sentMessageId: 'sent_1' });
    expect(onScheduleChanged).toHaveBeenCalled();
  });

  it('rejects a scheduled draft when its alternate sender is no longer available', async () => {
    const getDraft = vi.fn().mockResolvedValue({ ...draftMessage, from: { email: 'removed@example.com' } });
    const send = vi.fn();
    const { service } = schedulingService({ getDraft, send });

    await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);
    await expect(service.send(undefined, { draftId: 'draft_1' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels a pending schedule and keeps the draft', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const deleteDraft = vi.fn();
    const { service } = schedulingService({ getDraft, deleteDraft });

    const info = await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);
    const result = service.cancelScheduled(info.scheduleId);

    expect(result).toEqual({ scheduleId: info.scheduleId, draftId: 'draft_1', draftKept: true });
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(service.listScheduled()[0]).toMatchObject({ status: 'canceled' });
    expect(() => service.cancelScheduled(info.scheduleId)).toThrow(/already canceled/);
    expect(() => service.cancelScheduled('sch_missing')).toThrow(/No scheduled send/);
  });

  it('reports pending schedules in status()', async () => {
    const getDraft = vi.fn().mockResolvedValue(draftMessage);
    const { service } = schedulingService({ getDraft, testConnection: vi.fn() });

    await service.scheduleSend(undefined, { draftId: 'draft_1' }, soon);

    await expect(service.status()).resolves.toMatchObject({
      scheduled: { pending: 1, nextSendAt: new Date(soon).toISOString() },
    });
  });
});
