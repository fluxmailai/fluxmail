import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ImapFlow, ListResponse } from 'imapflow';
import type { Transporter } from 'nodemailer';
import { ImapProvider, smtpTransportOptions } from '../src/imapProvider.js';
import type { ImapMessageLocation, ImapStateStore } from '../src/types.js';

function folder(path: string): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path,
    delimiter: '/',
    parent: [],
    parentPath: '',
    flags: new Set(),
    listed: true,
    subscribed: true,
  };
}

class MemoryStore implements ImapStateStore {
  rows = new Map<string, ImapMessageLocation>();
  async findById(id: string) {
    return this.rows.get(id);
  }
  async findByLocation(path: string, uidValidity: string, uid: number) {
    return [...this.rows.values()].find(
      (row) => row.mailboxPath === path && row.uidValidity === uidValidity && row.uid === uid,
    );
  }
  async findByDraftId(draftId: string) {
    return [...this.rows.values()].find((row) => row.draftId === draftId);
  }
  async listByThreadId(threadId: string) {
    return [...this.rows.values()].filter((row) => row.threadId === threadId);
  }
  async save(row: ImapMessageLocation) {
    this.rows.set(row.id, row);
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async invalidateMailbox() {}
}

function attachmentProvider(size: number, chunks: Buffer[], encoding = 'binary') {
  const store = new MemoryStore();
  store.rows.set('m1', {
    id: 'm1',
    accountId: 'a1',
    mailboxPath: 'INBOX',
    uidValidity: '1',
    uid: 7,
    threadId: 't1',
  });
  const download = vi.fn().mockResolvedValue({
    meta: {},
    content: Readable.from(chunks),
  });
  const fake = {
    usable: true,
    mailbox: { uidValidity: 1n },
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    noop: vi.fn(),
    fetchOne: vi.fn().mockResolvedValue({
      bodyStructure: {
        part: '1',
        type: 'application/octet-stream',
        encoding,
        size,
        disposition: 'attachment',
        dispositionParameters: { filename: 'large.bin' },
      },
    }),
    download,
  };
  const provider = new ImapProvider({
    accountId: 'a1',
    email: 'me@example.com',
    credentials: {
      imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
      saveSent: true,
    },
    store,
    imapFactory: () => fake as unknown as ImapFlow,
  });
  return { provider, download };
}

describe('ImapProvider attachment limits', () => {
  it('rejects oversized body-structure metadata before downloading', async () => {
    const { provider, download } = attachmentProvider(11, []);

    await expect(provider.getAttachment('m1', '1', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 11, maxBytes: 10 },
    });
    expect(download).not.toHaveBeenCalled();
  });

  it('does not compare transfer-encoded metadata with the decoded limit', async () => {
    const { provider, download } = attachmentProvider(11, [Buffer.alloc(8)], 'base64');

    await expect(provider.getAttachment('m1', '1', { maxBytes: 10 })).resolves.toMatchObject({
      meta: { id: 'part:1' },
      content: Buffer.alloc(8),
    });
    expect(download).toHaveBeenCalledWith(7, '1', { uid: true });
  });

  it('accepts the canonical part prefix for downloads', async () => {
    const { provider, download } = attachmentProvider(4, [Buffer.from('data')]);

    await expect(provider.getAttachment('m1', 'part:1')).resolves.toMatchObject({
      meta: { id: 'part:1' },
      content: Buffer.from('data'),
    });
    expect(download).toHaveBeenCalledWith(7, '1', { uid: true });
  });

  it('stops a streamed download after it crosses the limit', async () => {
    const { provider } = attachmentProvider(0, [Buffer.alloc(6), Buffer.alloc(6)]);

    await expect(provider.getAttachment('m1', '1', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 12, maxBytes: 10 },
    });
  });

  it('reports an attachment the server returns no content for', async () => {
    const { provider, download } = attachmentProvider(4, []);
    // ImapFlow resolves {} when the message is gone or the part is empty.
    download.mockResolvedValue({});

    await expect(provider.getAttachment('m1', '1')).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'The IMAP server returned no content for message part 1',
      failure: { provider: 'imap', phase: 'fetch', reason: 'invalid_response' },
    });
  });
});

