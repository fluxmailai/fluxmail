import { and, eq, inArray, ne } from 'drizzle-orm';
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

  private upsert(db: Pick<FluxmailDb, 'insert'>, location: ImapMessageLocation): void {
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
}
