import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EmailError } from '@fluxmail/core';
import {
  accounts,
  CURRENT_STORE_FORMAT,
  deliveryOperations,
  inspectStoreCompatibility,
  openDb,
  type FluxmailDb,
} from '../src/storage/db.js';
import {
  cancelScheduledSend,
  claimScheduledSend,
  completeClaim,
  failClaim,
  listClaimable,
  renewClaim,
  retryClaim,
  uncertainClaim,
  countPending,
  createScheduledSend,
  findPendingByDraft,
  getScheduledSend,
  listPending,
  listScheduledSends,
  markFailed,
  markSent,
  recordAttempt,
} from '../src/storage/scheduledSends.js';
import { eq } from 'drizzle-orm';

function testDb(): FluxmailDb {
  const db = openDb(':memory:');
  db.insert(accounts)
    .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
    .run();
  return db;
}

describe('scheduled sends storage', () => {
  it('creates and reads back a schedule', () => {
    const db = testDb();
    const row = createScheduledSend(db, {
      accountId: 'acct_1',
      draftId: 'draft_1',
      sendAt: 1234,
      subject: 'Hi',
      toRecipients: 'bob@example.com',
    });
    expect(row.id).toMatch(/^sch_/);
    expect(row.status).toBe('pending');
    expect(getScheduledSend(db, row.id)).toEqual(row);
    expect(findPendingByDraft(db, 'acct_1', 'draft_1')).toEqual(row);
    expect(findPendingByDraft(db, 'acct_1', 'draft_other')).toBeUndefined();
  });

  it('rejects a second pending schedule for the same draft', () => {
    const db = testDb();
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 1234 });
    expect(() => createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 5678 })).toThrow(
      EmailError,
    );
  });

  it('allows rescheduling a draft after its schedule is canceled', () => {
    const db = testDb();
    const first = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 1234 });
    expect(cancelScheduledSend(db, first.id)).toBe(true);
    expect(cancelScheduledSend(db, first.id)).toBe(false); // already canceled
    const second = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 5678 });
    expect(second.id).not.toBe(first.id);
  });

  it('lists pending first by due time, then others newest-first', () => {
    const db = testDb();
    const late = createScheduledSend(db, { accountId: 'acct_1', draftId: 'd_late', sendAt: 9999 });
    const early = createScheduledSend(db, { accountId: 'acct_1', draftId: 'd_early', sendAt: 1111 });
    const done = createScheduledSend(db, { accountId: 'acct_1', draftId: 'd_done', sendAt: 2222 });
    markSent(db, done.id, { id: 'm1', threadId: 't1' });

    const listed = listScheduledSends(db);
    expect(listed.map((r) => r.id)).toEqual([early.id, late.id, done.id]);
    expect(
      listPending(db)
        .map((r) => r.id)
        .sort(),
    ).toEqual([early.id, late.id].sort());
    expect(listScheduledSends(db, 'acct_other')).toHaveLength(0);
  });

  it('tracks sent, failed, and retry attempts', () => {
    const db = testDb();
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 1234 });

    recordAttempt(db, row.id, 'rate limited');
    recordAttempt(db, row.id, 'still rate limited');
    let current = getScheduledSend(db, row.id)!;
    expect(current).toMatchObject({ status: 'pending', attempts: 2, lastError: 'still rate limited' });

    markSent(db, row.id, { id: 'm1', threadId: 't1' });
    current = getScheduledSend(db, row.id)!;
    expect(current).toMatchObject({ status: 'sent', sentMessageId: 'm1', sentThreadId: 't1', lastError: null });
    expect(cancelScheduledSend(db, row.id)).toBe(false); // sent rows cannot be canceled

    const failing = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_2', sendAt: 1234 });
    markFailed(db, failing.id, 'draft gone');
    expect(getScheduledSend(db, failing.id)).toMatchObject({ status: 'failed', lastError: 'draft gone' });
  });

  it('counts pending and reports the next due time', () => {
    const db = testDb();
    expect(countPending(db)).toEqual({ pending: 0 });
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'd1', sendAt: 500 });
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'd2', sendAt: 200 });
    expect(countPending(db)).toEqual({ pending: 2, nextSendAt: 200 });
  });

  it('cascades deletion with the account', () => {
    const db = testDb();
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: 1234 });
    db.delete(accounts).where(eq(accounts.id, 'acct_1')).run();
    expect(listScheduledSends(db)).toHaveLength(0);
  });
  it('migration 6 retains schedules and recorded deliveries and creates a matching backup', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fluxmail-migration-six-'));
    const dbPath = path.join(directory, 'fluxmail.db');
    const first = openDb(dbPath);
    first
      .insert(accounts)
      .values({ id: 'acct_1', provider: 'gmail', email: 'private@example.com', status: 'active', createdAt: 1 })
      .run();
    const row = createScheduledSend(first, { accountId: 'acct_1', draftId: 'draft', sendAt: 1 });
    first
      .insert(deliveryOperations)
      .values({
        id: 'dop_recorded',
        principalId: 'scheduler',
        idempotencyKey: row.id,
        requestHash: 'hash',
        accountId: 'acct_1',
        kind: 'scheduled',
        status: 'succeeded',
        scheduleId: row.id,
        resultJson: JSON.stringify({ id: 'sent', threadId: 'thread' }),
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const client = (first as unknown as { $client: Database.Database }).$client;
    client.exec('ALTER TABLE scheduled_sends DROP COLUMN next_attempt_at');
    client.pragma('user_version = 5');
    client.close();
    expect(inspectStoreCompatibility(dbPath, directory)).toMatchObject({
      storeFormat: 5,
      compatible: true,
      requiresMigration: true,
    });
    const reopened = openDb(dbPath);
    expect(getScheduledSend(reopened, row.id)).toMatchObject({ ...row, nextAttemptAt: 0 });
    expect(reopened.select().from(deliveryOperations).get()).toMatchObject({ id: 'dop_recorded', status: 'succeeded' });
    expect(inspectStoreCompatibility(dbPath, directory).storeFormat).toBe(CURRENT_STORE_FORMAT);
    const backups = readdirSync(path.join(directory, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(directory, 'backups', backups[0]!), { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(5);
    expect(backup.prepare('SELECT id FROM scheduled_sends').pluck().get()).toBe(row.id);
    backup.close();
    (reopened as unknown as { $client: Database.Database }).$client.close();
  });

  it('only the current sending token may renew, retry, or finalize a claim', () => {
    const db = testDb();
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft', sendAt: 1 });
    const first = claimScheduledSend(db, row.id, 1, 100)!;
    const second = claimScheduledSend(db, row.id, 101, 100)!;
    expect(renewClaim(db, row.id, first.token, 102, 100)).toBe(false);
    expect(retryClaim(db, row.id, first.token, 'error', 102)).toBeUndefined();
    completeClaim(db, row.id, first.token, { id: 'wrong', threadId: 'wrong' });
    failClaim(db, row.id, first.token, 'wrong');
    uncertainClaim(db, row.id, first.token, 'wrong');
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sending', claimToken: second.token, attempts: 0 });
    expect(renewClaim(db, row.id, second.token, 102, 100)).toBe(true);
    expect(retryClaim(db, row.id, second.token, 'error', 102)).toBe(1);
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: 30_102 });
    expect(renewClaim(db, row.id, second.token, 103, 100)).toBe(false);
    expect(listClaimable(db, 30_101)).toEqual([]);
    expect(claimScheduledSend(db, row.id, 30_101, 100)).toBeUndefined();
  });

  it('persists doubling retry delays capped at fifteen minutes without limiting attempts', () => {
    const db = testDb();
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft', sendAt: 1 });
    let now = 1;
    for (const [index, delay] of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000].entries()) {
      const claim = claimScheduledSend(db, row.id, now, 100)!;
      expect(retryClaim(db, row.id, claim.token, 'retry', now)).toBe(index + 1);
      expect(getScheduledSend(db, row.id)?.nextAttemptAt).toBe(now + delay);
      now += delay;
    }
  });
});