describe('ImapProvider message content that disappears mid-read', () => {
  type Download = 'replaced' | 'expunging' | 'refused' | 'broken' | 'empty' | 'closed' | 'content';
  /**
   * A draft at UID 9. A "replaced" download, or a "flags-only" fetch, acts like
   * another mail app saving the draft again while Fluxmail reads it: the copy
   * Fluxmail fetched is gone and the next UID holds the same message.
   */
  const setup = ({
    downloads = [],
    fetches = [],
    attachment = false,
  }: {
    downloads?: Download[];
    /** What the server answers to fetches of the message, in order, before answering normally. */
    fetches?: Array<'flags-only'>;
    /** Whether the message is a single attachment rather than text. */
    attachment?: boolean;
  }) => {
    const store = new MemoryStore();
    store.rows.set('m2', {
      id: 'm2',
      accountId: 'a1',
      mailboxPath: 'Drafts',
      uidValidity: '1',
      uid: 9,
      messageId: '<draft@example.com>',
      threadId: 't1',
      draftId: 'draft-1',
    });
    let serverUid = 9;
    const appended = new Set<number>();
    const live = (uid: number) => uid === serverUid || appended.has(uid);
    const download = vi.fn(async (uid: number) => {
      const next = downloads.shift() ?? 'content';
      if (next === 'replaced' || next === 'expunging' || next === 'refused') serverUid += 1;
      // What a server answers when another session expunges the message during the fetch.
      if (next === 'refused')
        throw Object.assign(new Error('Command failed'), {
          responseStatus: 'NO',
          responseText: '[EXPUNGEISSUED] Some messages were expunged',
        });
      if (next === 'closed') fake.mailbox = false;
      // What ImapFlow throws when the reply for a message being expunged has no body structure.
      if (next === 'expunging' || next === 'broken')
        throw new TypeError("Cannot read properties of undefined (reading 'childNodes')");
      if (next !== 'content') return {};
      return { meta: {}, content: Readable.from([Buffer.from(`Body at ${uid}`)]) };
    });
    const drafts = folder('Drafts');
    drafts.specialUse = '\\Drafts';
    const fake = {
      usable: true,
      mailbox: { path: 'Drafts', uidValidity: 1n } as false | { path: string; uidValidity: bigint },
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), drafts]),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { path: 'Drafts', uidValidity: 1n };
        return { release: vi.fn() };
      }),
      noop: vi.fn(),
      search: vi.fn(async () => [serverUid]),
      fetchOne: vi.fn(async (uid: number, query: { envelope?: boolean; flags?: boolean }) => {
        if (!live(uid)) return false;
        if (!query.envelope && query.flags) return { uid, flags: new Set(['\\Draft']) };
        if (fetches.shift() === 'flags-only') {
          serverUid += 1;
          return { uid, flags: new Set(['\\Draft', '\\Deleted']) };
        }
        return {
          uid,
          envelope: { subject: 'Draft', from: [{ name: 'Me', address: 'alias@example.com' }] },
          headers: Buffer.from('Message-ID: <draft@example.com>\r\n'),
          flags: new Set(['\\Draft']),
          bodyStructure: attachment
            ? {
                type: 'application/pdf',
                disposition: 'attachment',
                dispositionParameters: { filename: 'notes.pdf' },
                size: 9,
              }
            : { type: 'text/plain' },
        };
      }),
      append: vi.fn(async () => {
        appended.add(20);
        return { uid: 20, uidValidity: 1n };
      }),
      messageDelete: vi.fn(async (range: string) => {
        for (const uid of range.split(',').map(Number)) {
          if (uid === serverUid) serverUid = 0;
          appended.delete(uid);
        }
        return true;
      }),
      download,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
      resolveSender: (email) => ({ email }),
    });
    return { store, provider, download, fake };
  };

  it('reads the copy another mail app saved while the draft was being read', async () => {
    const { store, provider } = setup({ downloads: ['replaced', 'expunging', 'content'] });

    await expect(provider.getDraft('draft-1')).resolves.toMatchObject({
      id: 'm2',
      draftId: 'draft-1',
      body: { text: 'Body at 11' },
    });
    expect(await store.findById('m2')).toMatchObject({ uid: 11, draftId: 'draft-1' });
  });

  it('reads the new copy when the server refuses a download of an expunged message', async () => {
    const { provider } = setup({ downloads: ['refused', 'content'] });

    await expect(provider.getDraft('draft-1')).resolves.toMatchObject({ body: { text: 'Body at 10' } });
  });

  it('keeps a refused download of a message that is still there', async () => {
    const { provider, download } = setup({ downloads: ['broken'] });
    download.mockRejectedValueOnce(
      Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'Server busy' }),
    );

    await expect(provider.getMessage('m2')).rejects.toMatchObject({ failure: { reason: 'server_no' } });
    expect(download).toHaveBeenCalledOnce();
  });

  it('reads the new copy when the fetch reply has only flags', async () => {
    const { store, provider } = setup({ fetches: ['flags-only'] });

    await expect(provider.getDraft('draft-1')).resolves.toMatchObject({
      from: { email: 'alias@example.com' },
      body: { text: 'Body at 10' },
    });
    expect(await store.findById('m2')).toMatchObject({ uid: 10 });
  });

  it('stops retrying a message that keeps changing', async () => {
    const { provider, download } = setup({ downloads: ['replaced', 'replaced', 'replaced'] });

    await expect(provider.getDraft('draft-1')).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'The message changed on the IMAP server while it was being read',
      failure: { provider: 'imap', phase: 'fetch', reason: 'invalid_response' },
    });
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('reports a part the server returns no content for without retrying', async () => {
    const { provider, download } = setup({ downloads: ['empty'] });

    await expect(provider.getMessage('m2')).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'The IMAP server returned no content for message part 1',
      failure: { provider: 'imap', phase: 'fetch', reason: 'invalid_response' },
    });
    expect(download).toHaveBeenCalledOnce();
  });

  it('reports a connection that closed during the read as a connection failure', async () => {
    const { provider, download } = setup({ downloads: ['closed'] });

    await expect(provider.getMessage('m2')).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { provider: 'imap', phase: 'fetch', reason: 'connection_reset' },
    });
    expect(download).toHaveBeenCalledOnce();
  });

  it('keeps an unrelated TypeError from the download when the message is still there', async () => {
    const { provider, download } = setup({ downloads: ['broken'] });

    await expect(provider.getMessage('m2')).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: expect.stringContaining("reading 'childNodes'"),
      failure: { reason: 'other' },
    });
    expect(download).toHaveBeenCalledOnce();
  });

  it('downloads an attachment from the copy another mail app saved mid-read', async () => {
    const { store, provider } = setup({ downloads: ['replaced', 'content'], attachment: true });

    await expect(provider.getAttachment('m2', 'part:1')).resolves.toMatchObject({
      meta: { filename: 'notes.pdf' },
      content: Buffer.from('Body at 10'),
    });
    expect(await store.findById('m2')).toMatchObject({ uid: 10 });
  });

  it('updates a draft another mail app saved while it was being read', async () => {
    const { store, provider, fake } = setup({ downloads: ['replaced', 'content', 'content'] });

    await expect(
      provider.updateDraft('draft-1', { to: [{ email: 'you@example.com' }], body: { text: 'Updated' } }),
    ).resolves.toMatchObject({ id: 'm2', draftId: 'draft-1', body: { text: 'Body at 20' } });
    // The copy that replaced the original is the one deleted, and the update keeps its sender.
    expect(fake.messageDelete).toHaveBeenCalledExactlyOnceWith('10', { uid: true });
    expect(fake.append.mock.calls[0]?.[1].toString()).toContain('From: alias@example.com');
    expect(await store.findById('m2')).toMatchObject({ uid: 20, draftId: 'draft-1' });
  });

  it('deletes the old draft even when the new copy cannot be read back', async () => {
    const { provider, fake } = setup({ downloads: ['content', 'empty'] });

    await expect(
      provider.updateDraft('draft-1', { to: [{ email: 'you@example.com' }], body: { text: 'Updated' } }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fake.messageDelete).toHaveBeenCalledExactlyOnceWith('9', { uid: true });
  });

  it('deletes copies of the old draft another mail app saved after it was read', async () => {
    const { provider, fake } = setup({});
    // The draft at 9 and a copy another mail app saved at 12 share the old Message-ID.
    fake.search.mockResolvedValue([9, 12]);

    await provider.updateDraft('draft-1', { to: [{ email: 'you@example.com' }], body: { text: 'Updated' } });

    expect(fake.messageDelete).toHaveBeenCalledExactlyOnceWith('9,12', { uid: true });
    expect(fake.search).toHaveBeenCalledWith({ header: { 'Message-ID': '<draft@example.com>' } }, { uid: true });
  });
});

