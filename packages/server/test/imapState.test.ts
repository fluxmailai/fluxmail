import { beforeEach, describe, expect, it } from 'vitest';
import { accounts, openDb, type FluxmailDb } from '../src/storage/db.js';
import { SqliteImapStateStore } from '../src/storage/imapState.js';

describe('SqliteImapStateStore', () => {
  let db: FluxmailDb;
  let store: SqliteImapStateStore;

  beforeEach(() => {
    db = openDb(':memory:');
    db.insert(accounts)
      .values({ id: 'acct_1', provider: 'imap', email: 'me@example.com', status: 'active', createdAt: 1 })
      .run();
    store = new SqliteImapStateStore(db, 'acct_1');
  });

  it('keeps stable IDs while a message moves', async () => {
    await store.save({
      id: 'im_1',
      accountId: 'acct_1',
      mailboxPath: 'INBOX',
      uidValidity: '10',
      uid: 2,
      messageId: '<one@example.com>',
      references: ['<root@example.com>'],
      threadId: 'ith_1',
    });
    await store.save({
      ...(await store.findById('im_1'))!,
      mailboxPath: 'Archive',
      uidValidity: '20',
      uid: 9,
    });

    expect(await store.findById('im_1')).toMatchObject({ mailboxPath: 'Archive', uidValidity: '20', uid: 9 });
    expect(await store.findByLocation('Archive', '20', 9)).toMatchObject({ id: 'im_1' });
  });

  it('keeps the location another ID stored first for the same message', async () => {
    const location = { accountId: 'acct_1', mailboxPath: 'Drafts', uidValidity: '10', uid: 12, threadId: 'ith_1' };
    await store.save({ ...location, id: 'im_listed', draftId: 'draft_listed' });
    await store.saveMany([
      { ...location, id: 'im_moved', draftId: 'draft_1' },
      { ...location, id: 'im_other', uid: 13 },
    ]);

    expect(await store.findByLocation('Drafts', '10', 12)).toMatchObject({ id: 'im_listed' });
    expect(await store.findById('im_moved')).toBeUndefined();
    expect(await store.findById('im_other')).toMatchObject({ uid: 13 });
  });

  it('invalidates locations from an old UIDVALIDITY generation', async () => {
    await store.save({
      id: 'im_old',
      accountId: 'acct_1',
      mailboxPath: 'INBOX',
      uidValidity: '10',
      uid: 2,
      threadId: 'ith_1',
    });
    await store.invalidateMailbox('INBOX', '11');
    expect(await store.findById('im_old')).toBeUndefined();
  });

  it('resolves stable draft and thread records', async () => {
    await store.save({
      id: 'im_draft',
      accountId: 'acct_1',
      mailboxPath: 'Drafts',
      uidValidity: '10',
      uid: 3,
      threadId: 'ith_1',
      draftId: 'draft_1',
    });
    expect(await store.findByDraftId('draft_1')).toMatchObject({ id: 'im_draft' });
    expect(await store.listByThreadId('ith_1')).toHaveLength(1);
  });

  it('looks up and saves several locations at once', async () => {
    const location = (uid: number) => ({
      id: `im_${uid}`,
      accountId: 'acct_1',
      mailboxPath: 'INBOX',
      uidValidity: '10',
      uid,
      threadId: `ith_${uid}`,
    });
    await store.saveMany([location(1), location(2), { ...location(3), mailboxPath: 'Sent' }]);
    await store.saveMany([{ ...location(2), threadId: 'ith_moved' }]);

    const found = await store.findByLocations('INBOX', '10', [1, 2, 3, 4]);
    expect(found.map((row) => [row.uid, row.threadId]).sort()).toEqual([
      [1, 'ith_1'],
      [2, 'ith_moved'],
    ]);
    expect(await store.findByLocations('INBOX', '10', [])).toEqual([]);
    expect(await store.findByLocations('INBOX', '11', [1])).toEqual([]);
  });

  it('moves the locations of a renamed folder and the folders inside it, keeping message IDs', async () => {
    const base = { accountId: 'acct_1', uidValidity: '10', threadId: 'ith_1' };
    await store.save({ ...base, id: 'im_root', mailboxPath: 'Projects', uid: 1 });
    await store.save({ ...base, id: 'im_child', mailboxPath: 'Projects.2025', uid: 1 });
    await store.save({ ...base, id: 'im_deep', mailboxPath: 'Projects.2025.Q1', uid: 4 });
    // Names that only share the prefix, and LIKE wildcards in a path, are other folders.
    await store.save({ ...base, id: 'im_sibling', mailboxPath: 'Projects 2025', uid: 1 });
    await store.save({ ...base, id: 'im_wild', mailboxPath: 'Pro_ects.2025', uid: 1 });
    // A read that ran after the rename already stored this message under its new path.
    await store.save({ ...base, id: 'im_fresh', mailboxPath: 'Work.2025', uid: 1 });
    // Left over from a folder that once had the new name, with another UIDVALIDITY.
    await store.save({ ...base, id: 'im_stale', mailboxPath: 'Work.2025', uidValidity: '3', uid: 9 });
    db.insert(accounts)
      .values({ id: 'acct_2', provider: 'imap', email: 'other@example.com', status: 'active', createdAt: 1 })
      .run();
    const other = new SqliteImapStateStore(db, 'acct_2');
    await other.save({ ...base, accountId: 'acct_2', id: 'im_other', mailboxPath: 'Projects.2025', uid: 1 });

    await store.renameMailbox('Projects', 'Work', '.');

    expect(await store.findById('im_root')).toMatchObject({ mailboxPath: 'Work', uid: 1 });
    expect(await store.findById('im_deep')).toMatchObject({ mailboxPath: 'Work.2025.Q1', uid: 4 });
    // The location the later read stored keeps its ID, and the one from the old path is dropped.
    expect(await store.findByLocation('Work.2025', '10', 1)).toMatchObject({ id: 'im_fresh' });
    expect(await store.findById('im_child')).toBeUndefined();
    expect(await store.findById('im_stale')).toMatchObject({ mailboxPath: 'Work.2025', uidValidity: '3' });
    expect(await store.findById('im_sibling')).toMatchObject({ mailboxPath: 'Projects 2025' });
    expect(await store.findById('im_wild')).toMatchObject({ mailboxPath: 'Pro_ects.2025' });
    expect(await other.findById('im_other')).toMatchObject({ mailboxPath: 'Projects.2025' });
  });

  it('moves folders whose names have characters outside the basic plane', async () => {
    const base = { accountId: 'acct_1', uidValidity: '10', threadId: 'ith_1', uid: 1 };
    await store.save({ ...base, id: 'im_a', mailboxPath: 'Projects 📁' });
    await store.save({ ...base, id: 'im_b', mailboxPath: 'Projects 📁/2025' });

    await store.renameMailbox('Projects 📁', 'Work 🗂️', '/');

    expect(await store.findById('im_a')).toMatchObject({ mailboxPath: 'Work 🗂️' });
    expect(await store.findById('im_b')).toMatchObject({ mailboxPath: 'Work 🗂️/2025' });

    await store.renameMailbox('Work 🗂️', 'Jobs', '/');
    expect(await store.findById('im_b')).toMatchObject({ mailboxPath: 'Jobs/2025' });
  });

  it('moves only the folder itself when the server has no separator', async () => {
    const base = { accountId: 'acct_1', uidValidity: '10', threadId: 'ith_1', uid: 1 };
    await store.save({ ...base, id: 'im_a', mailboxPath: 'Receipts' });
    await store.save({ ...base, id: 'im_b', mailboxPath: 'Receipts.Old' });

    await store.renameMailbox('Receipts', 'Invoices');

    expect(await store.findById('im_a')).toMatchObject({ mailboxPath: 'Invoices' });
    expect(await store.findById('im_b')).toMatchObject({ mailboxPath: 'Receipts.Old' });
  });
});
