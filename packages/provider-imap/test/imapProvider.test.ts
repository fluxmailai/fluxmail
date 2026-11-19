import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ImapFlow, ListResponse } from 'imapflow';
import type { Transporter } from 'nodemailer';
import { FolderNameError } from '@fluxmail/core';
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
  // The meta imapflow derives from the part's own MIME header.
  const download = vi.fn().mockResolvedValue({
    meta: { contentType: 'application/octet-stream', encoding },
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

  it('decodes an attachment the server returned with its parent multipart header', async () => {
    const { provider, download } = attachmentProvider(0, [], 'base64');
    // GreenMail returns the parent's header for a nested part, so the download leaves it base64.
    download.mockResolvedValue({
      meta: { contentType: 'multipart/related' },
      content: Readable.from([Buffer.from(Buffer.alloc(8, 1).toString('base64'))]),
    });

    await expect(provider.getAttachment('m1', '1', { maxBytes: 10 })).resolves.toMatchObject({
      content: Buffer.alloc(8, 1),
    });
    download.mockResolvedValue({
      meta: { contentType: 'multipart/related' },
      content: Readable.from([Buffer.from(Buffer.alloc(11, 1).toString('base64'))]),
    });
    await expect(provider.getAttachment('m1', '1', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 11, maxBytes: 10 },
    });
    // A stream past the encoded limit stops early and reports the decoded size read.
    download.mockResolvedValue({
      meta: { contentType: 'multipart/related' },
      content: Readable.from([Buffer.from(Buffer.alloc(300, 1).toString('base64')), Buffer.from('AQEB')]),
    });
    await expect(provider.getAttachment('m1', '1', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 300, maxBytes: 10 },
    });
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
  /** The UIDs fetched to read the message, leaving out the flag checks. */
  const envelopeFetches = (fake: { fetchOne: { mock: { calls: Array<[number, { envelope?: boolean }]> } } }) =>
    fake.fetchOne.mock.calls.filter(([, query]) => query.envelope).map(([uid]) => uid);
  type Download = 'replaced' | 'deleted' | 'expunging' | 'refused' | 'broken' | 'empty' | 'closed' | 'content';
  /**
   * A draft at UID 9. A "replaced" download, or a "flags-only" fetch, acts like
   * another mail app saving the draft again while Fluxmail reads it: the copy
   * Fluxmail fetched is gone and the next UID holds the same message.
   */
  const setup = ({
    downloads = [],
    fetches = [],
    deletedReplies = 'flags-only',
    attachment = false,
  }: {
    downloads?: Download[];
    /** What the server answers to fetches of the message, in order, before answering normally. */
    fetches?: Array<'flags-only'>;
    /** How a copy marked \\Deleted but not yet expunged answers a FETCH. */
    deletedReplies?: 'flags-only' | 'full';
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
    /** Copies another mail app marked \\Deleted and has not expunged yet. */
    const deleted = new Set<number>();
    const live = (uid: number) => uid === serverUid || appended.has(uid) || deleted.has(uid);
    /** Another mail app saves the draft again and marks the old copy \\Deleted. */
    const resave = () => {
      deleted.add(serverUid);
      serverUid += 1;
    };
    const download = vi.fn(async (uid: number) => {
      if (deleted.has(uid)) return {};
      const next = downloads.shift() ?? 'content';
      if (next === 'deleted') {
        resave();
        return {};
      }
      if (next === 'replaced' || next === 'expunging' || next === 'refused') serverUid += 1;
      // What a server answers when another session expunges the message during the fetch.
      if (next === 'refused')
        throw Object.assign(new Error('Command failed'), {
          responseStatus: 'NO',
          responseText: '[EXPUNGEISSUED] Some messages were expunged',
        });
      if (next === 'closed') {
        // ImapFlow reports why the connection closed on its error event, then clears the open folder.
        for (const handler of errorHandlers)
          handler(Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT', _connId: fake.id }));
        fake.mailbox = false;
      }
      // What ImapFlow throws when the reply for a message being expunged has no body structure.
      if (next === 'expunging' || next === 'broken')
        throw new TypeError("Cannot read properties of undefined (reading 'childNodes')");
      if (next !== 'content') return {};
      return { meta: {}, content: Readable.from([Buffer.from(`Body at ${uid}`)]) };
    });
    const errorHandlers: Array<(error: Error) => void> = [];
    const drafts = folder('Drafts');
    drafts.specialUse = '\\Drafts';
    const fake = {
      id: 'c-mid-read',
      usable: true,
      mailbox: { path: 'Drafts', uidValidity: 1n } as false | { path: string; uidValidity: bigint },
      capabilities: new Map(),
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === 'error') errorHandlers.push(handler);
      }),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('INBOX'), drafts]),
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { path: 'Drafts', uidValidity: 1n };
        return { release: vi.fn() };
      }),
      noop: vi.fn(),
      search: vi.fn(async () => [...deleted, serverUid]),
      fetchOne: vi.fn(async (uid: number, query: { envelope?: boolean; flags?: boolean }) => {
        if (!live(uid)) return false;
        const flags = new Set(deleted.has(uid) ? ['\\Draft', '\\Deleted'] : ['\\Draft']);
        if (!query.envelope && query.flags) return { uid, flags };
        if (deleted.has(uid) && deletedReplies === 'flags-only') return { uid, flags };
        if (!deleted.has(uid) && fetches.shift() === 'flags-only') {
          resave();
          return { uid, flags: new Set(['\\Draft', '\\Deleted']) };
        }
        return {
          uid,
          envelope: { subject: 'Draft', from: [{ name: 'Me', address: 'alias@example.com' }] },
          headers: Buffer.from('Message-ID: <draft@example.com>\r\n'),
          flags,
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
          deleted.delete(uid);
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
    const { store, provider, fake } = setup({ fetches: ['flags-only'] });

    await expect(provider.getDraft('draft-1')).resolves.toMatchObject({
      from: { email: 'alias@example.com' },
      body: { text: 'Body at 10' },
    });
    expect(await store.findById('m2')).toMatchObject({ uid: 10 });
    // The old copy keeps answering with flags until it is expunged, so the retry reads the new one.
    expect(envelopeFetches(fake)).toEqual([9, 10]);
  });

  it('reads the new copy when the old one still answers while marked deleted', async () => {
    const { store, provider, fake, download } = setup({ downloads: ['deleted', 'content'], deletedReplies: 'full' });

    await expect(provider.getDraft('draft-1')).resolves.toMatchObject({ body: { text: 'Body at 10' } });
    expect(envelopeFetches(fake)).toEqual([9, 10]);
    expect(download.mock.calls.map(([uid]) => uid)).toEqual([9, 10]);
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

  it('reports why the connection closed during the read', async () => {
    const { provider, download } = setup({ downloads: ['closed'] });

    await expect(provider.getMessage('m2')).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'IMAP/SMTP operation failed: Connection not available (Socket timeout)',
      failure: { provider: 'imap', phase: 'fetch', reason: 'connection_timeout' },
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

  it('reports a folder named after an object property as not found', async () => {
    const store = new MemoryStore();
    await store.save({ id: 'm1', accountId: 'a1', mailboxPath: 'INBOX', uidValidity: '1', uid: 7, threadId: 't1' });
    const messageMove = vi.fn();
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
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(),
      store,
      imapFactory: () => fake as unknown as ImapFlow,
    });

    for (const name of ['constructor', 'toString', '__proto__']) {
      await expect(provider.modify(['m1'], { move: name })).rejects.toMatchObject({
        code: 'not_found',
        message: `No folder named "${name}"`,
      });
      await expect(provider.listMessages({ folder: name })).rejects.toMatchObject({
        code: 'not_found',
        message: `No folder named "${name}"`,
      });
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

/** The bounds of a UID range such as 8001:10000 or 8001:*. */
function uidRange(range: string): [number, number] {
  const [lower, upper] = range.split(':');
  return [Number(lower), upper === '*' ? Infinity : Number(upper)];
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
        const [lower, upper] = uidRange(query.uid);
        const matches = uids.filter((uid) => uid >= lower && uid <= upper);
        // A range ending in * always includes the folder's last message.
        const last = Math.max(...uids);
        return upper === Infinity && uids.length && last < lower ? [last] : matches;
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
      fake,
      list: fake.list,
      getMailboxLock: fake.getMailboxLock,
      search: fake.search,
      connect: fake.connect,
      fetchOne: fake.fetchOne,
      fetch: fake.fetch,
      download: fake.download,
      messageFlagsAdd: fake.messageFlagsAdd,
    };
  }

  describe('folder listing reuse', () => {
    it('lists folders once for searches within a minute on the same connection', async () => {
      const { provider, list } = paginationProvider([2, 1]);
      const startedAt = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      try {
        await provider.listMessages({ folder: 'INBOX' });
        await provider.listMessages({ folder: 'Sent' });
        expect(list).toHaveBeenCalledOnce();

        clock.mockReturnValue(startedAt + 60_000);
        await provider.listMessages({ folder: 'INBOX' });
        expect(list).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }
    });

    it('lists folders again when a search names a folder the earlier listing lacks', async () => {
      const { provider, list } = paginationProvider([2, 1]);
      await provider.listMessages({ folder: 'INBOX' });
      list.mockResolvedValue([folder('INBOX'), folder('Sent'), folder('Receipts')]);

      const page = await provider.listMessages({ folder: 'Receipts' });

      expect(page.items.map((message) => message.subject)).toEqual(['Receipts-2', 'Receipts-1']);
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('still reports a folder that does not exist, after listing again', async () => {
      const { provider, list } = paginationProvider([2, 1]);
      await provider.listMessages({ folder: 'INBOX' });

      await expect(provider.listMessages({ folder: 'Missing' })).rejects.toMatchObject({ code: 'not_found' });
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('lists folders for every search of all folders, so one another mail app made is searched', async () => {
      const { provider, list } = paginationProvider([2, 1]);
      await provider.listMessages({ folder: 'INBOX' });
      list.mockResolvedValue([folder('INBOX'), folder('Sent'), folder('Receipts')]);

      const page = await provider.listMessages({}, { pageSize: 10 });

      expect(page.items.map((message) => message.subject)).toContain('Receipts-1');
      expect(list).toHaveBeenCalledTimes(2);
      await provider.listMessages({ folder: 'all' });
      expect(list).toHaveBeenCalledTimes(3);
    });

    function withoutOld() {
      const built = paginationProvider([2, 1], [folder('INBOX'), folder('Old')]);
      const select = built.getMailboxLock.getMockImplementation()!;
      // Another mail app deleted Old, which the server now refuses to open.
      built.getMailboxLock.mockImplementation(async (path: string) => {
        if (path === 'Old')
          throw Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'No such mailbox' });
        return select(path);
      });
      return built;
    }

    it('lists folders again when a folder from the earlier listing is gone', async () => {
      const { provider, list } = withoutOld();
      await provider.listMessages({ folder: 'INBOX' });
      list.mockResolvedValue([folder('INBOX')]);

      await expect(provider.listMessages({ folder: 'Old' })).rejects.toMatchObject({
        code: 'not_found',
        message: 'No folder named "Old"',
      });
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("reports the server's refusal when it closed the caller's connection", async () => {
      // Fluxmail Cloud closes a pooled connection whose folder would not open.
      const { provider, list, fake, getMailboxLock } = withoutOld();
      const signal = new AbortController().signal;
      await provider.listMessages({ folder: 'INBOX' }, { signal });
      const refuse = getMailboxLock.getMockImplementation()!;
      getMailboxLock.mockImplementation(async (path: string) => {
        try {
          return await refuse(path);
        } catch (error) {
          fake.usable = false;
          throw error;
        }
      });

      await expect(provider.listMessages({ folder: 'Old' }, { signal })).rejects.toMatchObject({
        code: 'provider_unavailable',
        failure: { phase: 'select', reason: 'server_no' },
      });
      expect(list).toHaveBeenCalledOnce();
    });

    it('searches again on a new connection when the server dropped the one with the listing', async () => {
      const { provider, list, search, connect } = paginationProvider([2, 1]);
      await provider.listMessages({ folder: 'INBOX' });
      search.mockRejectedValueOnce(Object.assign(new Error('Connection not available'), { code: 'NoConnection' }));

      const page = await provider.listMessages({ folder: 'INBOX' });

      expect(page.items.map((message) => message.subject)).toEqual(['INBOX-2', 'INBOX-1']);
      expect(list).toHaveBeenCalledTimes(2);
      expect(connect).toHaveBeenCalled();
    });

    it('does not open a connection for a search or flag change that close() interrupted', async () => {
      const { provider, list, search, connect, messageFlagsAdd } = movable();
      const dropped = () => Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
      await provider.listMessages({ folder: 'INBOX' });
      connect.mockClear();
      search.mockImplementationOnce(async () => {
        await provider.close();
        throw dropped();
      });
      await expect(provider.listMessages({ folder: 'INBOX' })).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(list).toHaveBeenCalledOnce();
      expect(connect).not.toHaveBeenCalled();

      await provider.listMessages({ folder: 'INBOX' });
      connect.mockClear();
      list.mockClear();
      messageFlagsAdd.mockImplementationOnce(async () => {
        await provider.close();
        throw dropped();
      });
      await expect(provider.modify(['m7'], 'markRead')).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(list).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });

    it('keeps a listing the server answered while a folder was being made from counting as newer', async () => {
      const first = paginationProvider([2, 1]);
      const second = paginationProvider([2, 1]);
      Object.assign(second.fake, { mailboxCreate: vi.fn(async (path: string) => ({ path, created: true })) });
      // In the past, so the change recorded for this account is over before later tests list folders.
      const startedAt = Date.now() - 30_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      try {
        second.list.mockResolvedValue([folder('INBOX'), folder('Sent'), folder('Receipts')]);
        // The answer arrives after the other connection made its folder.
        first.list.mockImplementationOnce(async () => {
          clock.mockReturnValue(startedAt + 1_000);
          await second.provider.createFolder('Receipts');
          clock.mockReturnValue(startedAt + 2_000);
          return [folder('INBOX'), folder('Sent')];
        });
        await first.provider.listMessages({ folder: 'INBOX' });

        clock.mockReturnValue(startedAt + 3_000);
        await first.provider.listMessages({ folder: 'INBOX' });
        expect(first.list).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }
    });

    it('continues a page token issued after a folder was added, on a connection that listed before it', async () => {
      const later = [folder('INBOX'), folder('Sent'), folder('Receipts')];
      const earlier = paginationProvider([2, 1]);
      await earlier.provider.listMessages({ folder: 'INBOX' });
      const first = await paginationProvider([2, 1], later).provider.listMessages({}, { pageSize: 1 });
      earlier.list.mockResolvedValue(later);

      const second = await earlier.provider.listMessages({}, { pageSize: 1, pageToken: first.nextPageToken });

      expect(second.items.map((message) => message.subject)).toEqual(['INBOX-1']);
      expect(earlier.list).toHaveBeenCalledTimes(2);
    });

    it("lists folders again on the account's other connections after it creates or deletes a folder", async () => {
      const first = paginationProvider([2, 1]);
      const second = paginationProvider([2, 1]);
      Object.assign(second.fake, { mailboxCreate: vi.fn(async (path: string) => ({ path, created: true })) });
      // In the past, so the change recorded for this account is over before later tests list folders.
      const startedAt = Date.now() - 10_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      try {
        await first.provider.listMessages({ folder: 'INBOX' });
        second.list.mockResolvedValue([folder('INBOX'), folder('Sent'), folder('Receipts')]);
        first.list.mockResolvedValue([folder('INBOX'), folder('Sent'), folder('Receipts')]);

        clock.mockReturnValue(startedAt + 1_000);
        await second.provider.createFolder('Receipts');
        clock.mockReturnValue(startedAt + 2_000);
        await first.provider.listMessages({ folder: 'INBOX' });
        expect(first.list).toHaveBeenCalledTimes(2);

        clock.mockReturnValue(startedAt + 3_000);
        await first.provider.listMessages({ folder: 'INBOX' });
        expect(first.list).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }
    });

    it("lists folders again on the account's other connections after it renames a folder", async () => {
      const listed = [folder('INBOX'), folder('Sent'), folder('Receipts')];
      const first = paginationProvider([2, 1], listed);
      const second = paginationProvider([2, 1], listed);
      Object.assign(second.fake, {
        namespace: { prefix: '', delimiter: '/' },
        mailboxRename: vi.fn(async (path: string, newPath: string) => {
          second.list.mockResolvedValue([folder('INBOX'), folder('Sent'), folder(newPath)]);
          return { path, newPath };
        }),
        mailboxSubscribe: vi.fn(async () => true),
        mailboxUnsubscribe: vi.fn(async () => true),
      });
      // In the past, so the change recorded for this account is over before later tests list folders.
      const startedAt = Date.now() - 20_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      try {
        await first.provider.listMessages({ folder: 'INBOX' });
        expect(first.list).toHaveBeenCalledOnce();

        clock.mockReturnValue(startedAt + 1_000);
        await second.provider.renameFolder('Receipts', 'Invoices');
        clock.mockReturnValue(startedAt + 2_000);
        await first.provider.listMessages({ folder: 'INBOX' });
        expect(first.list).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }
    });

    it('does not search twice when the failure is not about folders', async () => {
      const { provider, search } = paginationProvider([2, 1]);
      await provider.listMessages({ folder: 'INBOX' });
      search.mockClear();
      search.mockRejectedValue(Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' }));

      await expect(provider.listMessages({ folder: 'INBOX' })).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(search).toHaveBeenCalledOnce();
    });

    function movable(listedFolders = [folder('INBOX'), folder('Sent')]) {
      const store = new MemoryStore();
      for (const uid of [7, 8])
        store.rows.set(`m${uid}`, {
          id: `m${uid}`,
          accountId: 'a1',
          mailboxPath: 'INBOX',
          uidValidity: '1',
          uid,
          threadId: `t${uid}`,
        });
      const built = paginationProvider([8, 7], listedFolders, store);
      const messageMove = vi.fn(async (uids: number[]) => ({
        uidValidity: 9n,
        uidMap: new Map(uids.map((uid) => [uid, uid + 100])),
      }));
      Object.assign(built.fake, { noop: vi.fn(), messageMove });
      return { ...built, store, messageMove };
    }

    it('marks messages read without listing folders again', async () => {
      const { provider, list, messageFlagsAdd } = movable();
      await provider.listMessages({ folder: 'INBOX' });

      await provider.modify(['m7'], 'markRead');

      expect(messageFlagsAdd).toHaveBeenCalledWith([7], ['\\Seen'], { uid: true });
      expect(list).toHaveBeenCalledOnce();
    });

    it('marks messages read on a new connection when the server dropped the one with the listing', async () => {
      const { provider, list, messageFlagsAdd } = movable();
      await provider.listMessages({ folder: 'INBOX' });
      messageFlagsAdd.mockRejectedValueOnce(
        Object.assign(new Error('Connection not available'), { code: 'NoConnection' }),
      );

      await provider.modify(['m7'], 'markRead');

      expect(messageFlagsAdd).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('lists folders again before moving messages, in case another mail app changed them', async () => {
      const { provider, list, messageMove } = movable();
      await provider.listMessages({ folder: 'INBOX' });
      // Another mail app renamed Sent.
      list.mockResolvedValue([folder('INBOX'), folder('Sent mail')]);

      await expect(provider.modify(['m7'], { move: 'Sent' })).rejects.toMatchObject({ code: 'not_found' });
      expect(messageMove).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('saves the new locations of moved messages together when the store can', async () => {
      const { provider, store } = movable();
      const save = vi.spyOn(store, 'save');
      const saveMany = vi.fn(async (rows: ImapMessageLocation[]) => {
        for (const row of rows) store.rows.set(row.id, row);
      });
      Object.assign(store, { saveMany });

      await provider.modify(['m7', 'm8'], { move: 'Sent' });

      expect(saveMany).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      expect(store.rows.get('m7')).toMatchObject({ mailboxPath: 'Sent', uidValidity: '9', uid: 107 });
      expect(store.rows.get('m8')).toMatchObject({ mailboxPath: 'Sent', uidValidity: '9', uid: 108 });
    });

    it('always asks the server when listing folders', async () => {
      const { provider, list } = paginationProvider([1]);
      await provider.listMessages({ folder: 'INBOX' });
      await provider.listFolders();
      await provider.listFolders();
      expect(list).toHaveBeenCalledTimes(3);
    });

    it('keeps the listing on the connection when the caller wraps it', async () => {
      // Fluxmail Cloud hands the provider a new wrapper around a pooled connection for each call.
      const { fake, list } = paginationProvider([2, 1]);
      const wrapped = () =>
        new ImapProvider({
          accountId: 'a1',
          email: 'me@example.com',
          credentials: testCredentials(),
          store: new MemoryStore(),
          imapFactory: () =>
            new Proxy(fake, {
              get: (target, property) => Reflect.get(target, property, target),
            }) as unknown as ImapFlow,
        });

      await wrapped().listMessages({ folder: 'INBOX' });
      await wrapped().listMessages({ folder: 'Sent' });

      expect(list).toHaveBeenCalledOnce();
    });
  });

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

  it('searches past ten folders until the soft deadline', async () => {
    const folders = Array.from({ length: 12 }, (_, index) => folder(`Folder ${index + 1}`));
    const { provider, search } = paginationProvider([], folders);

    const page = await provider.listMessages({}, { pageSize: 1, softDeadlineAt: Date.now() + 60_000 });
    expect(page).toMatchObject({ exhausted: true, items: [] });
    expect(page.incomplete).toBeUndefined();
    expect(page.nextPageToken).toBeUndefined();
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

  it('fetches a slow page in batches that stop near the soft deadline', async () => {
    const uids = Array.from({ length: 150 }, (_, index) => 150 - index);
    const { provider, fetch } = paginationProvider(uids, [folder('INBOX')]);
    const startedAt = Date.now();
    let now = startedAt;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const batched = fetch.getMockImplementation()!;
    // A server that takes 270 ms per message to answer a FETCH.
    fetch.mockImplementation((range: string, ...rest: [unknown, unknown]) => {
      now += 270 * range.split(',').length;
      return batched(range, ...rest);
    });
    const softDeadlineAt = startedAt + 15_000;

    const first = await provider
      .listMessages({ folder: 'INBOX' }, { pageSize: 100, softDeadlineAt })
      .finally(() => clock.mockRestore());

    const sizes = fetch.mock.calls.map((call) => (call[0] as string).split(',').length);
    expect(sizes[0]).toBe(20);
    expect(now).toBeGreaterThanOrEqual(softDeadlineAt);
    expect(now).toBeLessThan(softDeadlineAt + 1_000);
    expect(first.items).toHaveLength(sizes.reduce((total, size) => total + size, 0));
    expect(first.items.length).toBeLessThan(100);
    expect(first.incompleteReason).toBe('time_limit');

    const second = await provider.listMessages({ folder: 'INBOX' }, { pageSize: 100, pageToken: first.nextPageToken });
    expect(second.items[0]!.subject).toBe(`INBOX-${150 - first.items.length}`);
  });

  it('paces filtered fetches by the soft deadline, up to batches of 50', async () => {
    const uids = Array.from({ length: 120 }, (_, index) => 120 - index);
    const { provider, fetch } = paginationProvider(uids, [folder('INBOX')]);
    const startedAt = Date.now();
    let now = startedAt;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const batched = fetch.getMockImplementation()!;
    fetch.mockImplementation((range: string, ...rest: [unknown, unknown]) => {
      now += 100 * range.split(',').length;
      return batched(range, ...rest);
    });

    const page = await provider
      .listMessages({ folder: 'INBOX', after: '2027-01-01' }, { pageSize: 10, softDeadlineAt: startedAt + 9_000 })
      .finally(() => clock.mockRestore());

    // 20 candidates take 2 s; the 7 s left would fit 70, so the cap of 50 applies.
    // That leaves 2 s, which fits 20 more before the deadline.
    expect(fetch.mock.calls.map((call) => (call[0] as string).split(',').length)).toEqual([20, 50, 20]);
    expect(page.items).toEqual([]);
    expect(page.inspectedCandidates).toBe(90);
    expect(page.incompleteReason).toBe('time_limit');
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
    expect(search.mock.calls.map(([query]) => query.uid)).toEqual(['8001:*', '1:8000', '1:1200']);
    expect(search.mock.calls.every(([query]) => (query as { text?: string }).text === 'invoice')).toBe(true);
  });

  it('finds mail delivered to a large folder after the connection opened it', async () => {
    // The folder's next UID is read when it is opened, so 10,500 arrived later.
    const { provider } = paginationProvider([10_500, 9_500, 3_000], [folder('INBOX')], undefined, {
      uidNext: 10_001,
      exists: 10_000,
    });

    const page = await provider.listMessages(
      { folder: 'INBOX', text: 'invoice' },
      { pageSize: 2, softDeadlineAt: Date.now() + 60_000 },
    );

    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-10500', 'INBOX-9500']);
  });

  it('lists a message once when the newest range starts above the last message', async () => {
    // Messages above 7,000 were removed after the folder was opened.
    const { provider } = paginationProvider([7_000, 3_000], [folder('INBOX')], undefined, {
      uidNext: 10_001,
      exists: 10_000,
    });

    const page = await provider.listMessages(
      { folder: 'INBOX', text: 'invoice' },
      { pageSize: 5, softDeadlineAt: Date.now() + 60_000 },
    );

    expect(page.items.map((message) => message.subject)).toEqual(['INBOX-7000', 'INBOX-3000']);
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
    expect(search.mock.calls.map(([query]) => query.uid)).toEqual(['8001:*', '6001:8000', '1:6000']);
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
      const [lower, upper] = uidRange(query.uid!);
      return (upper === Infinity ? 200_000 : upper) - lower + 1;
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
  it.each([
    { structure: true, replaced: false },
    { structure: false, replaced: false },
    { structure: true, replaced: true },
  ])('reads threading headers without downloading the body: %j', async ({ structure, replaced }) => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'INBOX',
      uidValidity: '1',
      uid: 7,
      threadId: 't1',
      messageId: '<root@example.com>',
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
      search: vi.fn().mockResolvedValue([8]),
      fetchOne: vi.fn(async (uid: number, query: { source?: boolean }) =>
        uid !== (replaced ? 8 : 7)
          ? false
          : query.source
            ? { uid, source }
            : {
                uid,
                envelope: { subject: 'Original' },
                headers: Buffer.from('message-id: <root@example.com>\r\nreferences: <older@example.com>\r\n'),
                flags: new Set<string>(),
                ...(structure ? { bodyStructure: { part: '1', type: 'text/plain' } } : {}),
              },
      ),
      download: vi.fn().mockRejectedValue(new Error('Original body unavailable')),
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
    expect(raw).toMatch(/^Subject: Re: Original$/im);
    expect(fake.download).not.toHaveBeenCalled();
    expect(fake.fetchOne).toHaveBeenCalledTimes(replaced ? 2 : 1);
    expect(fake.fetchOne).toHaveBeenCalledWith(replaced ? 8 : 7, expect.objectContaining({ headers: true }), {
      uid: true,
    });
    expect((await store.findById('m1'))?.uid).toBe(replaced ? 8 : 7);
  });

  it('rejects a reply to an unknown original before sending', async () => {
    const sendMail = vi.fn();
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: testCredentials(false),
      store: new MemoryStore(),
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
    });
    await expect(
      provider.send({ to: [{ email: 'you@example.com' }], replyToMessageId: 'missing', body: { text: 'Reply' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(sendMail).not.toHaveBeenCalled();
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

  it('searches likely folders first and returns an incomplete thread at the search deadline', async () => {
    const store = new MemoryStore();
    await store.save({
      id: 'm1',
      accountId: 'a1',
      mailboxPath: 'Projects',
      uidValidity: '1',
      uid: 1,
      messageId: '<root@example.com>',
      threadId: 'thread-root',
    });
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const searched: string[] = [];
    const fake = {
      usable: true,
      mailbox: false as false | { path: string; uidValidity: bigint },
      capabilities: new Map(),
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([folder('Alpha'), folder('Beta'), folder('INBOX'), folder('Projects')]),
      getMailboxLock: vi.fn(async (path: string) => {
        fake.mailbox = { path, uidValidity: 1n };
        return { release: vi.fn() };
      }),
      search: vi.fn(async () => {
        if (!fake.mailbox) return [];
        searched.push(fake.mailbox.path);
        now += 10_000;
        // The inbox holds a reply, found before the deadline stops the search.
        return fake.mailbox.path === 'INBOX' ? [2] : [];
      }),
      fetchOne: vi.fn(async (uid: number, query: { source?: boolean }) => {
        const headers =
          uid === 1
            ? 'Message-ID: <root@example.com>\r\n'
            : 'Message-ID: <reply@example.com>\r\nIn-Reply-To: <root@example.com>\r\n';
        return query.source
          ? {
              uid,
              source: Buffer.from(`${headers}Subject: Message ${uid}\r\nContent-Type: text/plain\r\n\r\nBody ${uid}`),
            }
          : {
              uid,
              envelope: { subject: `Message ${uid}` },
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

    try {
      const thread = await provider.getThread('thread-root', { searchDeadlineAt: 15_000 });
      expect(thread.messages.map((message) => message.subject)).toEqual(['Message 1', 'Message 2']);
      expect(thread.incomplete).toBe(true);
      expect(searched.sort()).toEqual(['INBOX', 'Projects']);

      // A later page reads only what the first page stored, without searching again.
      searched.length = 0;
      const later = await provider.getThread('thread-root', { storedOnly: true });
      expect(later.messages.map((message) => message.subject)).toEqual(['Message 1', 'Message 2']);
      expect(searched).toEqual([]);

      now = 1_000;
      const complete = await provider.getThread('thread-root');
      expect(complete.incomplete).toBeUndefined();
      expect(searched).toHaveLength(4);
    } finally {
      clock.mockRestore();
    }
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

describe('ImapProvider sender name', () => {
  function providerWith(options: Partial<ConstructorParameters<typeof ImapProvider>[0]> = {}) {
    return new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: {
        imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
        smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
        saveSent: false,
      },
      store: new MemoryStore(),
      ...options,
    });
  }

  it('reports the account name for the default sender, and none without one', async () => {
    await expect(providerWith({ displayName: 'Me Myself' }).senderName()).resolves.toBe('Me Myself');
    await expect(providerWith().senderName()).resolves.toBeUndefined();
  });

  it('reports the configured name of an explicit sender, and none when it is unknown or unnamed', async () => {
    const provider = providerWith({
      displayName: 'Me Myself',
      resolveSender: (email) =>
        email === 'sales@example.com'
          ? { email, name: 'Sales' }
          : email === 'support@example.com'
            ? { email }
            : undefined,
    });

    await expect(provider.senderName('sales@example.com')).resolves.toBe('Sales');
    await expect(provider.senderName('support@example.com')).resolves.toBeUndefined();
    await expect(provider.senderName('stranger@example.com')).resolves.toBeUndefined();
    // Without a resolver an explicit sender goes out as a bare address.
    await expect(providerWith({ displayName: 'Me Myself' }).senderName('sales@example.com')).resolves.toBeUndefined();
  });

  it('rejects when the lookup throws, so the caller shows no name', async () => {
    const provider = providerWith({
      resolveSender: () => {
        throw new Error('database unavailable');
      },
    });

    await expect(provider.senderName('sales@example.com')).rejects.toThrow('database unavailable');
  });

  it('reports the name the sent message carries', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.com>' });
    const provider = providerWith({
      displayName: 'Me Myself',
      smtpFactory: () => ({ sendMail }) as unknown as Transporter,
      resolveSender: (email) => (email === 'sales@example.com' ? { email, name: 'Sales' } : undefined),
    });

    for (const from of [undefined, 'sales@example.com']) {
      await provider.send({ ...(from ? { from } : {}), to: [{ email: 'you@example.com' }], body: { text: 'Body' } });
      const raw = (sendMail.mock.lastCall![0] as { raw: Buffer }).raw.toString();
      expect(raw).toContain(`From: ${await provider.senderName(from)} <${from ?? 'me@example.com'}>`);
    }
  });
});

describe('ImapProvider folder creation', () => {
  function mailbox(path: string, delimiter: string, flags: string[] = [], specialUse?: string): ListResponse {
    const levels = path.split(delimiter);
    return {
      path,
      pathAsListed: path,
      name: levels.at(-1)!,
      delimiter,
      parent: levels.slice(0, -1),
      parentPath: levels.slice(0, -1).join(delimiter),
      flags: new Set(flags),
      ...(specialUse ? { specialUse, specialUseSource: 'extension' as const } : {}),
      listed: true,
      subscribed: true,
    };
  }

  function creator(
    options: {
      delimiter?: string;
      paths?: string[];
      listing?: ListResponse[];
      namespace?: { prefix: string; delimiter: string };
      overrides?: Record<string, string>;
    } = {},
  ) {
    const delimiter = options.delimiter ?? '/';
    const listing = options.listing ?? [
      mailbox('INBOX', delimiter),
      mailbox('Sent Messages', delimiter, [], '\\Sent'),
      mailbox('Deleted Messages', delimiter, [], '\\Trash'),
      ...(options.paths ?? []).map((path) => mailbox(path, delimiter)),
    ];
    const mailboxCreate = vi.fn(async (path: string) => {
      if (listing.some((entry) => entry.path === path)) return { path, created: false };
      listing.push(mailbox(path, delimiter));
      return { path, created: true };
    });
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      namespace: options.namespace ?? { prefix: '', delimiter },
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list: vi.fn(async () => [...listing]),
      mailboxCreate,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: { ...testCredentials(), ...(options.overrides ? { folderOverrides: options.overrides } : {}) },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });
    return { provider, mailboxCreate, listing, fake };
  }

  it('creates a top-level folder and returns it as folder listings show it', async () => {
    const { provider, mailboxCreate } = creator();

    await expect(provider.createFolder('  Receipts ')).resolves.toEqual({ id: 'Receipts', name: 'Receipts' });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith('Receipts');
    await expect(provider.listFolders()).resolves.toContainEqual({ id: 'Receipts', name: 'Receipts' });
  });

  it('creates missing parents with the server separator', async () => {
    const { provider, mailboxCreate } = creator({ delimiter: '.', paths: ['Projects'] });

    await expect(provider.createFolder('Projects.2026.Q1')).resolves.toEqual({
      id: 'Projects.2026.Q1',
      name: 'Projects.2026.Q1',
    });
    expect(mailboxCreate.mock.calls).toEqual([['Projects.2026'], ['Projects.2026.Q1']]);
  });

  it('keeps a slash in the name when the server separates levels with a dot', async () => {
    const { provider, mailboxCreate } = creator({ delimiter: '.' });

    await expect(provider.createFolder('Clients/Acme')).resolves.toMatchObject({ id: 'Clients/Acme' });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith('Clients/Acme');
  });

  it('adds the namespace prefix a server keeps folders under', async () => {
    const { provider, mailboxCreate } = creator({
      delimiter: '.',
      namespace: { prefix: 'INBOX.', delimiter: '.' },
      paths: ['INBOX.Projects'],
    });

    await expect(provider.createFolder('Projects.2026')).resolves.toEqual({
      id: 'INBOX.Projects.2026',
      name: 'INBOX.Projects.2026',
    });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith('INBOX.Projects.2026');
    await expect(provider.createFolder('Projects')).resolves.toMatchObject({ id: 'INBOX.Projects' });
    expect(mailboxCreate).toHaveBeenCalledOnce();
  });

  it('returns an existing folder without creating it', async () => {
    const { provider, mailboxCreate } = creator({ paths: ['Receipts', 'Réunions'.normalize('NFD')] });

    await expect(provider.createFolder('Receipts')).resolves.toEqual({ id: 'Receipts', name: 'Receipts' });
    await expect(provider.createFolder('Réunions')).resolves.toMatchObject({ id: 'Réunions'.normalize('NFD') });
    expect(mailboxCreate).not.toHaveBeenCalled();
  });

  it('returns the folder when the server refuses an existing name with a plain NO', async () => {
    const { provider, mailboxCreate, listing } = creator();
    mailboxCreate.mockImplementationOnce(async (path: string) => {
      // Another mail app created it after Fluxmail listed the folders.
      listing.push(mailbox('receipts', '/'));
      throw Object.assign(new Error('Command failed'), {
        responseStatus: 'NO',
        responseText: `Mailbox ${path} already exists`,
      });
    });

    await expect(provider.createFolder('Receipts')).resolves.toEqual({ id: 'receipts', name: 'receipts' });
  });

  it.each(['inbox', 'Trash', 'SENT', 'Starred'])('rejects the folder role %s', async (name) => {
    const { provider, mailboxCreate } = creator();

    await expect(provider.createFolder(name)).rejects.toBeInstanceOf(FolderNameError);
    expect(mailboxCreate).not.toHaveBeenCalled();
  });

  it('rejects an existing folder that holds a role', async () => {
    const { provider, mailboxCreate } = creator();

    await expect(provider.createFolder('Sent Messages')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Sent Messages" is the sent folder. Choose another name.',
    });
    expect(mailboxCreate).not.toHaveBeenCalled();
  });

  it('rejects a name the server would read as a role folder', async () => {
    const { provider, mailboxCreate } = creator({
      listing: [mailbox('INBOX', '/'), mailbox('Junk', '/'), mailbox('Old', '/')],
    });

    // A second junk folder by name leaves the spam folder ambiguous.
    await expect(provider.createFolder('Spam')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(provider.createFolder('Deleted Items')).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'A folder named "Deleted Items" would be used as the trash folder. Choose another name.',
    });
    await expect(provider.createFolder('Old/Junk Mail')).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Creating "Old/Junk Mail" would make it unclear which folder is the spam folder. Choose another name.',
    });
    expect(mailboxCreate).not.toHaveBeenCalled();
  });

  it('checks every missing parent it would create', async () => {
    const { provider, mailboxCreate } = creator({ listing: [mailbox('INBOX', '/'), mailbox('Spam', '/')] });

    // Neither parent exists, and each would be read as a role folder by its name.
    await expect(provider.createFolder('Trash/Old')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Trash" is a system folder. Choose another name.',
    });
    await expect(provider.createFolder('Deleted Items/Old')).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'A folder named "Deleted Items" would be used as the trash folder. Choose another name.',
    });
    await expect(provider.createFolder('Junk/2026')).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Creating "Junk/2026" would make it unclear which folder is the spam folder. Choose another name.',
    });
    expect(mailboxCreate).not.toHaveBeenCalled();
  });

  it('creates subfolders of INBOX in any case without creating INBOX', async () => {
    const { provider, mailboxCreate } = creator();

    await expect(provider.createFolder('inbox/Receipts')).resolves.toMatchObject({ id: 'INBOX/Receipts' });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith('INBOX/Receipts');
  });

  it('reads an INBOX namespace prefix in any case', async () => {
    const { provider, mailboxCreate } = creator({
      delimiter: '.',
      listing: [mailbox('INBOX', '.')],
      namespace: { prefix: 'INBOX.', delimiter: '.' },
    });

    await expect(provider.createFolder('inbox.Projects')).resolves.toMatchObject({ id: 'INBOX.Projects' });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith('INBOX.Projects');
  });

  it('drops spaces around each level', async () => {
    const { provider, mailboxCreate } = creator({ paths: ['Projects'] });

    await expect(provider.createFolder('Projects / 2026')).resolves.toMatchObject({ id: 'Projects/2026' });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith('Projects/2026');
    await expect(provider.createFolder(' Projects /2026 ')).resolves.toMatchObject({ id: 'Projects/2026' });
    expect(mailboxCreate).toHaveBeenCalledOnce();
  });

  it('creates a subfolder under the parent as the server spells it', async () => {
    const decomposed = 'Re\u0301unions';
    const { provider, mailboxCreate } = creator({ paths: [decomposed] });

    await expect(provider.createFolder('R\u00e9unions/2026')).resolves.toMatchObject({ id: `${decomposed}/2026` });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith(`${decomposed}/2026`);
  });

  it.each(['Papierkorb', 'Bin', 'Corbeille'])(
    'rejects %j, which the next folder listing would read as the trash folder',
    async (name) => {
      const { provider, mailboxCreate } = creator({ listing: [mailbox('INBOX', '/'), mailbox('Trash', '/')] });

      await expect(provider.createFolder(name)).rejects.toBeInstanceOf(FolderNameError);
      expect(mailboxCreate).not.toHaveBeenCalled();
    },
  );

  it('creates the folder a configured override names', async () => {
    const { provider, mailboxCreate } = creator({ paths: ['Archives'], overrides: { archive: 'Archives/2026' } });

    await expect(provider.createFolder('Archives/2026')).resolves.toMatchObject({
      id: 'Archives/2026',
      role: 'archive',
      roleSource: 'user',
    });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith('Archives/2026');
    // A repeat, such as a retry after a lost response, returns the same folder.
    await expect(provider.createFolder('Archives/2026')).resolves.toMatchObject({
      id: 'Archives/2026',
      role: 'archive',
      roleSource: 'user',
    });
    expect(mailboxCreate).toHaveBeenCalledOnce();
  });

  it('refuses a subfolder of a mailbox that cannot have folders inside it', async () => {
    const { provider, mailboxCreate } = creator({
      listing: [mailbox('INBOX', '/'), mailbox('Projects', '/', ['\\Noinferiors'])],
    });

    await expect(provider.createFolder('Projects/2026')).rejects.toMatchObject({
      code: 'invalid_request',
      message: `The mail server doesn't allow folders inside "Projects". Choose another parent folder.`,
    });
    expect(mailboxCreate).not.toHaveBeenCalled();
  });

  it('reports a dropped connection when imapflow sends no CREATE', async () => {
    const { provider, mailboxCreate } = creator();
    mailboxCreate.mockResolvedValueOnce(undefined as never);

    await expect(provider.createFolder('Receipts')).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { reason: 'connection_reset' },
    });
  });

  it('does not take a folder that differs in case for the new one when the refusal has another code', async () => {
    const { provider, mailboxCreate } = creator({ paths: ['receipts'] });
    mailboxCreate.mockRejectedValueOnce(
      Object.assign(new Error('Command failed'), { responseStatus: 'NO', serverResponseCode: 'CANNOT' }),
    );

    await expect(provider.createFolder('Receipts')).rejects.toBeInstanceOf(FolderNameError);
  });

  it('does not create the levels of a namespace prefix', async () => {
    const { provider, mailboxCreate } = creator({
      listing: [mailbox('INBOX', '/')],
      namespace: { prefix: 'mail/', delimiter: '/' },
    });

    await expect(provider.createFolder('Projects/2026')).resolves.toMatchObject({ id: 'mail/Projects/2026' });
    expect(mailboxCreate.mock.calls).toEqual([['mail/Projects'], ['mail/Projects/2026']]);
  });

  it('allows a role name under a parent when the server flags its special folders', async () => {
    const { provider } = creator({ paths: ['Clients'] });

    await expect(provider.createFolder('Clients/Sent')).resolves.toMatchObject({ id: 'Clients/Sent' });
  });

  it('rejects a name that clashes with a mailbox that cannot hold messages', async () => {
    const { provider, mailboxCreate } = creator({
      listing: [mailbox('INBOX', '/'), mailbox('Shared', '/', ['\\Noselect', '\\HasChildren'])],
    });

    await expect(provider.createFolder('Shared')).rejects.toMatchObject({
      code: 'invalid_request',
      message: `A folder named "Shared" exists but can't hold messages.`,
    });
    expect(mailboxCreate).not.toHaveBeenCalled();
    // A parent that can't hold messages can still hold folders.
    await expect(provider.createFolder('Shared/Team')).resolves.toMatchObject({ id: 'Shared/Team' });
    expect(mailboxCreate).toHaveBeenCalledExactlyOnceWith('Shared/Team');
  });

  it.each(['Projects/', '/Projects', 'Projects//2026', 'Receipts*', '100%'])(
    'rejects the name %j before contacting the server',
    async (name) => {
      const { provider, mailboxCreate } = creator();

      await expect(provider.createFolder(name)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(mailboxCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ serverResponseCode: 'CANNOT', responseText: 'private reason' }, 'invalid_request', ' (CANNOT)'],
    [{ responseText: 'private reason' }, 'invalid_request', ''],
  ])('reports the refused name %o without the server text', async (reply, code, suffix) => {
    const { provider, mailboxCreate } = creator();
    mailboxCreate.mockRejectedValueOnce(Object.assign(new Error('Command failed'), { responseStatus: 'NO', ...reply }));

    const error = await provider.createFolder('Receipts').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({
      code,
      message:
        `The mail server would not create the folder "Receipts"${suffix}. ` +
        'The server may not allow the name, or may have reached a folder limit. ' +
        'Try a different name once; if that also fails, the limit is the likely cause.',
      failure: { provider: 'imap', phase: 'folders', reason: 'server_no' },
    });
  });

  it.each([
    [{ serverResponseCode: 'NOPERM', responseText: 'private reason' }, 'permission_denied'],
    [{ serverResponseCode: 'OVERQUOTA', responseText: 'Too many folders' }, 'provider_unavailable'],
  ])('maps the server refusal %o to %s', async (reply, code) => {
    const { provider, mailboxCreate } = creator();
    mailboxCreate.mockRejectedValueOnce(Object.assign(new Error('Command failed'), { responseStatus: 'NO', ...reply }));

    const error = await provider.createFolder('Receipts').catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({ code, failure: { provider: 'imap', phase: 'folders' } });
  });

  it('reports a dropped connection as unavailable', async () => {
    const { provider, mailboxCreate } = creator();
    mailboxCreate.mockRejectedValueOnce(Object.assign(new Error('Connection not available'), { code: 'NoConnection' }));

    await expect(provider.createFolder('Receipts')).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { reason: 'connection_reset' },
    });
  });

  it('moves messages into a folder it just created', async () => {
    const { provider, fake } = creator();
    const store = new MemoryStore();
    store.rows.set('m1', { id: 'm1', accountId: 'a1', mailboxPath: 'INBOX', uidValidity: '1', uid: 7, threadId: 't1' });
    const messageMove = vi.fn().mockResolvedValue({ uidValidity: 9n, uidMap: new Map([[7, 3]]) });
    Object.assign(fake, {
      getMailboxLock: vi.fn(async () => {
        fake.mailbox = { uidValidity: 1n } as never;
        return { release: vi.fn() };
      }),
      noop: vi.fn(),
      search: vi.fn().mockResolvedValue([7]),
      messageMove,
    });
    (provider as unknown as { options: { store: MemoryStore } }).options.store = store;

    const folder = await provider.createFolder('Receipts');
    await provider.modify(['m1'], { move: folder.name });
    expect(messageMove).toHaveBeenCalledWith([7], 'Receipts', { uid: true });
    expect(store.rows.get('m1')).toMatchObject({ mailboxPath: 'Receipts', uid: 3 });
  });
});

describe('ImapProvider folder deletion', () => {
  function mailbox(path: string, delimiter: string, flags: string[] = [], specialUse?: string): ListResponse {
    const levels = path.split(delimiter);
    return {
      path,
      pathAsListed: path,
      name: levels.at(-1)!,
      delimiter,
      parent: levels.slice(0, -1),
      parentPath: levels.slice(0, -1).join(delimiter),
      flags: new Set(flags),
      ...(specialUse ? { specialUse, specialUseSource: 'extension' as const } : {}),
      listed: true,
      subscribed: true,
    };
  }

  function serverError(serverResponseCode?: string) {
    return Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: 'private server reply',
      ...(serverResponseCode ? { serverResponseCode } : {}),
    });
  }

  function deleter(
    options: {
      delimiter?: string;
      listing?: ListResponse[];
      paths?: string[];
      counts?: Record<string, number>;
      overrides?: Record<string, string>;
      prefix?: string;
    } = {},
  ) {
    const delimiter = options.delimiter ?? '/';
    const listing = options.listing ?? [
      mailbox('INBOX', delimiter),
      mailbox('Sent Messages', delimiter, [], '\\Sent'),
      mailbox('Deleted Messages', delimiter, [], '\\Trash'),
      ...(options.paths ?? []).map((path) => mailbox(path, delimiter)),
    ];
    const counts = options.counts ?? {};
    const calls: string[] = [];
    const list = vi.fn(async () => {
      calls.push('LIST');
      return [...listing];
    });
    const status = vi.fn(async (path: string) => {
      calls.push(`STATUS ${path}`);
      return { path, messages: counts[path] ?? 0 };
    });
    const mailboxDelete = vi.fn(async (path: string) => {
      calls.push(`DELETE ${path}`);
      const index = listing.findIndex((entry) => entry.path === path);
      if (index < 0) throw serverError('NONEXISTENT');
      listing.splice(index, 1);
      return { path };
    });
    const mailboxUnsubscribe = vi.fn(async (path: string) => {
      calls.push(`UNSUBSCRIBE ${path}`);
      return true;
    });
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      namespace: { prefix: options.prefix ?? '', delimiter },
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list,
      status,
      mailboxDelete,
      mailboxUnsubscribe,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: { ...testCredentials(), ...(options.overrides ? { folderOverrides: options.overrides } : {}) },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });
    return { provider, listing, counts, list, status, mailboxDelete, mailboxUnsubscribe, calls };
  }

  it('deletes an empty folder after counting its messages, and drops the cached folders', async () => {
    const { provider, calls } = deleter({ paths: ['Receipts'] });
    await provider.listFolders();
    calls.length = 0;

    await expect(provider.deleteFolder(' Receipts ')).resolves.toEqual({ id: 'Receipts', name: 'Receipts' });
    // The folders are listed again, STATUS runs right before DELETE, and the folders are listed once more.
    expect(calls).toEqual(['LIST', 'STATUS Receipts', 'DELETE Receipts', 'LIST', 'UNSUBSCRIBE Receipts']);
    const cached = (provider as unknown as { resolved?: { selectablePaths: string[] } }).resolved;
    expect(cached?.selectablePaths).not.toContain('Receipts');
    expect((await provider.listFolders()).map((folder) => folder.id)).not.toContain('Receipts');
  });

  it('keeps a delete that went through when the server refuses to unsubscribe', async () => {
    const { provider, mailboxUnsubscribe } = deleter({ paths: ['Receipts'] });
    mailboxUnsubscribe.mockRejectedValueOnce(serverError());

    await expect(provider.deleteFolder('Receipts')).resolves.toEqual({ id: 'Receipts', name: 'Receipts' });
  });

  it('lists the folders again when DELETE fails, and does not unsubscribe', async () => {
    const { provider, mailboxDelete, mailboxUnsubscribe } = deleter({ paths: ['Receipts'] });
    mailboxDelete.mockRejectedValueOnce(serverError());

    await expect(provider.deleteFolder('Receipts')).rejects.toMatchObject({ code: 'invalid_request' });
    const cached = (provider as unknown as { resolved?: { selectablePaths: string[] } }).resolved;
    expect(cached?.selectablePaths).toContain('Receipts');
    expect(mailboxUnsubscribe).not.toHaveBeenCalled();
  });

  it('reports a folder deleted between the listing and the count as not found', async () => {
    const { provider, status, mailboxDelete } = deleter({ paths: ['Receipts'] });
    status.mockRejectedValueOnce(Object.assign(new Error("Mailbox doesn't exist: Receipts"), { code: 'NotFound' }));

    await expect(provider.deleteFolder('Receipts')).rejects.toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no folder named "Receipts".',
    });
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('deletes a listed folder whose name is a role word when another folder holds that role', async () => {
    const { provider, mailboxDelete } = deleter({
      listing: [
        mailbox('INBOX', '/'),
        mailbox('Junk', '/', [], '\\Junk'),
        mailbox('Spam Old', '/'),
        mailbox('Starred', '/'),
      ],
    });

    await expect(provider.deleteFolder('Starred')).resolves.toMatchObject({ id: 'Starred' });
    await expect(provider.deleteFolder('spam')).rejects.toMatchObject({
      message: '"Junk" is a system folder and can\'t be deleted.',
    });
    expect(mailboxDelete).toHaveBeenCalledOnce();
  });

  it('finds the folder by a name in another Unicode form', async () => {
    const { provider, mailboxDelete } = deleter({ paths: ['Réunions'.normalize('NFD')] });

    await expect(provider.deleteFolder('Réunions'.normalize('NFC'))).resolves.toMatchObject({
      id: 'Réunions'.normalize('NFD'),
    });
    expect(mailboxDelete).toHaveBeenCalledExactlyOnceWith('Réunions'.normalize('NFD'));
  });

  it('refuses a folder that still has messages', async () => {
    const { provider, mailboxDelete } = deleter({ paths: ['Receipts', 'One'], counts: { Receipts: 12, One: 1 } });

    await expect(provider.deleteFolder('Receipts')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Receipts" still has 12 messages. Move or trash them first.',
    });
    await expect(provider.deleteFolder('One')).rejects.toMatchObject({
      message: '"One" still has 1 message. Move or trash it first.',
    });
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('refuses a folder with subfolders without counting its messages', async () => {
    const { provider, status, mailboxDelete } = deleter({ delimiter: '.', paths: ['Projects', 'Projects.2026'] });

    await expect(provider.deleteFolder('Projects')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Projects" has subfolders. Delete them first.',
    });
    expect(status).not.toHaveBeenCalled();
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('refuses a folder the server flags as having children it did not list', async () => {
    const { provider, mailboxDelete } = deleter({
      listing: [mailbox('INBOX', '/'), mailbox('Shared', '/', ['\\HasChildren'])],
    });

    await expect(provider.deleteFolder('Shared')).rejects.toMatchObject({
      message: '"Shared" has subfolders. Delete them first.',
    });
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('deletes a \\Noselect parent once its subfolders are gone, without STATUS', async () => {
    const { provider, status, mailboxDelete } = deleter({
      listing: [mailbox('INBOX', '/'), mailbox('Projects', '/', ['\\Noselect']), mailbox('Projects/2026', '/')],
    });

    await expect(provider.deleteFolder('Projects')).rejects.toMatchObject({
      message: '"Projects" has subfolders. Delete them first.',
    });
    await expect(provider.deleteFolder('Projects/2026')).resolves.toMatchObject({ id: 'Projects/2026' });
    await expect(provider.deleteFolder('Projects')).resolves.toEqual({ id: 'Projects', name: 'Projects' });
    expect(status.mock.calls.map(([path]) => path)).toEqual(['Projects/2026']);
    expect(mailboxDelete.mock.calls.map(([path]) => path)).toEqual(['Projects/2026', 'Projects']);
  });

  it.each(['inbox', 'INBOX', 'Trash', 'sent', 'Archive', 'starred', 'all'])(
    'refuses the folder role or inbox %s',
    async (name) => {
      const { provider, status, mailboxDelete } = deleter();

      await expect(provider.deleteFolder(name)).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining("is a system folder and can't be deleted."),
      });
      expect(status).not.toHaveBeenCalled();
      expect(mailboxDelete).not.toHaveBeenCalled();
    },
  );

  it('refuses a folder that holds a role by its flag or its name', async () => {
    const { provider, mailboxDelete } = deleter({
      listing: [
        mailbox('INBOX', '/'),
        mailbox('Sent Messages', '/', [], '\\Sent'),
        mailbox('All Mail', '/', [], '\\All'),
        mailbox('Junk', '/'),
      ],
    });

    for (const name of ['Sent Messages', 'All Mail', 'Junk']) {
      await expect(provider.deleteFolder(name), name).rejects.toMatchObject({
        message: `"${name}" is a system folder and can't be deleted.`,
      });
    }
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('refuses a folder a configured override names, even one the server no longer lets hold messages', async () => {
    const { provider, mailboxDelete } = deleter({
      listing: [mailbox('INBOX', '/'), mailbox('Old Archive', '/'), mailbox('Gone', '/', ['\\Noselect'])],
      overrides: { archive: 'Old Archive', trash: 'Gone' },
    });

    await expect(provider.deleteFolder('Old Archive')).rejects.toMatchObject({
      code: 'invalid_request',
      message:
        '"Old Archive" is set as this account\'s archive folder, so deleting it would break that setting. Choose another archive folder for the account first.',
    });
    await expect(provider.deleteFolder('Gone')).rejects.toMatchObject({
      message: expect.stringContaining("is set as this account's trash folder"),
    });
    // A role word names the role's folder, so the override still explains the refusal.
    await expect(provider.deleteFolder('archive')).rejects.toMatchObject({
      message: expect.stringContaining('"Old Archive" is set as this account\'s archive folder'),
    });
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('reports a folder that does not exist as not found', async () => {
    const { provider, mailboxDelete } = deleter({ paths: ['Receipts'] });

    await expect(provider.deleteFolder('Missing')).rejects.toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no folder named "Missing".',
    });
    await expect(provider.deleteFolder('   ')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('reports a folder another mail app deleted after the listing as not found', async () => {
    const { provider, mailboxDelete } = deleter({ paths: ['Receipts'] });
    mailboxDelete.mockRejectedValueOnce(serverError('NONEXISTENT'));

    await expect(provider.deleteFolder('Receipts')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps NOPERM to permission_denied without the server text', async () => {
    const { provider, mailboxDelete } = deleter({ paths: ['Shared'] });
    mailboxDelete.mockRejectedValueOnce(serverError('NOPERM'));

    const error = await provider.deleteFolder('Shared').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({
      code: 'permission_denied',
      message: 'The mail server does not allow deleting the folder "Shared".',
    });
    expect((error as Error).message).not.toContain('private server reply');
  });

  it.each(['UNAVAILABLE', 'INUSE', 'SERVERBUG', 'LIMIT'])(
    'keeps the temporary response code %s as provider_unavailable',
    async (code) => {
      const { provider, mailboxDelete } = deleter({ paths: ['Receipts'] });
      mailboxDelete.mockRejectedValueOnce(serverError(code));

      const error = await provider.deleteFolder('Receipts').catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(FolderNameError);
      expect(error).toMatchObject({ code: 'provider_unavailable' });
    },
  );

  it('refuses with a Fluxmail message when the server says no without a reason', async () => {
    const { provider, mailboxDelete } = deleter({ paths: ['Receipts', 'Odd'] });
    mailboxDelete.mockRejectedValueOnce(serverError()).mockRejectedValueOnce(serverError('HASCHILDREN'));

    await expect(provider.deleteFolder('Receipts')).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'The mail server would not delete the folder "Receipts".',
    });
    await expect(provider.deleteFolder('Odd')).rejects.toMatchObject({
      message: '"Odd" has subfolders. Delete them first.',
    });
  });

  it('does not delete a folder whose messages the server would not count', async () => {
    const { provider, status, mailboxDelete, list } = deleter({ paths: ['Receipts'] });
    // imapflow answers false when the server refuses STATUS, or when the connection dropped.
    status.mockResolvedValueOnce(false as never);
    status.mockResolvedValueOnce({ path: 'Receipts' } as never);

    const refused = await provider.deleteFolder('Receipts').catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(FolderNameError);
    expect(refused).toMatchObject({
      code: 'invalid_request',
      message:
        'The mail server would not count the messages in "Receipts", so the folder was not deleted. This account may not be allowed to read it.',
    });
    await expect(provider.deleteFolder('Receipts')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(mailboxDelete).not.toHaveBeenCalled();
    // Nothing changed on the server, so the folders are not listed again after a refusal.
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('reports a connection that dropped during the count', async () => {
    const { provider, status, mailboxDelete } = deleter({ paths: ['Receipts'] });
    status.mockImplementationOnce(async function (this: { usable: boolean }) {
      this.usable = false;
      return false;
    } as never);

    await expect(provider.deleteFolder('Receipts')).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { reason: 'connection_reset' },
    });
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('finds a folder by its name without the namespace prefix', async () => {
    const { provider, mailboxDelete } = deleter({
      delimiter: '.',
      prefix: 'INBOX.',
      listing: [mailbox('INBOX', '.'), mailbox('INBOX.Receipts', '.')],
    });

    await expect(provider.deleteFolder('Receipts')).resolves.toMatchObject({ id: 'INBOX.Receipts' });
    expect(mailboxDelete).toHaveBeenCalledExactlyOnceWith('INBOX.Receipts');
  });

  it('refuses a folder outside the personal namespace, which imapflow would rename on the wire', async () => {
    const { provider, status, mailboxDelete } = deleter({
      delimiter: '.',
      prefix: 'INBOX.',
      listing: [mailbox('INBOX', '.'), mailbox('Shared.Team', '.'), mailbox('INBOX.Shared.Team', '.')],
    });

    await expect(provider.deleteFolder('Shared.Team')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Shared.Team" is outside this account\'s own folders, so Fluxmail can\'t delete it.',
    });
    expect(status).not.toHaveBeenCalled();
    expect(mailboxDelete).not.toHaveBeenCalled();
  });

  it('reports a connection that closed before DELETE was sent', async () => {
    const { provider, mailboxDelete } = deleter({ paths: ['Receipts'] });
    mailboxDelete.mockResolvedValueOnce(undefined as never);

    await expect(provider.deleteFolder('Receipts')).rejects.toMatchObject({
      code: 'provider_unavailable',
      failure: { reason: 'connection_reset' },
    });
  });
});

describe('ImapProvider folder renaming', () => {
  function mailbox(
    path: string,
    delimiter: string,
    flags: string[] = [],
    specialUse?: string,
    subscribed = true,
  ): ListResponse {
    const levels = path.split(delimiter);
    return {
      path,
      pathAsListed: path,
      name: levels.at(-1)!,
      delimiter,
      parent: levels.slice(0, -1),
      parentPath: levels.slice(0, -1).join(delimiter),
      flags: new Set(flags),
      ...(specialUse ? { specialUse, specialUseSource: 'extension' as const } : {}),
      listed: true,
      subscribed,
    };
  }

  function serverError(serverResponseCode?: string) {
    return Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: 'private server reply',
      ...(serverResponseCode ? { serverResponseCode } : {}),
    });
  }

  function renamer(
    options: {
      delimiter?: string;
      listing?: ListResponse[];
      paths?: string[];
      overrides?: Record<string, string>;
      prefix?: string;
    } = {},
  ) {
    const delimiter = options.delimiter ?? '/';
    const listing = options.listing ?? [
      mailbox('INBOX', delimiter),
      mailbox('Sent Messages', delimiter, [], '\\Sent'),
      mailbox('Deleted Messages', delimiter, [], '\\Trash'),
      ...(options.paths ?? []).map((path) => mailbox(path, delimiter)),
    ];
    const calls: string[] = [];
    const list = vi.fn(async () => {
      calls.push('LIST');
      return [...listing];
    });
    // Like RENAME, the mailboxes inside the renamed one move with it.
    const mailboxRename = vi.fn(async (path: string, newPath: string) => {
      calls.push(`RENAME ${path} ${newPath}`);
      if (!listing.some((entry) => entry.path === path)) throw serverError('NONEXISTENT');
      if (listing.some((entry) => entry.path === newPath)) throw serverError('ALREADYEXISTS');
      for (const [index, entry] of listing.entries()) {
        if (entry.path !== path && !entry.path.startsWith(`${path}${delimiter}`)) continue;
        listing[index] = mailbox(
          `${newPath}${entry.path.slice(path.length)}`,
          delimiter,
          [...entry.flags],
          undefined,
          false,
        );
      }
      return { path, newPath };
    });
    const mailboxUnsubscribe = vi.fn(async (path: string) => {
      calls.push(`UNSUBSCRIBE ${path}`);
      return true;
    });
    const mailboxSubscribe = vi.fn(async (path: string) => {
      calls.push(`SUBSCRIBE ${path}`);
      return true;
    });
    const fake = {
      usable: true,
      mailbox: false,
      capabilities: new Map(),
      namespace: { prefix: options.prefix ?? '', delimiter },
      on: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(),
      list,
      mailboxRename,
      mailboxUnsubscribe,
      mailboxSubscribe,
    };
    const provider = new ImapProvider({
      accountId: 'a1',
      email: 'me@example.com',
      credentials: { ...testCredentials(), ...(options.overrides ? { folderOverrides: options.overrides } : {}) },
      store: new MemoryStore(),
      imapFactory: () => fake as unknown as ImapFlow,
    });
    return { provider, listing, list, mailboxRename, mailboxUnsubscribe, mailboxSubscribe, calls, fake };
  }

  it('renames a folder, moves its subscription and lists it under its new path', async () => {
    const { provider, calls } = renamer({ paths: ['Receipts'] });
    await provider.listFolders();
    calls.length = 0;

    await expect(provider.renameFolder(' Receipts ', ' Invoices ')).resolves.toEqual({
      folder: { id: 'Invoices', name: 'Invoices' },
      previous: { id: 'Receipts', name: 'Receipts' },
    });
    expect(calls).toEqual(['LIST', 'RENAME Receipts Invoices', 'LIST', 'UNSUBSCRIBE Receipts', 'SUBSCRIBE Invoices']);
    const ids = (await provider.listFolders()).map((folder) => folder.id);
    expect(ids).toContain('Invoices');
    expect(ids).not.toContain('Receipts');
  });

  it('keeps a subfolder under its parent and carries its own subfolders along', async () => {
    const { provider, calls, listing } = renamer({
      delimiter: '.',
      paths: ['Projects', 'Projects.2025', 'Projects.2025.Q1', 'Projects.2025x'],
    });

    await expect(provider.renameFolder('Projects.2025', '2026')).resolves.toEqual({
      folder: { id: 'Projects.2026', name: 'Projects.2026' },
      previous: { id: 'Projects.2025', name: 'Projects.2025' },
    });
    expect(calls).toContain('RENAME Projects.2025 Projects.2026');
    expect(calls.filter((call) => call.includes('SUBSCRIBE'))).toEqual([
      'UNSUBSCRIBE Projects.2025',
      'SUBSCRIBE Projects.2026',
      'UNSUBSCRIBE Projects.2025.Q1',
      'SUBSCRIBE Projects.2026.Q1',
    ]);
    expect(listing.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['Projects', 'Projects.2026', 'Projects.2026.Q1', 'Projects.2025x']),
    );
  });

  it('finds a folder under the namespace prefix and keeps the prefix on the new name', async () => {
    const { provider, mailboxRename } = renamer({
      delimiter: '.',
      prefix: 'INBOX.',
      listing: [mailbox('INBOX', '.'), mailbox('INBOX.Receipts', '.'), mailbox('Shared.Team', '.')],
    });

    await expect(provider.renameFolder('Receipts', 'Invoices')).resolves.toMatchObject({
      folder: { id: 'INBOX.Invoices' },
      previous: { id: 'INBOX.Receipts' },
    });
    expect(mailboxRename).toHaveBeenCalledWith('INBOX.Receipts', 'INBOX.Invoices');
    await expect(provider.renameFolder('Shared.Team', 'Crew')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Shared.Team" is outside this account\'s own folders, so Fluxmail can\'t rename it.',
    });
    expect(mailboxRename).toHaveBeenCalledOnce();
  });

  it('moves stored message locations with the folder, and keeps the rename when the store fails', async () => {
    const { provider } = renamer({ delimiter: '.', paths: ['Projects', 'Projects.2025'] });
    const store = (provider as unknown as { options: { store: ImapStateStore } }).options.store;
    const renameMailbox = vi.fn(async () => undefined);
    store.renameMailbox = renameMailbox;

    await provider.renameFolder('Projects', 'Work');
    expect(renameMailbox).toHaveBeenCalledWith('Projects', 'Work', '.');

    renameMailbox.mockRejectedValueOnce(new Error('private database error'));
    await expect(provider.renameFolder('Work', 'Jobs')).resolves.toMatchObject({ folder: { id: 'Jobs' } });
  });

  it('does not move stored locations when the rename fails', async () => {
    const { provider, mailboxRename } = renamer({ paths: ['Receipts'] });
    const store = (provider as unknown as { options: { store: ImapStateStore } }).options.store;
    const renameMailbox = vi.fn(async () => undefined);
    store.renameMailbox = renameMailbox;
    mailboxRename.mockRejectedValueOnce(serverError());

    await expect(provider.renameFolder('Receipts', 'Invoices')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(renameMailbox).not.toHaveBeenCalled();
  });

  it('leaves subscriptions alone for a folder that was not subscribed', async () => {
    const { provider, mailboxUnsubscribe, mailboxSubscribe } = renamer({
      listing: [mailbox('INBOX', '/'), mailbox('Receipts', '/', [], undefined, false)],
    });

    await provider.renameFolder('Receipts', 'Invoices');

    expect(mailboxUnsubscribe).not.toHaveBeenCalled();
    expect(mailboxSubscribe).not.toHaveBeenCalled();
  });

  it('keeps a rename that went through when the server refuses the subscription change', async () => {
    const { provider, mailboxSubscribe } = renamer({ paths: ['Receipts'] });
    mailboxSubscribe.mockRejectedValueOnce(serverError());

    await expect(provider.renameFolder('Receipts', 'Invoices')).resolves.toMatchObject({
      folder: { id: 'Invoices' },
    });
  });

  it('refuses a name another folder has, but allows a change of case', async () => {
    const { provider, mailboxRename } = renamer({ paths: ['Receipts', 'Invoices'] });

    await expect(provider.renameFolder('Receipts', 'Invoices')).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'A folder named "Invoices" already exists. Choose another name.',
    });
    await expect(provider.renameFolder('Receipts', 'invoices')).rejects.toMatchObject({
      message: 'A folder named "Invoices" already exists. Choose another name.',
    });
    expect(mailboxRename).not.toHaveBeenCalled();
    await expect(provider.renameFolder('Receipts', 'RECEIPTS')).resolves.toMatchObject({
      folder: { id: 'RECEIPTS' },
    });
  });

  it('returns the folder unchanged when the name is the one it has', async () => {
    const { provider, mailboxRename } = renamer({ paths: ['Receipts'] });

    await expect(provider.renameFolder('Receipts', 'Receipts')).resolves.toEqual({
      folder: { id: 'Receipts', name: 'Receipts' },
      previous: { id: 'Receipts', name: 'Receipts' },
    });
    expect(mailboxRename).not.toHaveBeenCalled();
  });

  it('refuses system folders and folders the account settings use', async () => {
    const { provider, mailboxRename } = renamer({
      paths: ['Receipts', 'Filed', 'Filed/2026', 'Parent', 'Parent/Old Mail'],
      overrides: { archive: 'Filed', trash: 'Parent/Old Mail' },
    });

    for (const folder of ['INBOX', 'inbox', 'Sent Messages', 'sent', 'Deleted Messages', 'starred']) {
      await expect(provider.renameFolder(folder, 'Mine')).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining("is a system folder and can't be renamed"),
      });
    }
    await expect(provider.renameFolder('Filed', 'Kept')).rejects.toMatchObject({
      message:
        '"Filed" is set as this account\'s archive folder, so renaming it would break that setting. Choose another archive folder for the account first.',
    });
    // Renaming a parent would change the path of the folder the setting names.
    await expect(provider.renameFolder('Parent', 'Elder')).rejects.toMatchObject({
      message: expect.stringContaining('"Parent" holds this account\'s trash folder'),
    });
    await expect(provider.renameFolder('Filed/2026', '2027')).resolves.toMatchObject({
      folder: { id: 'Filed/2027' },
    });
    expect(mailboxRename).toHaveBeenCalledOnce();
  });

  it('refuses a folder that holds a setting written in another case', async () => {
    const { provider, mailboxRename } = renamer({
      paths: ['Projects', 'Projects/Archive'],
      overrides: { archive: 'projects/archive' },
    });

    await expect(provider.renameFolder('Projects', 'Work')).rejects.toMatchObject({
      message: expect.stringContaining('"Projects" holds this account\'s archive folder'),
    });
    expect(mailboxRename).not.toHaveBeenCalled();
  });

  it('returns the renamed folder when the folders cannot be listed again', async () => {
    const { provider, list } = renamer({ paths: ['Receipts'] });
    const store = (provider as unknown as { options: { store: ImapStateStore } }).options.store;
    const renameMailbox = vi.fn(async () => undefined);
    store.renameMailbox = renameMailbox;
    const listed = list.getMockImplementation()!;
    let calls = 0;
    list.mockImplementation(async () => {
      if (++calls > 1) throw Object.assign(new Error('private socket closed'), { code: 'ECONNRESET' });
      return listed();
    });

    await expect(provider.renameFolder('Receipts', 'Invoices')).resolves.toEqual({
      folder: { id: 'Invoices', name: 'Invoices' },
      previous: { id: 'Receipts', name: 'Receipts' },
    });
    expect(renameMailbox).toHaveBeenCalledWith('Receipts', 'Invoices', '/');
  });

  it('refuses names that are empty, contain the separator, or would take a role', async () => {
    const { provider, mailboxRename } = renamer({ paths: ['Receipts', 'Projects/2025'] });

    await expect(provider.renameFolder('Receipts', 'Money/Receipts')).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('can\'t contain "/"'),
    });
    for (const name of ['', '  ', 'a\tb', 'Rece*pts', '100%', 'Inbox', 'Trash', 'archive']) {
      await expect(provider.renameFolder('Receipts', name)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(mailboxRename).not.toHaveBeenCalled();
    // A role word is only a system folder at the top level.
    await expect(provider.renameFolder('Projects/2025', 'Sent')).resolves.toMatchObject({
      folder: { id: 'Projects/Sent' },
    });
  });

  it('refuses a name the next listing would read as a role folder', async () => {
    const { provider, mailboxRename } = renamer({ listing: [mailbox('INBOX', '/'), mailbox('Receipts', '/')] });

    await expect(provider.renameFolder('Receipts', 'Papierkorb')).rejects.toBeInstanceOf(FolderNameError);
    expect(mailboxRename).not.toHaveBeenCalled();
  });

  it('reports a folder that does not exist, or is gone by the time it is renamed', async () => {
    const { provider, mailboxRename } = renamer({ paths: ['Receipts'] });

    await expect(provider.renameFolder('Missing', 'Found')).rejects.toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no folder named "Missing".',
    });
    mailboxRename.mockRejectedValueOnce(serverError('NONEXISTENT'));
    await expect(provider.renameFolder('Receipts', 'Invoices')).rejects.toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no folder named "Receipts".',
    });
  });

  it('says why the server refused, without the server text, and lists the folders again', async () => {
    const { provider, mailboxRename, mailboxUnsubscribe } = renamer({ paths: ['Receipts'] });

    mailboxRename.mockRejectedValueOnce(serverError());
    const plain = (await provider.renameFolder('Receipts', 'Invoices').catch((caught: unknown) => caught)) as Error;
    expect(plain).toMatchObject({
      code: 'invalid_request',
      message:
        'The mail server would not rename the folder "Receipts" to "Invoices". The server may not allow the name.',
    });
    mailboxRename.mockRejectedValueOnce(serverError('ALREADYEXISTS'));
    await expect(provider.renameFolder('Receipts', 'Invoices')).rejects.toMatchObject({
      message: 'A folder named "Invoices" already exists. Choose another name.',
    });
    mailboxRename.mockRejectedValueOnce(serverError('NOPERM'));
    await expect(provider.renameFolder('Receipts', 'Invoices')).rejects.toMatchObject({
      code: 'permission_denied',
      message: 'The mail server does not allow renaming the folder "Receipts".',
    });
    mailboxRename.mockRejectedValueOnce(serverError('CANNOT'));
    const coded = (await provider.renameFolder('Receipts', 'Invoices').catch((caught: unknown) => caught)) as Error;
    expect(coded.message).toContain('(CANNOT)');
    for (const error of [plain, coded]) expect(error.message).not.toContain('private');
    const cached = (provider as unknown as { resolved?: { selectablePaths: string[] } }).resolved;
    expect(cached?.selectablePaths).toContain('Receipts');
    expect(mailboxUnsubscribe).not.toHaveBeenCalled();
  });

  it('reports a dropped connection as unavailable, not as a refused name', async () => {
    const { provider, mailboxRename } = renamer({ paths: ['Receipts'] });

    mailboxRename.mockRejectedValueOnce(Object.assign(new Error('private socket closed'), { code: 'ECONNRESET' }));
    const dropped = (await provider.renameFolder('Receipts', 'Invoices').catch((caught: unknown) => caught)) as Error;
    expect(dropped).not.toBeInstanceOf(FolderNameError);
    expect(dropped).toMatchObject({ code: 'provider_unavailable' });

    mailboxRename.mockResolvedValueOnce(undefined as never);
    await expect(provider.renameFolder('Receipts', 'Invoices')).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('counts a rename the server applied before the connection dropped', async () => {
    const { provider, mailboxRename, mailboxSubscribe } = renamer({
      delimiter: '.',
      paths: ['Receipts', 'Receipts.Old'],
    });
    const store = (provider as unknown as { options: { store: ImapStateStore } }).options.store;
    const renameMailbox = vi.fn(async () => undefined);
    store.renameMailbox = renameMailbox;
    const rename = mailboxRename.getMockImplementation()!;
    mailboxRename.mockImplementationOnce(async (path: string, newPath: string) => {
      await rename(path, newPath);
      throw Object.assign(new Error('private socket closed'), { code: 'ECONNRESET' });
    });

    await expect(provider.renameFolder('Receipts', 'Invoices')).resolves.toEqual({
      folder: { id: 'Invoices', name: 'Invoices' },
      previous: { id: 'Receipts', name: 'Receipts' },
    });
    expect(renameMailbox).toHaveBeenCalledWith('Receipts', 'Invoices', '.');
    expect(mailboxSubscribe.mock.calls.map(([path]) => path)).toEqual(['Invoices', 'Invoices.Old']);
  });

  it('says so when the server answers OK but the folder is not at its new path', async () => {
    const { provider, mailboxRename } = renamer({ delimiter: '.', paths: ['Shelf', 'Shelf.Receipts'] });
    const store = (provider as unknown as { options: { store: ImapStateStore } }).options.store;
    const renameMailbox = vi.fn(async () => undefined);
    store.renameMailbox = renameMailbox;
    // Some servers rename only within the same parent, whatever path they are given.
    mailboxRename.mockImplementationOnce(async (path: string, newPath: string) => ({ path, newPath }));

    const error = (await provider.moveFolder('Shelf.Receipts', null).catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(FolderNameError);
    expect(error.message).toBe(
      'The mail server answered that it moved "Shelf.Receipts", but lists no folder at "Receipts". The folder may now be somewhere else, since some servers only rename a folder within its parent. List the folders to find it, and list its messages again for their IDs.',
    );
    expect(renameMailbox).not.toHaveBeenCalled();
  });

  describe('moving', () => {
    it('moves a folder under another one, with its subfolders, subscriptions and stored locations', async () => {
      const { provider, calls } = renamer({
        delimiter: '.',
        paths: ['Projects', 'Projects.2025', 'Projects.2025.Q1', 'Archive'],
      });
      const store = (provider as unknown as { options: { store: ImapStateStore } }).options.store;
      const renameMailbox = vi.fn(async () => undefined);
      store.renameMailbox = renameMailbox;

      await expect(provider.moveFolder('Projects.2025', 'Archive')).resolves.toEqual({
        folder: { id: 'Archive.2025', name: 'Archive.2025' },
        previous: { id: 'Projects.2025', name: 'Projects.2025' },
      });
      expect(calls).toContain('RENAME Projects.2025 Archive.2025');
      expect(calls.filter((call) => call.includes('SUBSCRIBE'))).toEqual([
        'UNSUBSCRIBE Projects.2025',
        'SUBSCRIBE Archive.2025',
        'UNSUBSCRIBE Projects.2025.Q1',
        'SUBSCRIBE Archive.2025.Q1',
      ]);
      expect(renameMailbox).toHaveBeenCalledWith('Projects.2025', 'Archive.2025', '.');
      const ids = (await provider.listFolders()).map((folder) => folder.id);
      expect(ids).toEqual(expect.arrayContaining(['Projects', 'Archive.2025', 'Archive.2025.Q1']));
    });

    it('moves a folder to the top level, which is the namespace prefix when the server has one', async () => {
      const plain = renamer({ paths: ['Projects', 'Projects/2025'] });
      await expect(plain.provider.moveFolder('Projects/2025', null)).resolves.toMatchObject({
        folder: { id: '2025' },
      });

      const prefixed = renamer({
        delimiter: '.',
        prefix: 'INBOX.',
        listing: [mailbox('INBOX', '.'), mailbox('INBOX.Projects', '.'), mailbox('INBOX.Projects.2025', '.')],
      });
      await expect(prefixed.provider.moveFolder('Projects.2025', null)).resolves.toMatchObject({
        folder: { id: 'INBOX.2025' },
      });
      expect(prefixed.mailboxRename).toHaveBeenCalledWith('INBOX.Projects.2025', 'INBOX.2025');
    });

    it('returns the folder unchanged when it is already there', async () => {
      const { provider, mailboxRename } = renamer({ paths: ['Projects', 'Projects/2025', 'Receipts'] });

      await expect(provider.moveFolder('Projects/2025', 'Projects')).resolves.toEqual({
        folder: { id: 'Projects/2025', name: 'Projects/2025' },
        previous: { id: 'Projects/2025', name: 'Projects/2025' },
      });
      await expect(provider.moveFolder('Receipts', null)).resolves.toMatchObject({ folder: { id: 'Receipts' } });
      expect(mailboxRename).not.toHaveBeenCalled();
    });

    it('refuses a destination that is the folder itself, inside it, the trash, or one that holds no folders', async () => {
      const { provider, mailboxRename } = renamer({
        listing: [
          mailbox('INBOX', '/'),
          mailbox('Deleted Messages', '/', [], '\\Trash'),
          mailbox('Projects', '/'),
          mailbox('Projects/2025', '/'),
          mailbox('Flat', '/', ['\\Noinferiors']),
          mailbox('Receipts', '/'),
        ],
      });

      await expect(provider.moveFolder('Projects', 'Projects')).rejects.toMatchObject({
        code: 'invalid_request',
        message: '"Projects" can\'t be moved into itself.',
      });
      await expect(provider.moveFolder('Projects', 'Projects/2025')).rejects.toMatchObject({
        message: '"Projects/2025" is inside "Projects", so "Projects" can\'t be moved into it.',
      });
      for (const parent of ['trash', 'Deleted Messages']) {
        await expect(provider.moveFolder('Receipts', parent)).rejects.toMatchObject({
          message: '"Deleted Messages" is the trash folder, so a folder can\'t be moved into it.',
        });
      }
      await expect(provider.moveFolder('Receipts', 'Flat')).rejects.toMatchObject({
        message: expect.stringContaining('doesn\'t allow folders inside "Flat"'),
      });
      for (const parent of ['', '  ']) {
        await expect(provider.moveFolder('Receipts', parent)).rejects.toMatchObject({ code: 'invalid_request' });
      }
      expect(mailboxRename).not.toHaveBeenCalled();
    });

    it('refuses system folders, folders a setting uses, and a name the destination already has', async () => {
      const { provider, mailboxRename } = renamer({
        paths: ['Filed', 'Receipts', 'Projects', 'Projects/Receipts', 'Projects/Sent'],
        overrides: { archive: 'Filed' },
      });

      for (const folder of ['inbox', 'Sent Messages']) {
        await expect(provider.moveFolder(folder, 'Projects')).rejects.toMatchObject({
          message: expect.stringContaining("is a system folder and can't be moved"),
        });
      }
      await expect(provider.moveFolder('Filed', 'Projects')).rejects.toMatchObject({
        message: expect.stringContaining('so moving it would break that setting'),
      });
      await expect(provider.moveFolder('Receipts', 'Projects')).rejects.toMatchObject({
        message: 'A folder named "Projects/Receipts" already exists there. Rename one of the two before moving.',
      });
      // At the top level the folder's name would read as the sent folder.
      await expect(provider.moveFolder('Projects/Sent', null)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(mailboxRename).not.toHaveBeenCalled();
    });

    it('refuses folders in the trash, as the folder or the destination', async () => {
      const { provider, mailboxRename } = renamer({
        listing: [
          mailbox('INBOX', '/'),
          mailbox('Deleted Messages', '/', [], '\\Trash'),
          mailbox('Deleted Messages/Old', '/'),
          mailbox('Receipts', '/'),
        ],
      });

      await expect(provider.moveFolder('Receipts', 'Deleted Messages/Old')).rejects.toMatchObject({
        message: '"Deleted Messages/Old" is in the trash, so a folder can\'t be moved into it.',
      });
      await expect(provider.moveFolder('Deleted Messages/Old', null)).rejects.toMatchObject({
        message: '"Deleted Messages/Old" is in the trash, so it can\'t be moved.',
      });
      expect(mailboxRename).not.toHaveBeenCalled();
    });

    it("refuses other users' and shared folders when the account's own folders have no prefix", async () => {
      const { provider, mailboxRename, fake } = renamer({
        paths: ['Receipts', 'shared/team', 'Other Users/sam'],
      });
      (fake as unknown as { namespaces: unknown }).namespaces = {
        personal: [{ prefix: '', delimiter: '/' }],
        other: [{ prefix: 'Other Users/', delimiter: '/' }],
        shared: [{ prefix: 'shared/', delimiter: '/' }],
      };

      for (const parent of ['shared/team', 'Other Users/sam']) {
        await expect(provider.moveFolder('Receipts', parent)).rejects.toMatchObject({
          message: `"${parent}" is outside this account's own folders, so Fluxmail can't move a folder into it.`,
        });
      }
      await expect(provider.moveFolder('shared/team', null)).rejects.toMatchObject({
        message: '"shared/team" is outside this account\'s own folders, so Fluxmail can\'t move it.',
      });
      await expect(provider.renameFolder('shared/team', 'crew')).rejects.toMatchObject({
        message: '"shared/team" is outside this account\'s own folders, so Fluxmail can\'t rename it.',
      });
      expect(mailboxRename).not.toHaveBeenCalled();
    });

    it('takes INBOX as a destination only when folders live under an INBOX prefix', async () => {
      const personal = renamer({
        delimiter: '/',
        prefix: 'Personal/',
        listing: [mailbox('INBOX', '/'), mailbox('Personal/Work', '/')],
      });
      await expect(personal.provider.moveFolder('Personal/Work', 'INBOX')).rejects.toMatchObject({
        message: '"INBOX" is outside this account\'s own folders, so Fluxmail can\'t move a folder into it.',
      });
      expect(personal.mailboxRename).not.toHaveBeenCalled();

      const inbox = renamer({
        delimiter: '.',
        prefix: 'INBOX.',
        listing: [mailbox('INBOX', '.'), mailbox('INBOX.Work', '.'), mailbox('INBOX.Work.2025', '.')],
      });
      await expect(inbox.provider.moveFolder('INBOX.Work.2025', 'INBOX')).resolves.toMatchObject({
        folder: { id: 'INBOX.2025' },
      });
    });

    it('reports a missing folder or destination, and a server without folder levels', async () => {
      const { provider } = renamer({ paths: ['Receipts'] });

      await expect(provider.moveFolder('Missing', 'Receipts')).rejects.toMatchObject({
        code: 'not_found',
        message: 'This mailbox has no folder named "Missing".',
      });
      await expect(provider.moveFolder('Receipts', 'Nowhere')).rejects.toMatchObject({
        code: 'not_found',
        message: 'This mailbox has no folder named "Nowhere".',
      });

      const flat = renamer({ delimiter: '', paths: ['Receipts', 'Other'] });
      await expect(flat.provider.moveFolder('Receipts', 'Other')).rejects.toMatchObject({
        code: 'invalid_request',
        message: "This mail server doesn't keep folders inside other folders.",
      });
    });

    it('says the server would not move the folder, without the server text', async () => {
      const { provider, mailboxRename } = renamer({ paths: ['Receipts', 'Projects'] });
      mailboxRename.mockRejectedValueOnce(serverError('CANNOT'));

      const error = (await provider.moveFolder('Receipts', 'Projects').catch((caught: unknown) => caught)) as Error;

      expect(error).toMatchObject({
        code: 'invalid_request',
        message: 'The mail server would not move the folder "Receipts" to "Projects/Receipts" (CANNOT).',
      });
    });
  });
});