describe('ImapProvider safe folder fallbacks', () => {
  it('discovers search capabilities for one connection and clears them on close', async () => {
    const archive = folder('Archive');
    archive.specialUse = '\\Archive';
    const fake = {
      usable: true,
      capabilities: new Map([['X-GM-EXT-1', true]]),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), archive]),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });

    expect(provider.capabilities.search.nativeQuery?.availability).toBe('unknown');
    expect(provider.capabilities.searchContext).toBe(true);
    await provider.listFolders();
    expect(provider.capabilities.search).toMatchObject({
      folderRoles: { inbox: 'available', archive: 'available', sent: 'unavailable' },
      nativeQuery: { syntax: 'gmail', availability: 'available' },
    });

    await provider.close();
    expect(provider.capabilities.search).toMatchObject({
      folderRoles: { inbox: 'unknown', archive: 'unknown' },
      nativeQuery: { availability: 'unknown' },
    });
  });

  it('does not permanently delete when Trash is unresolved', async () => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 7,
      threadId: 't1',
    });
    const messageDelete = vi.fn();
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      messageDelete,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    await expect(provider.modify(['m1'], 'trash')).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(messageDelete).not.toHaveBeenCalled();
  });

  it('requires dedicated actions for protected folder transitions', async () => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 7,
      threadId: 't1',
    });
    const trash = folder('Deleted Items');
    trash.specialUse = '\\Trash';
    const archive = folder('Archive');
    archive.specialUse = '\\Archive';
    await store.save({
      id: 'm2',
      accountId: 'a1',
      mailboxPath: 'Deleted Items',
      uidValidity: '1',
      uid: 8,
      threadId: 't2',
    });
    const messageMove = vi.fn();
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), trash, archive]),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      messageMove,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    for (const [ids, action] of [
      [['m1'], { move: 'Deleted Items' }],
      [['m1'], { move: 'Archive' }],
      [['m1'], 'untrash'],
      [['m2'], 'archive'],
    ] as const) {
      await expect(provider.modify([...ids], action)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(messageMove).not.toHaveBeenCalled();
  });

  it('delivers without failing when Sent is unresolved', async () => {
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.com>' });
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
      resolveSender: (email) => (email === 'sales@example.com' ? { email, name: 'Sales' } : undefined),
    });

    await expect(
      provider.send({
        from: 'sales@example.com',
        to: [{ email: 'you@example.com' }],
        cc: [{ email: 'copy@example.com' }],
        bcc: [{ email: 'hidden@example.com' }],
        subject: 'Hello',
        body: { text: 'Body' },
      }),
    ).resolves.toMatchObject({
      id: '<sent@example.com>',
      warnings: [expect.stringMatching(/no Sent folder/)],
    });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: {
          from: 'sales@example.com',
          to: ['you@example.com', 'copy@example.com', 'hidden@example.com'],
        },
      }),
    );
    const raw = (sendMail.mock.calls[0]![0] as { raw: Buffer }).raw.toString();
    expect(raw).toContain('From: Sales <sales@example.com>');
    expect(raw).not.toMatch(/^Bcc:/im);
  });

  it('disables draft creation when Drafts is unresolved', async () => {
    const append = vi.fn();
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
      append,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });

    await expect(provider.createDraft({ subject: 'Draft', body: { text: 'Body' } })).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringMatching(/--drafts-folder/),
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('reports the server reply when the Drafts append is rejected', async () => {
    const drafts = folder('INBOX.Drafts');
    drafts.specialUse = '\\Drafts';
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), drafts]),
      append: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'Mailbox is full' }),
        ),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });

    await expect(
      provider.createDraft({ to: [{ email: 'me@example.com' }], subject: 'x', body: { text: 'line one\nline two' } }),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'IMAP/SMTP operation failed: Command failed (NO: Mailbox is full)',
    });
    const raw = (fake.append.mock.calls[0]![1] as Buffer).toString('binary');
    expect(raw).toContain('line one\r\nline two');
    expect(raw).not.toMatch(/(?<!\r)\n/);
  });

  it.each(['archive', 'trash', 'untrash'] as const)(
    'does not move or delete for %s when its required folder is unresolved',
    async (action) => {
      const store = new MemoryStore();
      await store.save({
        id: 'm1',
        accountId: 'a1',
        mailboxPath: 'INBOX',
        uidValidity: '1',
        uid: 7,
        threadId: 't1',
      });
      const messageMove = vi.fn();
      const messageDelete = vi.fn();
      const fake = {
        usable: true,
        mailbox: false,
        capabilities: new Map(),
        on: vi.fn(),
        connect: vi.fn(),
        close: vi.fn(),
        list: vi.fn().mockResolvedValue([folder('INBOX')]),
        getMailboxLock: vi.fn(async () => {
          fake.mailbox = { uidValidity: 1n } as never;
          return { release: vi.fn() };
        }),
        messageMove,
        messageDelete,
      };
      const provider = new ImapProvider({
        accountId: 'a1',
        email: 'me@example.com',
        credentials: {
          imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
          smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
          saveSent: true,
        },
        store,
        imapFactory: () => fake as unknown as ImapFlow,
      });

      await expect(provider.modify(['m1'], action)).rejects.toMatchObject({ code: 'unsupported_capability' });
      expect(messageMove).not.toHaveBeenCalled();
      expect(messageDelete).not.toHaveBeenCalled();
    },
  );

  it('does not append a Sent copy when saveSent is false', async () => {
    const append = vi.fn();
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), folder('Sent')]),
      append,
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.com>' });
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: false,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
    });

    await expect(
      provider.send({ to: [{ email: 'you@example.com' }], subject: 'Hello', body: { text: 'Body' } }),
    ).resolves.not.toHaveProperty('warnings');
    expect(sendMail).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  });

  it('returns a warning without retrying SMTP when the Sent append fails', async () => {
    const sentFolder = folder('Sent');
    sentFolder.specialUse = '\\Sent';
    const fake = {
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), sentFolder]),
      append: vi.fn().mockRejectedValue(new Error('append refused')),
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<delivered@example.com>' });
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
    });

    await expect(
      provider.send({ to: [{ email: 'you@example.com' }], subject: 'Hello', body: { text: 'Body' } }),
    ).resolves.toMatchObject({
      id: '<delivered@example.com>',
      warnings: [expect.stringMatching(/could not save the Sent copy.*append refused/)],
    });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(fake.append).toHaveBeenCalledOnce();
  });

  it('builds required STARTTLS and implicit TLS SMTP options', () => {
    const base = { host: 'smtp.example.com', port: 587, user: 'me', password: 'secret' };
    expect(smtpTransportOptions({ ...base, security: 'starttls' })).toMatchObject({
      secure: false,
      requireTLS: true,
      greetingTimeout: 10_000,
    });
    expect(smtpTransportOptions({ ...base, port: 465, security: 'tls' })).toMatchObject({
      secure: true,
      requireTLS: false,
    });
  });

  it('creates a new IMAP client after the current connection becomes unusable', async () => {
    const clients = [0, 1].map(() => ({
      usable: true,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
    }));
    const factory = vi.fn(() => clients[factory.mock.calls.length - 1] as unknown as ImapFlow);
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: factory,
    });

    await provider.listFolders();
    clients[0]!.usable = false;
    await provider.listFolders();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('falls back to PostalMime when BODYSTRUCTURE is unavailable', async () => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 7,
      threadId: 't1',
    });
    const source = Buffer.from(
      'From: sender@example.com\r\nTo: me@example.com\r\nSubject: Fallback\r\nMessage-ID: <fallback@example.com>\r\nContent-Type: text/plain\r\n\r\nfallback body',
    );
    const fetchOne = vi
      .fn()
      .mockResolvedValueOnce({
        uid: 7,
        envelope: {
          subject: 'Fallback',
          from: [{ address: 'sender@example.com' }],
          to: [{ address: 'me@example.com' }],
        },
        flags: new Set(),
      })
      .mockResolvedValueOnce({ uid: 7, source });
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      fetchOne,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    await expect(provider.getMessage('m1')).resolves.toMatchObject({
      subject: 'Fallback',
      body: { text: expect.stringContaining('fallback body') },
    });
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });
});

function testCredentials(saveSent = true) {
  return {
    imap: { host: 'imap.example.com', port: 993, security: 'tls' as const, user: 'me', password: 'secret' },
    smtp: {
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls' as const,
      user: 'me',
      password: 'secret',
    },
    saveSent,
  };
}

