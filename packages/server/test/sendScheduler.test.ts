import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as scheduledStorage from '../src/storage/scheduledSends.js';
import { EmailError } from '@fluxmail/core';
import { accounts, openDb, scheduledSends, type FluxmailDb } from '../src/storage/db.js';
import {
  claimScheduledSend,
  cancelScheduledSend,
  createScheduledSend,
  getScheduledSend,
  listPending,
} from '../src/storage/scheduledSends.js';
import { SendScheduler } from '../src/scheduler/sendScheduler.js';
import { DeliveryCoordinator } from '../src/service/deliveryCoordinator.js';
import type { Logger } from '../src/logging.js';

function testDb(): FluxmailDb {
  const db = openDb(':memory:');
  db.insert(accounts)
    .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
    .run();
  return db;
}

/** Let the scheduler's fire-and-forget tick() promises settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('SendScheduler', () => {
  let db: FluxmailDb;
  let send: ReturnType<typeof vi.fn>;
  let enforceQuota: ReturnType<typeof vi.fn>;
  let scheduler: SendScheduler;
  let logWarn: ReturnType<typeof vi.fn>;
  let logger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    db = testDb();
    send = vi.fn().mockResolvedValue({ id: 'sent_1', threadId: 'thread_1' });
    enforceQuota = vi.fn().mockReturnValue(undefined);
    logWarn = vi.fn();
    logger = {
      info: vi.fn(),
      warn: logWarn,
      error: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    scheduler = new SendScheduler(db, { send, enforceQuota }, logger);
  });

  afterEach(async () => {
    await scheduler.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fires past-due schedules immediately on start (catch-up)', async () => {
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 60_000 });
    scheduler.start();
    await settle();

    expect(send).toHaveBeenCalledWith('acct_1', { draftId: 'draft_1' });
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent', sentMessageId: 'sent_1' });
  });

  it('restores and sends a pending row after the database is reopened', async () => {
    scheduler.stop();
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-scheduler-restart-')), 'fluxmail.db');
    const first = openDb(dbPath);
    first
      .insert(accounts)
      .values({
        id: 'acct_restart',
        provider: 'imap',
        email: 'me@example.com',
        status: 'active',
        createdAt: Date.now(),
      })
      .run();
    const row = createScheduledSend(first, {
      accountId: 'acct_restart',
      draftId: 'draft_restart',
      sendAt: Date.now() - 1_000,
    });
    (first as unknown as { $client: { close(): void } }).$client.close();

    const reopened = openDb(dbPath);
    scheduler = new SendScheduler(reopened, { send, enforceQuota });
    scheduler.start();
    await settle();

    expect(send).toHaveBeenCalledWith('acct_restart', { draftId: 'draft_restart' });
    expect(getScheduledSend(reopened, row.id)).toMatchObject({ status: 'sent', sentMessageId: 'sent_1' });
    scheduler.stop();
    (reopened as unknown as { $client: { close(): void } }).$client.close();
  });

  it('fires a future schedule only when its time comes', async () => {
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() + 60_000 });
    scheduler.start();
    await settle();
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fires multiple due schedules in send_at order', async () => {
    const now = Date.now();
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_b', sendAt: now - 1_000 });
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_a', sendAt: now - 5_000 });
    scheduler.start();
    await settle();

    expect(send.mock.calls.map((c) => c[1].draftId)).toEqual(['draft_a', 'draft_b']);
  });

  it('wakes up for a newly scheduled earlier send', async () => {
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_far', sendAt: Date.now() + 3_600_000 });
    scheduler.start();
    await settle();

    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_soon', sendAt: Date.now() + 10_000 });
    scheduler.wake();
    await settle();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(send.mock.calls.map((c) => c[1].draftId)).toEqual(['draft_soon']);
  });

  it('does not fire a schedule canceled before its time', async () => {
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() + 60_000 });
    scheduler.start();
    await settle();

    cancelScheduledSend(db, row.id);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(send).not.toHaveBeenCalled();
  });

  it('does not fire a schedule canceled while an earlier send in the same tick is in flight', async () => {
    const now = Date.now();
    let releaseFirst!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)));
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_a', sendAt: now - 5_000 });
    const rowB = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_b', sendAt: now - 1_000 });
    scheduler.start();
    await settle();

    // draft_a's send is still awaiting the provider; cancel draft_b's schedule.
    cancelScheduledSend(db, rowB.id);
    releaseFirst({ id: 'sent_1', threadId: 'thread_1' });
    await settle();

    expect(send.mock.calls.map((c) => c[1].draftId)).toEqual(['draft_a']);
    expect(getScheduledSend(db, rowB.id)).toMatchObject({ status: 'canceled' });
  });

  it('rejects cancellation after a send has been claimed', async () => {
    let release!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const row = createScheduledSend(db, {
      accountId: 'acct_1',
      draftId: 'draft_1',
      sendAt: Date.now() - 1_000,
    });
    scheduler.start();
    await settle();

    expect(cancelScheduledSend(db, row.id)).toBe(false);
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sending' });

    release({ id: 'sent_1', threadId: 'thread_1' });
    await settle();
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent' });
  });

  it('allows only one scheduler to claim a due send', async () => {
    let release!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    const competingScheduler = new SendScheduler(db, { send, enforceQuota });

    scheduler.start();
    competingScheduler.start();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);

    release({ id: 'sent_1', threadId: 'thread_1' });
    await settle();
    competingScheduler.stop();
  });

  it('marks permanent failures failed with a human-readable reason and stops retrying', async () => {
    send.mockRejectedValue(new EmailError('not_found', 'Requested entity was not found'));
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();

    expect(getScheduledSend(db, row.id)).toMatchObject({
      status: 'failed',
      lastError: 'Draft no longer exists: it was sent or deleted outside Fluxmail',
    });
    await vi.advanceTimersByTimeAsync(31_000); // past the 30s first backoff
    expect(send).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      'scheduler.send_failed',
      'Requested entity was not found',
      expect.objectContaining({ code: 'not_found' }),
      { details: { permanent: true } },
    );
  });

  it('retries transient failures with backoff until they succeed', async () => {
    send.mockRejectedValueOnce(new EmailError('auth_expired', 'token expired'));
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();

    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'token expired' });
    expect(logWarn).toHaveBeenCalledWith(
      'scheduler.send_retry',
      'token expired',
      expect.objectContaining({ code: 'auth_expired' }),
      { details: { attempt: 1, permanent: false } },
    );

    await vi.advanceTimersByTimeAsync(31_000); // past the 30s first backoff
    expect(send).toHaveBeenCalledTimes(2);
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent' });
  });

  it('retries a confirmed 429 through the durable delivery coordinator', async () => {
    const coordinator = new DeliveryCoordinator(db);
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new EmailError('rate_limited', 'Gmail returned 429'))
      .mockResolvedValueOnce({ id: 'sent_1', threadId: 'thread_1' });
    scheduler = new SendScheduler(
      db,
      {
        send,
        enforceQuota,
        deliverScheduled: (accountId, draftId, scheduleId) =>
          coordinator.fireScheduled(accountId, draftId, scheduleId, async () => undefined, dispatch),
      },
      logger,
    );
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();

    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(coordinator.findScheduled('acct_1', row.id)?.status).toBe('queued');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent', sentMessageId: 'sent_1' });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a delivered message that returns a Sent-copy warning', async () => {
    send.mockResolvedValue({
      id: 'smtp_delivery',
      threadId: 'thread_delivery',
      warnings: ['Message delivered, but Fluxmail could not save the Sent copy.'],
    });
    const row = createScheduledSend(db, {
      accountId: 'acct_1',
      draftId: 'draft_1',
      sendAt: Date.now() - 1_000,
    });
    scheduler.start();
    await settle();

    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent', sentMessageId: 'smtp_delivery' });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps polling when nothing is pending', async () => {
    scheduler.start();
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    expect(listPending(db)).toHaveLength(0);
  });

  it('holds due sends while over the plan quota and resumes once it clears', async () => {
    enforceQuota.mockImplementation(() => {
      throw new EmailError('entitlement_exceeded', 'over the plan quota');
    });
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();

    // Held: still pending, no attempt consumed, the reason recorded.
    expect(send).not.toHaveBeenCalled();
    expect(getScheduledSend(db, row.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastError: 'over the plan quota',
    });

    // License renewed (or usage trimmed): the next re-check sends it.
    enforceQuota.mockReturnValue(undefined);
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getScheduledSend(db, row.id)).toMatchObject({ status: 'sent' });
  });

  it('rechecks held sends immediately when woken after a license refresh', async () => {
    enforceQuota.mockImplementation(() => {
      throw new EmailError('entitlement_exceeded', 'over the plan quota');
    });
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'draft_1', sendAt: Date.now() - 1_000 });
    scheduler.start();
    await settle();
    expect(send).not.toHaveBeenCalled();

    enforceQuota.mockReturnValue(undefined);
    scheduler.licenseRefreshed();
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
  });
  it('discovers new and earlier work through an independent connection, even from an empty queue', async () => {
    await scheduler.stop();
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-discovery-')), 'fluxmail.db');
    const first = openDb(dbPath);
    first
      .insert(accounts)
      .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
      .run();
    const other = openDb(dbPath);
    scheduler = new SendScheduler(first, { send, enforceQuota });
    try {
      scheduler.start();
      scheduler.start();
      await settle();
      createScheduledSend(other, { accountId: 'acct_1', draftId: 'far', sendAt: Date.now() + 60_000 });
      const canceled = createScheduledSend(other, { accountId: 'acct_1', draftId: 'canceled', sendAt: Date.now() });
      cancelScheduledSend(other, canceled.id);
      const earlier = createScheduledSend(other, { accountId: 'acct_1', draftId: 'earlier', sendAt: Date.now() + 300 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send.mock.calls.map((call) => call[1].draftId)).toEqual(['earlier']);
      expect(getScheduledSend(other, earlier.id)?.status).toBe('sent');
    } finally {
      await scheduler.stop();
      (first as unknown as { $client: { close(): void } }).$client.close();
      (other as unknown as { $client: { close(): void } }).$client.close();
    }
  });

  it.each(['sendAt', 'nextAttemptAt'] as const)('rechecks stale batch %s eligibility when claiming', async (field) => {
    let release!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'first', sendAt: Date.now() - 2 });
    const second = createScheduledSend(db, { accountId: 'acct_1', draftId: 'second', sendAt: Date.now() - 1 });
    scheduler.start();
    await settle();
    db.update(scheduledSends)
      .set({ [field]: Date.now() + 60_000 })
      .where(eq(scheduledSends.id, second.id))
      .run();
    release({ id: 'sent', threadId: 'thread' });
    await settle();
    expect(send).toHaveBeenCalledOnce();
    expect(getScheduledSend(db, second.id)?.status).toBe('pending');
  });

  it('preserves retry deadlines and attempt counts across competing workers and a database restart', async () => {
    await scheduler.stop();
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-retry-')), 'fluxmail.db');
    const first = openDb(dbPath);
    first
      .insert(accounts)
      .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
      .run();
    const row = createScheduledSend(first, { accountId: 'acct_1', draftId: 'retry', sendAt: Date.now() - 1 });
    send.mockRejectedValue(new EmailError('rate_limited', 'private provider failure'));
    scheduler = new SendScheduler(first, { send, enforceQuota });
    scheduler.start();
    await settle();
    const deadline = Date.now() + 30_000;
    expect(getScheduledSend(first, row.id)).toMatchObject({ attempts: 1, nextAttemptAt: deadline });
    await scheduler.stop();
    (first as unknown as { $client: { close(): void } }).$client.close();
    const reopened = openDb(dbPath);
    const other = openDb(dbPath);
    scheduler = new SendScheduler(reopened, { send, enforceQuota });
    const competitor = new SendScheduler(other, { send, enforceQuota });
    try {
      scheduler.start();
      competitor.start();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
      expect(getScheduledSend(reopened, row.id)).toMatchObject({ attempts: 2, nextAttemptAt: deadline + 60_000 });
    } finally {
      await scheduler.stop();
      await competitor.stop();
      (reopened as unknown as { $client: { close(): void } }).$client.close();
      (other as unknown as { $client: { close(): void } }).$client.close();
    }
  });

  it('renews a long delivery during shutdown while another worker polls, then clears all timers', async () => {
    let release!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'long', sendAt: Date.now() - 1 });
    scheduler.start();
    await settle();
    const stopping = scheduler.stop();
    const competitor = new SendScheduler(db, { send, enforceQuota });
    competitor.start();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(send).toHaveBeenCalledOnce();
    expect(getScheduledSend(db, row.id)!.claimUntil).toBeGreaterThan(Date.now());
    release({ id: 'sent', threadId: 'thread' });
    await stopping;
    await competitor.stop();
    expect(getScheduledSend(db, row.id)?.status).toBe('sent');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains the first delivery and leaves later batch entries unclaimed on shutdown', async () => {
    let release!: (result: { id: string; threadId: string }) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const first = createScheduledSend(db, { accountId: 'acct_1', draftId: 'first', sendAt: Date.now() - 2 });
    const second = createScheduledSend(db, { accountId: 'acct_1', draftId: 'second', sendAt: Date.now() - 1 });
    scheduler.start();
    await settle();
    const stopping = scheduler.stop();
    scheduler.wake();
    release({ id: 'sent', threadId: 'thread' });
    await stopping;
    expect(send).toHaveBeenCalledOnce();
    expect(getScheduledSend(db, first.id)?.status).toBe('sent');
    expect(getScheduledSend(db, second.id)).toMatchObject({ status: 'pending', claimToken: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polling and ordinary wakeups do not bypass a quota hold or repeat writes and logs', async () => {
    enforceQuota.mockImplementation(() => {
      throw new EmailError('entitlement_exceeded', 'over quota');
    });
    const hold = vi.spyOn(scheduledStorage, 'holdPending');
    createScheduledSend(db, { accountId: 'acct_1', draftId: 'held', sendAt: Date.now() - 1 });
    scheduler.start();
    await settle();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hold).toHaveBeenCalledOnce();
    expect(enforceQuota).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(hold).toHaveBeenCalledTimes(2);
    expect(enforceQuota).toHaveBeenCalledTimes(2);
    expect(getScheduledSend(db, listPending(db)[0]!.id)?.attempts).toBe(0);
  });

  it.each(['lost', 'error'] as const)('does not dispatch after %s claim renewal during preflight', async (mode) => {
    const coordinator = new DeliveryCoordinator(db);
    let release!: () => void;
    const preflight = () => new Promise<void>((resolve) => (release = resolve));
    scheduler = new SendScheduler(db, {
      send,
      enforceQuota,
      deliverScheduled: (accountId, draftId, scheduleId, ownsClaim) =>
        coordinator.fireScheduled(accountId, draftId, scheduleId, preflight, send, ownsClaim),
    });
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'preflight', sendAt: Date.now() - 1 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    if (mode === 'lost')
      db.update(scheduledSends).set({ claimToken: 'other-worker' }).where(eq(scheduledSends.id, row.id)).run();
    else
      vi.spyOn(scheduledStorage, 'renewClaim').mockImplementation(() => {
        throw new Error('database busy');
      });
    await vi.advanceTimersByTimeAsync(60_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(coordinator.findScheduled('acct_1', row.id)?.status).toBe('queued');
    expect(getScheduledSend(db, row.id)?.status).toBe('sending');
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not replace an unresolved provider request after losing its schedule lease', async () => {
    const coordinator = new DeliveryCoordinator(db);
    let release!: (result: { id: string; threadId: string }) => void;
    const dispatch = vi.fn(() => new Promise<{ id: string; threadId: string }>((resolve) => (release = resolve)));
    const service = {
      send,
      enforceQuota,
      deliverScheduled: (accountId: string, draftId: string, scheduleId: string, ownsClaim: () => boolean) =>
        coordinator.fireScheduled(accountId, draftId, scheduleId, async () => {}, dispatch, ownsClaim),
    };
    scheduler = new SendScheduler(db, service);
    const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'uncertain', sendAt: Date.now() - 1 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    db.update(scheduledSends)
      .set({ claimToken: 'expired-worker', claimUntil: Date.now() - 1 })
      .where(eq(scheduledSends.id, row.id))
      .run();
    const competitor = new SendScheduler(db, service);
    competitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getScheduledSend(db, row.id)?.status).toBe('uncertain');
    expect(dispatch).toHaveBeenCalledOnce();
    release({ id: 'sent', threadId: 'thread' });
    await scheduler.stop();
    await competitor.stop();
    expect(getScheduledSend(db, row.id)?.status).toBe('uncertain');
    expect(coordinator.findScheduled('acct_1', row.id)?.status).toBe('succeeded');
  });

  it.each(['queued', 'sending', 'succeeded'] as const)(
    'recovers an expired schedule with a %s delivery record',
    async (status) => {
      const coordinator = new DeliveryCoordinator(db);
      const row = createScheduledSend(db, { accountId: 'acct_1', draftId: 'recovery', sendAt: Date.now() - 1 });
      claimScheduledSend(db, row.id, Date.now() - 6 * 60_000, 5 * 60_000);
      coordinator.queueScheduled('acct_1', row.id, row.draftId);
      if (status !== 'queued') {
        const { deliveryOperations } = await import('../src/storage/db.js');
        db.update(deliveryOperations)
          .set({
            status,
            ...(status === 'succeeded' ? { resultJson: JSON.stringify({ id: 'recorded', threadId: 'thread' }) } : {}),
          })
          .run();
      }
      scheduler = new SendScheduler(db, {
        send,
        enforceQuota,
        deliverScheduled: (accountId, draftId, scheduleId, ownsClaim) =>
          coordinator.fireScheduled(accountId, draftId, scheduleId, async () => {}, send, ownsClaim),
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(status === 'queued' ? 1 : 0);
      expect(getScheduledSend(db, row.id)?.status).toBe(status === 'sending' ? 'uncertain' : 'sent');
      if (status === 'succeeded') expect(getScheduledSend(db, row.id)?.sentMessageId).toBe('recorded');
    },
  );
});
