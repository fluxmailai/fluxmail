import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ImapMessageLocation, ImapStateStore } from '@fluxmail/provider-imap';
import { imapMessages, type FluxmailDb } from './db.js';

function fromRow(row: typeof imapMessages.$inferSelect): ImapMessageLocation {
  return {
    id: row.id,
    accountId: row.accountId,
    mailboxPath: row.mailboxPath,
    uidValidity: row.uidValidity,
    uid: row.uid,
    ...(row.messageId ? { messageId: row.messageId } : {}),
    ...(row.inReplyTo ? { inReplyTo: row.inReplyTo } : {}),
    ...(row.references ? { references: JSON.parse(row.references) as string[] } : {}),
    threadId: row.threadId,
    ...(row.draftId ? { draftId: row.draftId } : {}),
    ...(row.subject !== null ? { subject: row.subject } : {}),
    ...(row.date !== null ? { date: row.date } : {}),
  };
}

export class SqliteImapStateStore implements ImapStateStore {
  constructor(
    private readonly db: FluxmailDb,
    private readonly accountId: string,
  ) {}

  async findById(id: string): Promise<ImapMessageLocation | undefined> {
    const row = this.db
      .select()
      .from(imapMessages)
      .where(and(eq(imapMessages.accountId, this.accountId), eq(imapMessages.id, id)))
      .get();
    return row ? fromRow(row) : undefined;
  }

  async findByLocation(path: string, uidValidity: string, uid: number): Promise<ImapMessageLocation | undefined> {
    const row = this.db
      .select()
      .from(imapMessages)
      .where(
        and(
          eq(imapMessages.accountId, this.accountId),
          eq(imapMessages.mailboxPath, path),
          eq(imapMessages.uidValidity, uidValidity),
          eq(imapMessages.uid, uid),
        ),
      )
      .get();
    return row ? fromRow(row) : undefined;
  }

  async findByLocations(path: string, uidValidity: string, uids: number[]): Promise<ImapMessageLocation[]> {
    if (!uids.length) return [];
    return this.db
      .select()
      .from(imapMessages)
      .where(
        and(
          eq(imapMessages.accountId, this.accountId),
          eq(imapMessages.mailboxPath, path),
          eq(imapMessages.uidValidity, uidValidity),
          inArray(imapMessages.uid, uids),
        ),
      )
      .all()
      .map(fromRow);
  }

  async findByDraftId(draftId: string): Promise<ImapMessageLocation | undefined> {
    const row = this.db
      .select()
      .from(imapMessages)
      .where(and(eq(imapMessages.accountId, this.accountId), eq(imapMessages.draftId, draftId)))
      .get();
    return row ? fromRow(row) : undefined;
  }

  async listByThreadId(threadId: string): Promise<ImapMessageLocation[]> {
    return this.db
      .select()
      .from(imapMessages)
      .where(and(eq(imapMessages.accountId, this.accountId), eq(imapMessages.threadId, threadId)))
      .all()
      .map(fromRow);
  }

  async save(location: ImapMessageLocation): Promise<void> {
    this.upsert(this.db, location);
  }

  async saveMany(locations: ImapMessageLocation[]): Promise<void> {
    this.db.transaction((tx) => {
      for (const location of locations) this.upsert(tx, location);
    });
  }

  private upsert(db: Pick<FluxmailDb, 'insert' | 'select'>, location: ImapMessageLocation): void {
    // A concurrent operation stored this message under another ID first; keep its location.
    // SQLite runs this check and the insert without anything in between.
    const holder = db
      .select({ id: imapMessages.id })
      .from(imapMessages)
      .where(
        and(
          eq(imapMessages.accountId, this.accountId),
          eq(imapMessages.mailboxPath, location.mailboxPath),
          eq(imapMessages.uidValidity, location.uidValidity),
          eq(imapMessages.uid, location.uid),
        ),
      )
      .get();
    if (holder && holder.id !== location.id) return;
    const values = {
      id: location.id,
      accountId: this.accountId,
      mailboxPath: location.mailboxPath,
      uidValidity: location.uidValidity,
      uid: location.uid,
      messageId: location.messageId ?? null,
      inReplyTo: location.inReplyTo ?? null,
      references: location.references ? JSON.stringify(location.references) : null,
      threadId: location.threadId,
      draftId: location.draftId ?? null,
      subject: location.subject ?? null,
      date: location.date ?? null,
      updatedAt: Date.now(),
    };
    db.insert(imapMessages).values(values).onConflictDoUpdate({ target: imapMessages.id, set: values }).run();
  }

  async remove(id: string): Promise<void> {
    this.db
      .delete(imapMessages)
      .where(and(eq(imapMessages.accountId, this.accountId), eq(imapMessages.id, id)))
      .run();
  }

  async invalidateMailbox(path: string, uidValidity: string): Promise<void> {
    this.db
      .delete(imapMessages)
      .where(
        and(
          eq(imapMessages.accountId, this.accountId),
          eq(imapMessages.mailboxPath, path),
          ne(imapMessages.uidValidity, uidValidity),
        ),
      )
      .run();
  }

  async renameMailbox(path: string, newPath: string, separator?: string): Promise<void> {
    // The mailboxes inside the renamed one are the paths that start with its path and the separator. SQLite
    // counts characters where JavaScript counts UTF-16 units, so SQLite measures the lengths.
    const prefix = separator ? path + separator : undefined;
    const moved =
      prefix === undefined
        ? sql`mailbox_path = ${path}`
        : sql`(mailbox_path = ${path} OR substr(mailbox_path, 1, length(${prefix})) = ${prefix})`;
    const target = sql`${newPath} || substr(imap_messages.mailbox_path, length(${path}) + 1)`;
    this.db.transaction((tx) => {
      // A read that ran after the rename may already have stored a message under its new path, with an ID it
      // gave its caller. That location stays, and the one stored under the old path is dropped instead.
      tx.run(
        sql`UPDATE imap_messages SET mailbox_path = ${target}, updated_at = ${Date.now()}
            WHERE account_id = ${this.accountId} AND ${moved}
              AND NOT EXISTS (
                SELECT 1 FROM imap_messages AS held
                WHERE held.account_id = imap_messages.account_id
                  AND held.mailbox_path = ${target}
                  AND held.uid_validity = imap_messages.uid_validity
                  AND held.uid = imap_messages.uid
              )`,
      );
      // Nothing is at the old paths any more.
      tx.run(sql`DELETE FROM imap_messages WHERE account_id = ${this.accountId} AND ${moved}`);
    });
  }
}
