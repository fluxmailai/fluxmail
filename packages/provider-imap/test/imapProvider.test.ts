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

  function paginationProvider(initialUids: number[], listedFolders = [folder('INBOX'), folder('Sent')]) {
    const store = new MemoryStore();
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
        fake.mailbox = { uidValidity } as never;
        return { release: vi.fn() };
      }),
      search: vi.fn(async (_query: unknown) => uids),
      download: vi.fn(),
      messageFlagsAdd: vi.fn(),
      fetchOne: vi.fn(async (uid: number) => ({
        uid,
        envelope: { subject: `${selected}-${uid}`, messageId: `<${selected}-${uid}@example.com>` },
        headers: Buffer.from(`Message-ID: <${selected}-${uid}@example.com>\r\n`),
        flags: new Set<string>(),
        internalDate: new Date('2026-01-01T00:00:00Z'),
      })),
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
      search: fake.search,
      connect: fake.connect,
      fetchOne: fake.fetchOne,
      download: fake.download,
      messageFlagsAdd: fake.messageFlagsAdd,
    };
  }

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
    search.mockResolvedValueOnce([1]).mockReturnValueOnce(new Promise<number[]>(() => {}));

    const first = await provider.listMessages(
      {},
      { pageSize: 25, signal: new AbortController().signal, softDeadlineAt: Date.now() + 20 },
    );
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
    expect(fake.messageDelete).toHaveBeenCalledWith(7, { uid: true });
    expect(appended.toString()).toMatch(/^In-Reply-To: <root@example.com>$/im);
    expect(appended.toString()).toMatch(/^References: <older@example.com> <root@example.com>$/im);
    expect(updated).toMatchObject({ id: 'm1', draftId: 'draft-1', threadId });
  });
});