describe('ImapProvider connection and pagination state', () => {
  it('force-closes a connected IMAP client without waiting for logout', async () => {
    const fake = {
      usable: true,
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      logout: vi.fn(() => new Promise<void>(() => {})),
      list: vi.fn().mockResolvedValue([]),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });

    await provider.listFolders();
    await expect(provider.close()).resolves.toBeUndefined();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.logout).not.toHaveBeenCalled();
  });

  it('closes an in-progress IMAP client without waiting for connect to settle', async () => {
    let finishConnect: (() => void) | undefined;
    const pendingConnect = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const fake = {
      usable: false,
      on: vi.fn(),
      connect: vi.fn(() => pendingConnect),
      close: vi.fn(),
      list: vi.fn(),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: true,
      },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });

    const listing = provider.listFolders();
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledOnce());
    await expect(provider.close()).resolves.toBeUndefined();
    expect(fake.close).toHaveBeenCalledOnce();
    finishConnect?.();
    await expect(listing).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('shares an in-flight IMAP connection between concurrent requests', async () => {
    let finishConnect!: () => void;
    const connected = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const fake = {
      usable: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(async () => {
        await connected;
        fake.usable = true;
      }),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
    };
    const factory = vi.fn(() => fake as unknown as ImapFlow);
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store: new MemoryStore(),
      imapFactory: factory,
    });

    const first = provider.listFolders();
    const second = provider.listFolders();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    finishConnect();
    await Promise.all([first, second]);

    expect(fake.connect).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('closes a dedicated search connection when setup is canceled', async () => {
    let rejectConnect!: (error: Error) => void;
    const fake = {
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectConnect = reject;
          }),
      ),
      close: vi.fn(() => rejectConnect?.(new Error('connection closed'))),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });
    const controller = new AbortController();
    const search = provider.listMessages({}, { signal: controller.signal });
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledOnce());

    controller.abort(new Error('search deadline'));

    await expect(search).rejects.toThrow('search deadline');
    expect(fake.close).toHaveBeenCalled();
  });

  function paginationProvider(
    initialUids: number[],
    listedFolders = [folder('INBOX'), folder('Sent')],
    store: ImapStateStore = new MemoryStore(),
    size: { uidNext: number; exists: number } | Record<string, never> = {},
  ) {
    let selected = 'INBOX';
    let uids = initialUids;
    let uidValidity = 1n;
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue(listedFolders),
      getMailboxLock: vi.fn(async (path: string) => {
        selected = path;
        fake.mailbox = { uidValidity, ...size } as never;
        return { release: vi.fn() };
      }),
      search: vi.fn(async (query: { uid?: string }) => {
        if (!query.uid) return uids;
        const [lower, upper] = query.uid.split(':').map(Number) as [number, number];
        return uids.filter((uid) => uid >= lower && uid <= upper);
      }),
      download: vi.fn(),
      messageFlagsAdd: vi.fn(),
      fetchOne: vi.fn(async (uid: number) => ({
        uid,
        envelope: { subject: `${selected}-${uid}`, messageId: `<${selected}-${uid}@example.com>` },
        headers: Buffer.from(`Message-ID: <${selected}-${uid}@example.com>\r\n`),
        flags: new Set<string>(),
        internalDate: new Date('2026-01-01T00:00:00Z'),
      })),
      // One UID FETCH for a comma-separated UID set, served from fetchOne so tests
      // can keep shaping messages through it.
      fetch: vi.fn(async function* (range: string, query: unknown, options: unknown) {
        for (const uid of range.split(',').map(Number)) {
          const message = await fake.fetchOne(uid, query as never, options as never);
          if (message) yield message;
        }
      }),
    };
    return {
      provider: new ImapProvider({
        accountId: 'a1',
        email: 'me@example.com',
        credentials: testCredentials(),
        store,
        imapFactory: () => fake as unknown as ImapFlow,
      }),
      setUids(next: number[]) {
        uids = next;
      },
      setUidValidity(next: bigint) {
        uidValidity = next;
      },
      list: fake.list,
      search: fake.search,
      connect: fake.connect,
      fetchOne: fake.fetchOne,
      fetch: fake.fetch,
      download: fake.download,
      messageFlagsAdd: fake.messageFlagsAdd,
    };
  }

  it('requests unread counts only when listing folders', async () => {
    const { provider, list } = paginationProvider([1]);

    await provider.listMessages({ folder: 'INBOX' }, { signal: new AbortController().signal });
    expect(list).toHaveBeenLastCalledWith({});

    await provider.listFolders();
    expect(list).toHaveBeenLastCalledWith({ statusQuery: { unseen: true } });
  });

  it('rejects a page token when the folder changes', async () => {
    const { provider } = paginationProvider([3, 2]);
    const first = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 1 });

    await expect(
      provider.listMessages({ folder: 'Sent' }, { pageSize: 1, pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('keeps pagination stable when a newer UID arrives', async () => {
    const { provider, setUids } = paginationProvider([3, 2, 1]);
    const first = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2 });
    setUids([4, 3, 2, 1]);
    const second = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2, pageToken: first.nextPageToken });

    expect(first.items.map((message) => message.subject)).toEqual(['INBOX-3', 'INBOX-2']);
    expect(second.items.map((message) => message.subject)).toEqual(['INBOX-1']);
  });

  it('rejects a resumed mailbox after its UIDVALIDITY changes', async () => {
    const { provider, setUidValidity } = paginationProvider([3, 2]);
    const first = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 1 });
    setUidValidity(2n);

    await expect(
      provider.listMessages({ folder: 'INBOX' }, { pageSize: 1, pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('does not return a page token when the page consumes every match', async () => {
    const { provider } = paginationProvider([2, 1]);
    const page = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2 });
    expect(page.nextPageToken).toBeUndefined();
  });

  it('intersects IMAP results for every literal full-text term', async () => {
    const { provider, search } = paginationProvider([3, 2, 1]);
    search.mockImplementation(async (query: unknown) =>
      (query as { text?: string }).text === 'quarterly' ? [3, 2] : [2, 1],
    );

    const page = await provider.listMessages({ folder: 'INBOX', text: 'quarterly report' });

    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-2']);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('applies canonical attachment and UTC date filters after IMAP search', async () => {
    const { provider, fetchOne } = paginationProvider([4, 3, 2, 1]);
    fetchOne.mockImplementation(async (uid: number) => ({
      uid,
      envelope: { subject: `INBOX-${uid}`, messageId: `<INBOX-${uid}@example.com>` },
      headers: Buffer.from(`Message-ID: <INBOX-${uid}@example.com>\r\n`),
      flags: new Set<string>(),
      internalDate: new Date(
        uid === 4 ? '2025-12-31T23:59:59.999Z' : uid === 2 ? '2026-01-03T00:00:00.000Z' : '2026-01-02T12:00:00.000Z',
      ),
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain', encoding: '7bit', size: 12 },
          {
            part: '2',
            type: 'image/png',
            encoding: 'base64',
            size: 24,
            disposition: uid === 3 ? 'inline' : 'attachment',
          },
        ],
      },
    }));

    const page = await provider.listMessages(
      {
        folder: 'INBOX',
        hasAttachment: true,
        after: '2026-01-01',
        before: '2026-01-03',
      },
      { pageSize: 10 },
    );

    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-1']);
    expect(page.inspectedCandidates).toBe(4);
  });

  it('continues after an empty page reaches the IMAP scan limit', async () => {
    const uids = Array.from({ length: 1_001 }, (_, index) => 1_001 - index);
    const { provider, fetchOne } = paginationProvider(uids);
    fetchOne.mockImplementation(async (uid: number) => ({
      uid,
      envelope: { subject: `INBOX-${uid}`, messageId: `<INBOX-${uid}@example.com>` },
      headers: Buffer.from(`Message-ID: <INBOX-${uid}@example.com>\r\n`),
      flags: new Set<string>(),
      internalDate: new Date(uid === 1 ? '2026-01-02T12:00:00.000Z' : '2025-12-31T12:00:00.000Z'),
    }));

    const query = { folder: 'INBOX', after: '2026-01-01' };
    const first = await provider.listMessages(query, { pageSize: 1 });
    const second = await provider.listMessages(query, { pageSize: 1, pageToken: first.nextPageToken });

    expect(first).toMatchObject({
      items: [],
      incomplete: true,
      incompleteReason: 'scan_limit',
      inspectedCandidates: 1_000,
    });
    expect(first.nextPageToken).toBeTruthy();
    expect(second.items.map((message) => message.subject)).toEqual(['INBOX-1']);
    expect(second.nextPageToken).toBeUndefined();
    expect(second.incomplete).toBeUndefined();
    expect(second.inspectedCandidates).toBe(1);
  });

  it('stops after ten empty folders and resumes at the next folder', async () => {
    const folders = Array.from({ length: 12 }, (_, index) => folder(`Folder ${index + 1}`));
    const { provider, search } = paginationProvider([], folders);

    const first = await provider.listMessages({}, { pageSize: 1 });
    expect(first).toMatchObject({ exhausted: false, incomplete: true, incompleteReason: 'scan_limit', items: [] });
    expect(first.nextPageToken).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(10);

    const second = await provider.listMessages({}, { pageSize: 1, pageToken: first.nextPageToken });
    expect(second).toMatchObject({ exhausted: true, items: [] });
    expect(second.nextPageToken).toBeUndefined();
    expect(search).toHaveBeenCalledTimes(12);
  });

  it('returns a resumable page when the soft deadline is already reached', async () => {
    const { provider, search } = paginationProvider([2, 1], [folder('INBOX')]);

    const first = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 1, softDeadlineAt: Date.now() - 1 });
    expect(first).toMatchObject({ exhausted: false, incomplete: true, incompleteReason: 'time_limit', items: [] });
    expect(search).not.toHaveBeenCalled();

    const second = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2, pageToken: first.nextPageToken });
    expect(second.items.map((message) => message.subject)).toEqual(['INBOX-2', 'INBOX-1']);
    expect(second.exhausted).toBe(true);
  });

  it('stops a listing aborted while the connection is still connecting', async () => {
    const { provider, connect } = paginationProvider([1]);
    // Closing a connecting ImapFlow client leaves its connect() pending.
    connect.mockReturnValueOnce(new Promise(() => {}));
    const controller = new AbortController();
    const listing = provider.listMessages({}, { signal: controller.signal });
    controller.abort(new Error('stopped'));
    await expect(listing).rejects.toThrow('stopped');
  });

  it('records the connect and search phases of a failed listing', async () => {
    const { provider, search, connect } = paginationProvider([1]);
    connect.mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:993'), { code: 'ECONNREFUSED' }),
    );
    await expect(provider.listMessages({}, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { provider: 'imap', phase: 'connect', reason: 'connection_refused', ioCode: 'ECONNREFUSED' },
    });

    search.mockRejectedValueOnce(
      Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'private' }),
    );
    await expect(
      provider.listMessages({ text: 'private' }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { provider: 'imap', phase: 'search', reason: 'server_no' },
    });
  });

  it('returns finished folders when a later folder search passes the soft deadline', async () => {
    const { provider, search } = paginationProvider([1]);
    // Hold the clock until the Sent search starts so a slow runner cannot pass the
    // deadline while INBOX is still being read.
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    search.mockResolvedValueOnce([1]).mockImplementationOnce(() => {
      clock.mockRestore();
      return new Promise<number[]>(() => {});
    });

    const first = await provider
      .listMessages({}, { pageSize: 25, signal: new AbortController().signal, softDeadlineAt: startedAt + 20 })
      .finally(() => clock.mockRestore());
    expect(search).toHaveBeenCalledTimes(2);
    expect(first.items.map((message) => message.subject)).toEqual(['INBOX-1']);
    expect(first).toMatchObject({ exhausted: false, incomplete: true, incompleteReason: 'time_limit' });

    search.mockResolvedValueOnce([5]);
    const second = await provider.listMessages({}, { pageSize: 25, pageToken: first.nextPageToken });
    expect(second.items.map((message) => message.subject)).toEqual(['Sent-5']);
    expect(second.exhausted).toBe(true);
  });

  it('preserves the resumed mailbox position when the soft deadline is already reached', async () => {
    const { provider, search } = paginationProvider([3, 2, 1], [folder('INBOX')]);

    const first = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 1 });
    const timedOut = await provider.listMessages(
      { folder: 'INBOX' },
      { pageSize: 1, pageToken: first.nextPageToken, softDeadlineAt: Date.now() - 1 },
    );
    const resumed = await provider.listMessages(
      { folder: 'INBOX' },
      { pageSize: 1, pageToken: timedOut.nextPageToken },
    );

    expect(first.items.map((message) => message.subject)).toEqual(['INBOX-3']);
    expect(timedOut).toMatchObject({
      exhausted: false,
      incomplete: true,
      incompleteReason: 'time_limit',
      items: [],
    });
    expect(timedOut.nextPageToken).toBe(first.nextPageToken);
    expect(resumed.items.map((message) => message.subject)).toEqual(['INBOX-2']);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps metadata and unread state when shared IMAP enrichment fails', async () => {
    const { provider, fetchOne, download, messageFlagsAdd } = paginationProvider([1], [folder('INBOX')]);
    fetchOne.mockResolvedValue({
      uid: 1,
      envelope: { subject: 'Preview failure', messageId: '<preview@example.com>' },
      headers: Buffer.from('Message-ID: <preview@example.com>\r\n'),
      flags: new Set<string>(),
      internalDate: new Date('2026-01-01T00:00:00Z'),
      bodyStructure: { part: '1', type: 'text/plain', encoding: '7bit', size: 12 },
    });
    download.mockRejectedValue(new Error('private provider failure'));

    const page = await provider.listMessages(
      { folder: 'INBOX', text: 'needle' },
      { includeSnippet: true, includeSearchContext: true },
    );

    expect(page.items[0]).toMatchObject({ subject: 'Preview failure', flags: { read: false } });
    expect(page.items[0]?.snippet).toBeUndefined();
    expect(page.items[0]?.searchContext).toEqual({ status: 'unavailable' });
    expect(page.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'snippet_unavailable', severity: 'warning' }),
        expect.objectContaining({ code: 'search_context_unavailable', severity: 'warning' }),
      ]),
    );
    expect(download).toHaveBeenCalledOnce();
    expect(page.exhausted).toBe(true);
    expect(messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('reads a page of previews with one fetch instead of a download per message', async () => {
    const { provider, fetchOne, fetch, download } = paginationProvider([3, 2, 1], [folder('INBOX')]);
    fetchOne.mockImplementation(async (uid: number, query: { bodyParts?: { key: string }[] }) => ({
      uid,
      envelope: { subject: `INBOX-${uid}`, messageId: `<${uid}@example.com>` },
      headers: Buffer.from(`Message-ID: <${uid}@example.com>\r\n`),
      flags: new Set<string>(),
      internalDate: new Date('2026-01-01T00:00:00Z'),
      bodyStructure: { type: 'text/plain', encoding: '7bit', size: 20 },
      ...(query.bodyParts ? { bodyParts: new Map([['text', Buffer.from(`Preview ${uid}`)]]) } : {}),
    }));

    const page = await provider.listMessages({ folder: 'INBOX' }, { includeSnippet: true });

    expect(page.items.map((message) => message.snippet)).toEqual(['Preview 3', 'Preview 2', 'Preview 1']);
    expect(page.diagnostics).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    const previewFetches = fetch.mock.calls.filter(([, query]) => (query as { bodyParts?: unknown }).bodyParts);
    expect(previewFetches).toEqual([
      ['3,2,1', { uid: true, bodyParts: [{ key: 'text', start: 0, maxLength: 16 * 1024 }] }, { uid: true }],
    ]);
  });

  it('returns metadata and skips previews once the soft deadline has passed', async () => {
    const { provider, fetchOne, fetch } = paginationProvider([2, 1], [folder('INBOX')]);
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchOne.mockImplementation(async (uid: number) => {
      // Listing the metadata takes past the deadline.
      now = 20_000;
      return {
        uid,
        envelope: { subject: `INBOX-${uid}` },
        flags: new Set<string>(),
        internalDate: new Date('2026-01-01T00:00:00Z'),
        bodyStructure: { type: 'text/plain', encoding: '7bit', size: 20 },
      };
    });

    const page = await provider.listMessages({ folder: 'INBOX' }, { includeSnippet: true, softDeadlineAt: 15_000 });

    vi.restoreAllMocks();
    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-2', 'INBOX-1']);
    expect(page.diagnostics).toEqual([
      expect.objectContaining({ code: 'snippet_unavailable' }),
      expect.objectContaining({ code: 'snippet_unavailable' }),
    ]);
    expect(fetch.mock.calls.some(([, query]) => (query as { bodyParts?: unknown }).bodyParts)).toBe(false);
  });

  it('keeps metadata and warns for each message when the preview fetch fails', async () => {
    const { provider, fetchOne, fetch } = paginationProvider([2, 1], [folder('INBOX')]);
    fetchOne.mockImplementation(async (uid: number) => ({
      uid,
      envelope: { subject: `INBOX-${uid}` },
      flags: new Set<string>(),
      internalDate: new Date('2026-01-01T00:00:00Z'),
      bodyStructure: { type: 'text/plain', encoding: '7bit', size: 20 },
    }));
    const listFetch = fetch.getMockImplementation()!;
    fetch.mockImplementation((range: string, query: unknown, options: unknown) => {
      if ((query as { bodyParts?: unknown }).bodyParts) throw new Error('private provider failure');
      return listFetch(range, query, options);
    });

    const page = await provider.listMessages({ folder: 'INBOX' }, { includeSnippet: true });

    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-2', 'INBOX-1']);
    expect(page.items.every((message) => message.snippet === undefined)).toBe(true);
    expect(page.diagnostics).toEqual([
      expect.objectContaining({ code: 'snippet_unavailable', severity: 'warning' }),
      expect.objectContaining({ code: 'snippet_unavailable', severity: 'warning' }),
    ]);
    expect(JSON.stringify(page)).not.toContain('private');
  });

  it('excludes resolved Spam and Trash folders when the server has no All mailbox', async () => {
    const spam = folder('Spam');
    spam.specialUse = '\\Junk';
    const spamChild = folder('Spam/Review');
    const trash = folder('Trash');
    trash.specialUse = '\\Trash';
    const trashChild = folder('Trash/Receipts');
    const { provider } = paginationProvider([1], [folder('INBOX'), folder('Sent'), spam, spamChild, trash, trashChild]);
    const page = await provider.listMessages({ folder: 'all' });
    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-1', 'Sent-1']);
  });

  it('uses the server All mailbox for an omitted folder', async () => {
    const all = folder('All Mail');
    all.specialUse = '\\All';
    const spam = folder('Spam');
    spam.specialUse = '\\Junk';
    const { provider } = paginationProvider([1], [folder('INBOX'), folder('Sent'), all, spam]);

    const page = await provider.listMessages({});

    expect(page.items.map((message) => message.subject)).toEqual(['All Mail-1']);
  });

  it('fetches a page with one UID FETCH and resumes after it', async () => {
    const uids = Array.from({ length: 30 }, (_, index) => 30 - index);
    const { provider, fetch, fetchOne } = paginationProvider(uids, [folder('INBOX')]);

    const first = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 25 });
    expect(first.items).toHaveLength(25);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(uids.slice(0, 26).join(','));
    expect(fetch.mock.calls[0]![2]).toEqual({ uid: true });
    fetchOne.mockClear();

    const second = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 25, pageToken: first.nextPageToken });
    expect(second.items.map((message) => message.subject)).toEqual([
      'INBOX-5',
      'INBOX-4',
      'INBOX-3',
      'INBOX-2',
      'INBOX-1',
    ]);
    expect(second.nextPageToken).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fetches the next batch when a fetched UID was expunged', async () => {
    const { provider, fetch, fetchOne } = paginationProvider([5, 4, 3, 2, 1], [folder('INBOX')]);
    const listed = fetchOne.getMockImplementation()!;
    fetchOne.mockImplementation(async (uid: number, ...rest: unknown[]) =>
      uid === 4 ? undefined : listed(uid, ...(rest as [])),
    );

    const page = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2 });
    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-5', 'INBOX-3']);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(['5,4,3', '2']);
    const next = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 2, pageToken: page.nextPageToken });
    expect(next.items.map((message) => message.subject)).toEqual(['INBOX-2', 'INBOX-1']);
  });

  it('fetches filtered candidates in batches of 50', async () => {
    const uids = Array.from({ length: 120 }, (_, index) => 120 - index);
    const { provider, fetch, fetchOne } = paginationProvider(uids, [folder('INBOX')]);
    fetchOne.mockImplementation(async (uid: number) => ({
      uid,
      envelope: { subject: `INBOX-${uid}`, messageId: `<INBOX-${uid}@example.com>` },
      headers: Buffer.from(`Message-ID: <INBOX-${uid}@example.com>\r\n`),
      flags: new Set<string>(),
      internalDate: new Date(uid === 1 ? '2026-01-02T12:00:00.000Z' : '2025-12-31T12:00:00.000Z'),
    }));

    const page = await provider.listMessages({ folder: 'INBOX', after: '2026-01-01' }, { pageSize: 10 });
    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-1']);
    expect(page.inspectedCandidates).toBe(120);
    expect(fetch.mock.calls.map((call) => (call[0] as string).split(',').length)).toEqual([50, 50, 20]);
  });

  it('looks up and saves stored locations once per batch when the store supports it', async () => {
    class BatchStore extends MemoryStore {
      findByLocations = vi.fn(async (path: string, uidValidity: string, uids: number[]) =>
        [...this.rows.values()].filter(
          (row) => row.mailboxPath === path && row.uidValidity === uidValidity && uids.includes(row.uid),
        ),
      );
      saveMany = vi.fn(async (locations: ImapMessageLocation[]) => {
        for (const location of locations) this.rows.set(location.id, location);
      });
    }
    const store = new BatchStore();
    await store.save({
      id: 'known',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 2,
      threadId: 't-known',
    });
    const findByLocation = vi.spyOn(store, 'findByLocation');
    const save = vi.spyOn(store, 'save');
    const { provider } = paginationProvider([3, 2, 1], [folder('INBOX')], store);

    const page = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 25 });

    expect(page.items.map((message) => message.id)).toEqual([
      expect.stringMatching(/^im_/),
      'known',
      expect.stringMatching(/^im_/),
    ]);
    expect(store.findByLocations).toHaveBeenCalledOnce();
    expect(store.findByLocations).toHaveBeenCalledWith('INBOX', '1', [3, 2, 1]);
    expect(store.saveMany).toHaveBeenCalledOnce();
    expect(store.saveMany.mock.calls[0]![0].map((location) => location.uid)).toEqual([3, 2, 1]);
    expect(findByLocation).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await expect(provider.getMessage(page.items[0]!.id)).resolves.toMatchObject({ subject: 'INBOX-3' });
  });

  it('keeps a fetched batch when the soft deadline passes during the fetch', async () => {
    const { provider, fetch } = paginationProvider([3, 2, 1], [folder('INBOX')]);
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const batched = fetch.getMockImplementation()!;
    fetch.mockImplementationOnce((...args: Parameters<typeof batched>) => {
      clock.mockReturnValue(startedAt + 1_000);
      return batched(...args);
    });

    const page = await provider
      .listMessages({ folder: 'INBOX' }, { pageSize: 2, softDeadlineAt: startedAt + 10 })
      .finally(() => clock.mockRestore());

    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-3', 'INBOX-2']);
    expect(page.incomplete).toBeUndefined();
    expect(page.nextPageToken).toBeTruthy();
  });

  it('searches a large folder in UID ranges, newest first', async () => {
    const { provider, search } = paginationProvider([9_500, 3_000, 1_200, 5], [folder('INBOX')], undefined, {
      uidNext: 10_001,
      exists: 10_000,
    });
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const options = { pageSize: 2, softDeadlineAt: startedAt + 60_000 };

    const first = await provider.listMessages({ folder: 'INBOX', text: 'invoice' }, options);
    const second = await provider
      .listMessages({ folder: 'INBOX', text: 'invoice' }, { ...options, pageToken: first.nextPageToken })
      .finally(() => clock.mockRestore());

    expect(first.items.map((message) => message.subject)).toEqual(['INBOX-9500', 'INBOX-3000']);
    expect(first).toMatchObject({ exhausted: false });
    expect(first.incomplete).toBeUndefined();
    expect(second.items.map((message) => message.subject)).toEqual(['INBOX-1200', 'INBOX-5']);
    expect(second.exhausted).toBe(true);
    // Fast answers grow the range, so the rest of the folder takes one more search.
    expect(search.mock.calls.map(([query]) => query.uid)).toEqual(['8001:10000', '1:8000', '1:1200']);
    expect(search.mock.calls.every(([query]) => (query as { text?: string }).text === 'invoice')).toBe(true);
  });

  it('returns the ranges searched before the soft deadline and resumes below them', async () => {
    const { provider, search } = paginationProvider([9_500, 3_000], [folder('INBOX')], undefined, {
      uidNext: 10_001,
      exists: 10_000,
    });
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const ranged = search.getMockImplementation()!;
    search.mockImplementationOnce(async (query) => {
      clock.mockReturnValue(startedAt + 3_000);
      return ranged(query);
    });

    const first = await provider.listMessages({ folder: 'INBOX', text: 'invoice' }, { softDeadlineAt: startedAt + 10 });
    clock.mockReturnValue(startedAt);
    const second = await provider
      .listMessages(
        { folder: 'INBOX', text: 'invoice' },
        { softDeadlineAt: startedAt + 60_000, pageToken: first.nextPageToken },
      )
      .finally(() => clock.mockRestore());

    expect(first.items.map((message) => message.subject)).toEqual(['INBOX-9500']);
    expect(first).toMatchObject({ exhausted: false, incomplete: true, incompleteReason: 'time_limit' });
    expect(second.items.map((message) => message.subject)).toEqual(['INBOX-3000']);
    expect(second.exhausted).toBe(true);
    expect(search.mock.calls.map(([query]) => query.uid)).toEqual(['8001:10000', '6001:8000', '1:6000']);
  });

  it('returns finished folders when a later folder range passes the soft deadline', async () => {
    const { provider, search } = paginationProvider([9_500], undefined, undefined, { uidNext: 10_001, exists: 10_000 });
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const ranged = search.getMockImplementation()!;
    // INBOX takes two ranges. The first Sent range never answers.
    search
      .mockImplementationOnce(ranged)
      .mockImplementationOnce(ranged)
      .mockImplementationOnce(() => {
        clock.mockRestore();
        return new Promise<number[]>(() => {});
      });

    const first = await provider
      .listMessages({ text: 'invoice' }, { signal: new AbortController().signal, softDeadlineAt: startedAt + 20 })
      .finally(() => clock.mockRestore());
    const second = await provider.listMessages(
      { text: 'invoice' },
      { softDeadlineAt: Date.now() + 60_000, pageToken: first.nextPageToken },
    );

    expect(first.items.map((message) => message.subject)).toEqual(['INBOX-9500']);
    expect(first).toMatchObject({ exhausted: false, incomplete: true, incompleteReason: 'time_limit' });
    expect(second.items.map((message) => message.subject)).toEqual(['Sent-9500']);
    expect(second.exhausted).toBe(true);
  });

  it('limits how far a search range grows', async () => {
    const { provider, search } = paginationProvider([], [folder('INBOX')], undefined, {
      uidNext: 200_001,
      exists: 200_000,
    });
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);

    const page = await provider
      .listMessages({ folder: 'INBOX', text: 'invoice' }, { softDeadlineAt: startedAt + 60_000 })
      .finally(() => clock.mockRestore());

    const spans = search.mock.calls.map(([query]) => {
      const [lower, upper] = query.uid!.split(':').map(Number) as [number, number];
      return upper - lower + 1;
    });
    expect(page).toMatchObject({ items: [], exhausted: true });
    expect(spans.slice(0, 4)).toEqual([2_000, 8_000, 32_000, 32_000]);
    expect(Math.max(...spans)).toBe(32_000);
  });

  it('searches a small folder in one command', async () => {
    const { provider, search } = paginationProvider([2, 1], [folder('INBOX')], undefined, {
      uidNext: 3,
      exists: 2,
    });

    const page = await provider.listMessages({ folder: 'INBOX' }, { softDeadlineAt: Date.now() + 60_000 });

    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-2', 'INBOX-1']);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0].uid).toBeUndefined();
  });
});

describe('ImapProvider reply threading', () => {
  it('reads threading headers without depending on their capitalization', async () => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 7,
      threadId: 't1',
    });
    const source = Buffer.from(
      'message-id: <root@example.com>\r\nreferences: <older@example.com>\r\nSubject: Original\r\nContent-Type: text/plain\r\n\r\nBody',
    );
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      fetchOne: vi.fn(async (_uid: number, query: { source?: boolean }) =>
        query.source
          ? { uid: 7, source }
          : {
              uid: 7,
              envelope: { subject: 'Original' },
              headers: Buffer.from('message-id: <root@example.com>\r\nreferences: <older@example.com>\r\n'),
              flags: new Set<string>(),
            },
      ),
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<reply@example.com>' });
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(false),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
    });

    await provider.send({
      to: [{ email: 'you@example.com' }],
      replyToMessageId: 'm1',
      body: { text: 'Reply' },
    });

    const raw = (sendMail.mock.calls[0]![0] as { raw: Buffer }).raw.toString();
    expect(raw).toMatch(/^In-Reply-To: <root@example.com>$/im);
    expect(raw).toMatch(/^References: <older@example.com> <root@example.com>$/im);
  });

  it('expands a thread through replies that omit References', async () => {
    const store = new MemoryStore();
    const threadId = 'thread-root';
    for (let uid = 1; uid <= 5; uid++) {
      await store.save({
        id: `m${uid}`,
        accountId: 'a1',
        mailboxPath: 'INBOX',
        uidValidity: '1',
        uid,
        messageId: `<m${uid}@example.com>`,
        ...(uid > 1 ? { inReplyTo: `<m${uid - 1}@example.com>` } : {}),
        threadId: uid === 1 ? threadId : `thread-parent-${uid}`,
      });
    }
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX')]),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      search: vi.fn(async (query: unknown) => {
        const serialized = JSON.stringify(query);
        for (let parent = 1; parent < 5; parent++) {
          if (serialized.includes(`<m${parent}@example.com>`)) return [parent + 1];
        }
        return [];
      }),
      fetchOne: vi.fn(async (uid: number, query: { source?: boolean }) => {
        const headers = `Message-ID: <m${uid}@example.com>\r\n${uid > 1 ? `In-Reply-To: <m${uid - 1}@example.com>\r\n` : ''}`;
        if (query.source) {
          return {
            uid,
            source: Buffer.from(`${headers}Subject: Message ${uid}\r\nContent-Type: text/plain\r\n\r\nBody ${uid}`),
          };
        }
        return {
          uid,
          envelope: { subject: `Message ${uid}`, messageId: `<m${uid}@example.com>` },
          headers: Buffer.from(headers),
          flags: new Set<string>(),
        };
      }),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    const thread = await provider.getThread(threadId);

    expect(thread.messages).toHaveLength(5);
    expect(thread.messages.every((message) => message.threadId === threadId)).toBe(true);
  });

  it('searches each folder for a batch of thread identifiers at once', async () => {
    const store = new MemoryStore();
    const references = Array.from({ length: 11 }, (_, index) => `<r${index}@example.com>`);
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 1,
      messageId: '<root@example.com>',
      references,
      threadId: 'thread-root',
    });
    const headers = (uid: number) =>
      uid === 1
        ? `Message-ID: <root@example.com>\r\nReferences: ${references.join(' ')}\r\n`
        : 'Message-ID: <reply@example.com>\r\nIn-Reply-To: <root@example.com>\r\n';
    const fake = {
      usable: true,
      mailbox: false as false | { path: string; uidValidity: bigint },
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), folder('Archive')]),
      getMailboxLock: vi.fn(async (path: string) => {
        fake.mailbox = { path, uidValidity: 1n };
        return { release: vi.fn() };
      }),
      search: vi.fn(async (query: unknown) => {
        const serialized = JSON.stringify(query);
        return fake.mailbox && fake.mailbox.path === 'INBOX' && serialized.includes('<root@example.com>') ? [1, 2] : [];
      }),
      fetchOne: vi.fn(async (uid: number, query: { source?: boolean }) =>
        query.source
          ? {
              uid,
              source: Buffer.from(
                `${headers(uid)}Subject: Message ${uid}\r\nContent-Type: text/plain\r\n\r\nBody ${uid}`,
              ),
            }
          : {
              uid,
              envelope: { subject: `Message ${uid}` },
              headers: Buffer.from(headers(uid)),
              flags: new Set<string>(),
            },
      ),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    const thread = await provider.getThread('thread-root');

    expect(thread.messages.map((message) => message.id)).toEqual(['m1', expect.any(String)]);
    expect(thread.messages[1]!.body?.text).toBe('Body 2');
    // 12 identifiers take two searches per folder, then the reply's ID takes one more.
    expect(fake.search).toHaveBeenCalledTimes(6);
    expect((fake.search.mock.calls[0]![0] as { or: unknown[] }).or).toHaveLength(30);
    expect((fake.search.mock.calls[1]![0] as { or: unknown[] }).or).toHaveLength(6);
  });

  describe('thread copies another mail app deleted or replaced', () => {
    const rootHeaders = 'Message-ID: <root@example.com>\r\n';
    const draftHeaders =
      'Message-ID: <draft@example.com>\r\nIn-Reply-To: <root@example.com>\r\nReferences: <root@example.com>\r\n';
    /** Validity drops stored rows of a reset folder, as Fluxmail Cloud's store does. */
    class InvalidatingStore extends MemoryStore {
      override async invalidateMailbox(path: string, uidValidity: string) {
        for (const row of [...this.rows.values()])
          if (row.mailboxPath === path && row.uidValidity !== uidValidity) this.rows.delete(row.id);
      }
    }
    const setup = async ({
      draftUid,
      draftValidity = 1n,
      fetchError,
      rootGone = false,
      rootUid = 1,
      keepOpen = false,
      store = new MemoryStore(),
    }: {
      /** The draft's UID on the server now; undefined once it is deleted. */
      draftUid?: number;
      draftValidity?: bigint;
      fetchError?: Error;
      /** Whether the root message is gone from the server too. */
      rootGone?: boolean;
      /** The root message's UID on the server now. */
      rootUid?: number;
      /** Keeps the open folder selected between locks, as imapflow does. */
      keepOpen?: boolean;
      store?: MemoryStore;
    } = {}) => {
      const base = { accountId: 'a1', uidValidity: '1', threadId: 'thread-root' };
      await store.save({ ...base, id: 'm1', mailboxPath: 'INBOX', uid: 1, messageId: '<root@example.com>' });
      await store.save({
        ...base,
        id: 'm2',
        mailboxPath: 'Drafts',
        uid: 9,
        messageId: '<draft@example.com>',
        inReplyTo: '<root@example.com>',
        references: ['<root@example.com>'],
        draftId: 'draft-1',
      });
      const drafts = folder('Drafts');
      drafts.specialUse = '\\Drafts';
      const inDrafts = () => fake.mailbox !== false && fake.mailbox.path === 'Drafts';
      const fake = {
        usable: true,
        mailbox: false as false | { path: string; uidValidity: bigint },
        capabilities: new Map(),
        on: vi.fn(),
        connect: vi.fn(),
        close: vi.fn(),
        list: vi.fn().mockResolvedValue([folder('INBOX'), drafts]),
        getMailboxLock: vi.fn(async (path: string) => {
          if (!keepOpen || fake.mailbox === false || fake.mailbox.path !== path)
            fake.mailbox = { path, uidValidity: path === 'Drafts' ? draftValidity : 1n };
          return { release: vi.fn() };
        }),
        noop: vi.fn(),
        messageFlagsAdd: vi.fn(),
        search: vi.fn(async (query: unknown) => {
          const serialized = JSON.stringify(query);
          if (!inDrafts()) return !rootGone && serialized.includes('<root@example.com>') ? [rootUid] : [];
          return draftUid !== undefined && /root@example\.com|draft@example\.com/.test(serialized) ? [draftUid] : [];
        }),
        fetchOne: vi.fn(async (uid: number, query: { source?: boolean }) => {
          if (inDrafts()) {
            if (fetchError) throw fetchError;
            if (uid !== draftUid) return false;
          } else if (rootGone || uid !== rootUid) return false;
          const headers = inDrafts() ? draftHeaders : rootHeaders;
          if (query.source)
            return {
              uid,
              source: Buffer.from(`${headers}Content-Type: text/plain\r\n\r\n${inDrafts() ? 'Draft' : 'Root'} body`),
            };
          return {
            uid,
            envelope: { subject: inDrafts() ? 'Re: Project review' : 'Project review' },
            headers: Buffer.from(headers),
            flags: new Set<string>(),
          };
        }),
        messageDelete: vi.fn(),
      };
      const provider = new ImapProvider({
        accountId: 'a1',
        email: 'me@example.com',
        credentials: testCredentials(),
        store,
        imapFactory: () => fake as unknown as ImapFlow,
      });
      return { store, provider, fake };
    };

    it('leaves out a copy another mail app deleted and forgets it', async () => {
      const { store, provider } = await setup();

      const thread = await provider.getThread('thread-root');

      expect(thread.messages.map((message) => message.id)).toEqual(['m1']);
      expect(thread.subject).toBe('Project review');
      expect(await store.findById('m2')).toBeUndefined();
      expect(await store.findById('m1')).toBeDefined();
    });

    it('keeps the IDs of a copy another mail app saved again under a new UID', async () => {
      const { store, provider } = await setup({ draftUid: 12 });

      const thread = await provider.getThread('thread-root');

      expect(thread.messages.map((message) => [message.id, message.draftId, message.body?.text])).toEqual([
        ['m1', undefined, 'Root body'],
        ['m2', 'draft-1', 'Draft body'],
      ]);
      // The thread search stored the new copy too; it merges into the old ID.
      expect([...store.rows.values()].map((row) => [row.id, row.uid])).toEqual([
        ['m1', 1],
        ['m2', 12],
      ]);
    });

    it.each(['before', 'after'])(
      'returns a re-saved draft once when the listed copy is stored %s the original',
      async (order) => {
        const store = new MemoryStore();
        const listed = {
          id: 'listed',
          accountId: 'a1',
          mailboxPath: 'Drafts',
          uidValidity: '1',
          uid: 12,
          messageId: '<draft@example.com>',
          inReplyTo: '<root@example.com>',
          references: ['<root@example.com>'],
          threadId: 'thread-root',
          draftId: 'draft-listed',
        };
        if (order === 'before') await store.save(listed);
        const { provider } = await setup({ draftUid: 12, store });
        if (order === 'after') await store.save(listed);

        const thread = await provider.getThread('thread-root');

        expect(thread.messages.map((message) => [message.id, message.draftId])).toEqual([
          ['m1', undefined],
          ['m2', 'draft-1'],
        ]);
        expect([...store.rows.keys()].sort()).toEqual(['m1', 'm2']);
      },
    );

    it('keeps a message whose folder was reset when the search finds it again', async () => {
      const store = new InvalidatingStore();
      const { provider } = await setup({ draftUid: 4, draftValidity: 2n, store });

      const thread = await provider.getThread('thread-root');

      expect(thread.messages.map((message) => message.body?.text)).toEqual(['Root body', 'Draft body']);
    });

    it('reports a missing thread when every copy is gone', async () => {
      const { store, provider } = await setup({ rootGone: true });

      await expect(provider.getThread('thread-root')).rejects.toMatchObject({ code: 'not_found' });
      expect(await store.listByThreadId('thread-root')).toEqual([]);
    });

    it('keeps the copy when the server fails to fetch it', async () => {
      const { store, provider } = await setup({
        draftUid: 9,
        fetchError: Object.assign(new Error('Connection not available'), { code: 'NoConnection' }),
      });

      await expect(provider.getThread('thread-root')).rejects.not.toMatchObject({ code: 'not_found' });
      expect(await store.findById('m2')).toMatchObject({ uid: 9 });
    });

    it('reads, updates and deletes a draft another mail app saved again', async () => {
      const { store, provider, fake } = await setup({ draftUid: 12 });

      await expect(provider.getDraft('draft-1')).resolves.toMatchObject({ id: 'm2', draftId: 'draft-1' });
      await expect(provider.getMessage('m2')).resolves.toMatchObject({ body: { text: 'Draft body' } });
      await provider.deleteDraft('draft-1');

      expect(fake.messageDelete).toHaveBeenCalledWith(12, { uid: true });
      expect(await store.findById('m2')).toBeUndefined();
    });

    it('checks for changes from other sessions when a folder is still open', async () => {
      const { provider, fake } = await setup({ keepOpen: true });

      await provider.getMessage('m1');
      expect(fake.noop).not.toHaveBeenCalled();
      await provider.getMessage('m1');
      expect(fake.noop).toHaveBeenCalledTimes(1);
    });

    it('does not take over a separate copy of a message stored under another ID', async () => {
      const store = new MemoryStore();
      await store.save({
        id: 'copy',
        accountId: 'a1',
        mailboxPath: 'INBOX',
        uidValidity: '1',
        uid: 5,
        messageId: '<root@example.com>',
        threadId: 'thread-root',
      });
      const { provider } = await setup({ rootUid: 5, store });

      await expect(provider.getMessage('m1')).rejects.toMatchObject({ code: 'not_found' });
      expect(await store.findById('m1')).toBeUndefined();
      expect(await store.findById('copy')).toMatchObject({ uid: 5 });
    });

    it('changes the copy another mail app saved again and skips one it deleted', async () => {
      const resaved = await setup({ draftUid: 12 });
      await resaved.provider.modify(['m2'], 'markRead');
      expect(resaved.fake.messageFlagsAdd).toHaveBeenCalledWith([12], ['\\Seen'], { uid: true });
      await resaved.provider.markReplied('m2', 'reply');
      expect(resaved.fake.messageFlagsAdd).toHaveBeenLastCalledWith(12, ['\\Answered'], { uid: true });

      const deleted = await setup();
      await deleted.provider.modify(['m1', 'm2'], 'markRead');
      expect(deleted.fake.messageFlagsAdd).toHaveBeenCalledTimes(1);
      expect(deleted.fake.messageFlagsAdd).toHaveBeenCalledWith([1], ['\\Seen'], { uid: true });
      expect(await deleted.store.findById('m2')).toBeUndefined();
    });

    it('reports a missing draft when updating one another mail app deleted', async () => {
      const { provider, fake } = await setup();

      await expect(
        provider.updateDraft('draft-1', {
          from: 'me@example.com',
          to: [{ email: 'you@example.com' }],
          body: { text: 'Updated' },
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(fake.messageDelete).not.toHaveBeenCalled();
    });

    it('forgets a message another mail app deleted when it is read', async () => {
      const { store, provider } = await setup();

      await expect(provider.getMessage('m2')).rejects.toMatchObject({ code: 'not_found' });
      await expect(provider.getDraft('draft-1')).rejects.toMatchObject({ code: 'not_found' });
      expect(await store.findById('m2')).toBeUndefined();
    });
  });

  it('keeps reply headers when updating a draft without APPENDUID', async () => {
    const store = new MemoryStore();
    const threadId = `ith_${createHash('sha256').update('<older@example.com>').digest('hex').slice(0, 24)}`;
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'Drafts',
      uidValidity: '1',
      uid: 7,
      messageId: '<old-draft@example.com>',
      inReplyTo: '<root@example.com>',
      references: ['<older@example.com>', '<root@example.com>'],
      threadId,
      draftId: 'draft-1',
    });
    const drafts = folder('Drafts');
    drafts.specialUse = '\\Drafts';
    let appended = Buffer.alloc(0);
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), drafts]),
      append: vi.fn(async (_path: string, raw: Buffer) => {
        appended = raw;
        return false as const;
      }),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      search: vi.fn().mockResolvedValue([8]),
      fetchOne: vi.fn(async (uid: number, query: { source?: boolean }) => {
        if (query.source) return { uid, source: appended };
        return {
          uid,
          envelope: { subject: 'Updated draft', messageId: '<new-draft@example.com>' },
          headers: appended.subarray(0, appended.indexOf('\r\n\r\n')),
          flags: new Set(['\\Draft']),
        };
      }),
      messageDelete: vi.fn(),
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    const updated = await provider.updateDraft('draft-1', {
      to: [{ email: 'you@example.com' }],
      subject: 'Updated draft',
      body: { text: 'Updated body' },
    });

    expect(fake.search).toHaveBeenCalled();
    // The search finds the new copy too, which the update must keep.
    expect(fake.messageDelete).toHaveBeenCalledWith('7', { uid: true });
    expect(appended.toString()).toMatch(/^In-Reply-To: <root@example.com>$/im);
    expect(appended.toString()).toMatch(/^References: <older@example.com> <root@example.com>$/im);
    expect(updated).toMatchObject({ id: 'm1', draftId: 'draft-1', threadId });
  });
});
