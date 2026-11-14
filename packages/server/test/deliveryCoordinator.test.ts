import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { accounts, deliveryOperations, openDb } from '../src/storage/db.js';
import { createScheduledSend, markSent } from '../src/storage/scheduledSends.js';
import { DeliveryCoordinator, deliveryFailure } from '../src/service/deliveryCoordinator.js';

describe('delivery operations', () => {
  it('replays one confirmed result without calling the provider again', async () => {
    const db = openDb(':memory:');
    const coordinator = new DeliveryCoordinator(db);
    const deliver = vi.fn(async () => ({ id: 'sent_1', threadId: 'thread_1' }));
    const input = {
      principalId: 'credential_1',
      memberId: 'member_1',
      accountId: 'acct_1',
      key: 'stable-key',
      kind: 'send' as const,
      request: { subject: 'private subject' },
    };
    const first = await coordinator.run(input, deliver);
    db.update(deliveryOperations)
      .set({ createdAt: Date.now() - 25 * 60 * 60_000, updatedAt: Date.now() - 25 * 60 * 60_000 })
      .where(eq(deliveryOperations.id, first.operationId))
      .run();
    const replay = await coordinator.run(input, deliver);
    expect(first.status).toBe('succeeded');
    expect(replay).toEqual(first);
    expect(deliver).toHaveBeenCalledOnce();
    await expect(coordinator.run({ ...input, request: { subject: 'different' } }, deliver)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });

  it('holds ambiguous outcomes and does not retry them', async () => {
    const coordinator = new DeliveryCoordinator(openDb(':memory:'));
    const deliver = vi.fn().mockRejectedValue(new EmailError('provider_unavailable', 'socket closed after DATA'));
    const input = {
      principalId: 'credential_1',
      memberId: 'member_1',
      accountId: 'acct_1',
      key: 'send-2',
      kind: 'send' as const,
      request: {},
    };
    const first = await coordinator.run(input, deliver);
    const replay = await coordinator.run(input, deliver);
    expect(first).toMatchObject({ status: 'uncertain', error: { code: 'provider_unavailable' } });
    expect(replay).toEqual(first);
    expect(deliver).toHaveBeenCalledOnce();
    expect(JSON.stringify(first)).not.toContain('socket closed');
    expect(first.error?.message).toBe(
      "Fluxmail can't confirm whether the message was sent. Check Sent before sending again.",
    );
  });

  it('keeps the error behind a failed delivery for telemetry only', async () => {
    const coordinator = new DeliveryCoordinator(openDb(':memory:'));
    const cause = new EmailError('provider_unavailable', 'socket closed after DATA', undefined, {
      provider: 'imap',
      phase: 'smtp',
      reason: 'connection_reset',
    });
    const input = {
      principalId: 'credential_1',
      memberId: 'member_1',
      accountId: 'acct_1',
      key: 'send-cause',
      kind: 'send' as const,
      request: {},
    };
    const first = await coordinator.run(input, vi.fn().mockRejectedValue(cause));
    expect(deliveryFailure(first)).toEqual({ errorCode: 'uncertain', cause });
    expect(JSON.stringify(first)).not.toContain('connection_reset');
    // A replay has no error from this process to report.
    const replay = await coordinator.run(input, vi.fn());
    expect(deliveryFailure(replay)).toEqual({ errorCode: 'uncertain', cause: undefined });
    const sent = await coordinator.run(
      { ...input, key: 'send-ok' },
      vi.fn(async () => ({ id: 'sent_1', threadId: 'thread_1' })),
    );
    expect(deliveryFailure(sent)).toBeUndefined();
  });

  it('keeps the error behind a schedule that could not be created', async () => {
    const coordinator = new DeliveryCoordinator(openDb(':memory:'));
    const cause = new EmailError('provider_unavailable', 'draft save failed', undefined, {
      provider: 'imap',
      phase: 'connect',
      reason: 'connection_reset',
    });
    const operation = await coordinator.schedule(
      {
        principalId: 'credential_1',
        memberId: 'member_1',
        accountId: 'acct_1',
        key: 'schedule-cause',
        request: {},
      },
      vi.fn().mockRejectedValue(cause),
    );
    expect(deliveryFailure(operation)).toEqual({ errorCode: 'uncertain', cause });
  });

  it('can fail definitely and scopes status to the member and account', async () => {
    const coordinator = new DeliveryCoordinator(openDb(':memory:'));
    const input = {
      principalId: 'credential_1',
      memberId: 'member_1',
      accountId: 'acct_1',
      key: 'send-3',
      kind: 'send' as const,
      request: {},
    };
    const operation = await coordinator.run(input, async () => {
      throw new EmailError('invalid_request', 'bad recipient');
    });
    expect(operation.status).toBe('failed');
    expect(operation.error).toEqual({
      code: 'invalid_request',
      message: 'The mail provider rejected this message. Check its recipients and attachments.',
    });
    expect(JSON.stringify(operation)).not.toContain('bad recipient');
    expect(coordinator.get('credential_2', 'member_1', 'acct_1', operation.operationId)).toEqual(operation);
    expect(() => coordinator.get('credential_2', 'member_2', 'acct_1', operation.operationId)).toThrow(/not found/i);
    expect(() => coordinator.get('credential_1', 'member_1', 'acct_2', operation.operationId)).toThrow(/not found/i);
  });

  it('explains a canceled scheduled send', () => {
    const coordinator = new DeliveryCoordinator(openDb(':memory:'));
    coordinator.queueScheduled('acct_1', 'schedule_1', 'draft_1');
    coordinator.cancelScheduled('acct_1', 'schedule_1');
    expect(coordinator.findScheduled('acct_1', 'schedule_1')).toMatchObject({
      status: 'failed',
      error: { code: 'canceled', message: 'The scheduled send was canceled.' },
    });
  });

  /** A coordinator over a store with one mailbox, and a way to schedule from it as member_1. */
  function scheduling() {
    const db = openDb(':memory:');
    db.insert(accounts)
      .values({ id: 'acct_1', provider: 'gmail', email: 'me@example.com', status: 'active', createdAt: Date.now() })
      .run();
    const coordinator = new DeliveryCoordinator(db);
    let drafts = 0;
    const schedule = (key: string, create?: () => Promise<{ scheduleId: string }>) =>
      coordinator.schedule(
        { principalId: 'credential_1', memberId: 'member_1', accountId: 'acct_1', key, request: { key } },
        create ??
          (async () => ({
            scheduleId: createScheduledSend(db, { accountId: 'acct_1', draftId: `d${++drafts}`, sendAt: Date.now() })
              .id,
          })),
      );
    return { db, coordinator, schedule };
  }

  it('counts pending schedules of the member, but not canceled, failed or scheduler-owned ones', async () => {
    const { coordinator, schedule } = scheduling();
    const since = Date.now();
    // A schedule that fires without its own row gets one from the scheduler, with no member.
    coordinator.queueScheduled('acct_1', 'schedule_0', 'draft_0');
    // A schedule whose draft may or may not exist, but that has no schedule to send it.
    expect(
      await schedule('k0', async () => {
        throw new EmailError('provider_unavailable', 'socket closed');
      }),
    ).toMatchObject({ status: 'uncertain' });
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card')).toBeUndefined();

    const { scheduleId } = await schedule('k1');
    coordinator.setMatchHash('credential_1', 'k1', 'hash_1');
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card')).toBe('scheduled');
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card', 'hash_1')).toBe('scheduled');
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card', 'hash_2')).toBeUndefined();
    expect(coordinator.deliverySince('member_2', 'acct_1', since, 'card', 'hash_1')).toBeUndefined();
    expect(coordinator.deliverySince('member_1', 'acct_2', since, 'card', 'hash_1')).toBeUndefined();
    // A schedule made before the card still counts while it waits, but only for the same email.
    expect(coordinator.deliverySince('member_1', 'acct_1', Date.now() + 1, 'card', 'hash_1')).toBe('scheduled');
    expect(coordinator.deliverySince('member_1', 'acct_1', Date.now() + 1, 'card')).toBeUndefined();
    // Editing the scheduled draft replaces its digest.
    coordinator.setScheduledMatchHash('acct_1', scheduleId!, 'hash_2');
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card', 'hash_1')).toBeUndefined();
    expect(coordinator.deliverySince('member_1', 'acct_1', Date.now() + 1, 'card', 'hash_2')).toBe('scheduled');

    coordinator.cancelScheduled('acct_1', scheduleId!);
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card', 'hash_2')).toBeUndefined();
  });

  it('counts an older schedule once it fires after a time, if it is the same email', async () => {
    const { db, coordinator, schedule } = scheduling();
    const queued = await schedule('k1');
    const legacy = await schedule('k2');
    coordinator.setMatchHash('credential_1', 'k1', 'hash_1');
    const yesterday = Date.now() - 24 * 60 * 60_000;
    db.update(deliveryOperations).set({ createdAt: yesterday, updatedAt: yesterday }).run();
    const since = Date.now();
    const deliver = vi.fn(async () => ({ id: 'sent_1', threadId: 'thread_1' }));
    const fire = async (operation: typeof queued) => {
      await coordinator.fireScheduled('acct_1', 'draft', operation.scheduleId!, async () => undefined, deliver);
      markSent(db, operation.scheduleId!, { id: 'sent_1', threadId: 'thread_1' });
    };
    // A schedule from before the hash existed fires: it can't be matched, so it blocks no card.
    await fire(legacy);
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card', 'hash_2')).toBeUndefined();
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card', 'hash_1')).toBe('scheduled');
    await fire(queued);
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card', 'hash_1')).toBe('sent');
    expect(coordinator.deliverySince('member_1', 'acct_1', since, 'card', 'hash_2')).toBeUndefined();
    expect(coordinator.deliverySince('member_1', 'acct_1', Date.now() + 1, 'card', 'hash_1')).toBeUndefined();
  });

  it('holds a scheduled send after a lost worker instead of dispatching it again', async () => {
    const coordinator = new DeliveryCoordinator(openDb(':memory:'));
    const queued = coordinator.queueScheduled('acct_1', 'schedule_1', 'draft_1');
    expect(coordinator.get('credential_2', 'member_2', 'acct_1', queued.operationId)).toEqual(queued);
    expect(() => coordinator.get('credential_2', 'member_2', 'acct_2', queued.operationId)).toThrow(/not found/i);
    const deliver = vi.fn(async () => ({ id: 'sent_1', threadId: 'thread_1' }));
    const preflight = vi.fn(async () => undefined);
    const first = await coordinator.fireScheduled('acct_1', 'draft_1', 'schedule_1', preflight, deliver);
    const replay = await coordinator.fireScheduled('acct_1', 'draft_1', 'schedule_1', preflight, deliver);
    expect(first.status).toBe('succeeded');
    expect(replay.status).toBe('succeeded');
    expect(preflight).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('leaves a scheduled operation queued after a transient preflight failure', async () => {
    const coordinator = new DeliveryCoordinator(openDb(':memory:'));
    const queued = coordinator.queueScheduled('acct_1', 'schedule_retry', 'draft_1');
    const preflight = vi
      .fn()
      .mockRejectedValueOnce(new EmailError('rate_limited', 'Gmail rejected draft lookup before send'))
      .mockResolvedValueOnce(undefined);
    const deliver = vi.fn(async () => ({ id: 'sent_1', threadId: 'thread_1' }));
    await expect(
      coordinator.fireScheduled('acct_1', 'draft_1', 'schedule_retry', preflight, deliver),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(coordinator.get('credential_1', 'member_1', 'acct_1', queued.operationId).status).toBe('queued');
    expect(deliver).not.toHaveBeenCalled();
    const retried = await coordinator.fireScheduled('acct_1', 'draft_1', 'schedule_retry', preflight, deliver);
    expect(retried.status).toBe('succeeded');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('retries a confirmed provider rejection but holds an ambiguous scheduled send', async () => {
    const coordinator = new DeliveryCoordinator(openDb(':memory:'));
    const preflight = vi.fn(async () => undefined);
    const rejected = vi
      .fn()
      .mockRejectedValueOnce(new EmailError('rate_limited', 'Gmail returned 429'))
      .mockResolvedValueOnce({ id: 'sent_1', threadId: 'thread_1' });
    const queued = coordinator.queueScheduled('acct_1', 'schedule_429', 'draft_1');
    await expect(
      coordinator.fireScheduled('acct_1', 'draft_1', 'schedule_429', preflight, rejected),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(coordinator.get('credential_1', 'member_1', 'acct_1', queued.operationId).status).toBe('queued');
    expect((await coordinator.fireScheduled('acct_1', 'draft_1', 'schedule_429', preflight, rejected)).status).toBe(
      'succeeded',
    );

    coordinator.queueScheduled('acct_1', 'schedule_ambiguous', 'draft_2');
    const ambiguous = vi.fn().mockRejectedValue(new EmailError('provider_unavailable', 'socket closed'));
    expect(
      (await coordinator.fireScheduled('acct_1', 'draft_2', 'schedule_ambiguous', preflight, ambiguous)).status,
    ).toBe('uncertain');
    await coordinator.fireScheduled('acct_1', 'draft_2', 'schedule_ambiguous', preflight, ambiguous);
    expect(ambiguous).toHaveBeenCalledOnce();
  });

  it('does not resend a claimed schedule after a process restart', async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-delivery-restart-')), 'fluxmail.db');
    const first = openDb(dbPath);
    const queued = new DeliveryCoordinator(first).queueScheduled('acct_1', 'schedule_restart', 'draft_1');
    first
      .update(deliveryOperations)
      .set({ status: 'sending' })
      .where(eq(deliveryOperations.id, queued.operationId))
      .run();
    (first as unknown as { $client: { close(): void } }).$client.close();

    const reopened = openDb(dbPath);
    const deliver = vi.fn(async () => ({ id: 'sent_1', threadId: 'thread_1' }));
    const outcome = await new DeliveryCoordinator(reopened).fireScheduled(
      'acct_1',
      'draft_1',
      'schedule_restart',
      async () => undefined,
      deliver,
    );
    expect(outcome.status).toBe('uncertain');
    expect(deliver).not.toHaveBeenCalled();
    (reopened as unknown as { $client: { close(): void } }).$client.close();
  });

  it('backfills the member when migrating existing delivery operations', () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-delivery-member-')), 'fluxmail.db');
    const first = openDb(dbPath);
    const sqlite = (
      first as unknown as { $client: { exec(sql: string): void; pragma(sql: string): void; close(): void } }
    ).$client;
    sqlite.exec(`
      INSERT INTO members (id, name, role, status, created_at)
      VALUES ('member_1', 'Member', 'admin', 'active', 1);
      INSERT INTO member_sessions (id, member_id, token_hash, device_name, created_at, expires_at, last_used_at)
      VALUES ('session_old', 'member_1', 'hash_old', 'test', 1, 9999999999999, 1);
      ALTER TABLE delivery_operations DROP COLUMN member_id;
      ALTER TABLE scheduled_sends DROP COLUMN next_attempt_at;
      INSERT INTO delivery_operations
        (id, principal_id, idempotency_key, request_hash, account_id, kind, status, created_at, updated_at)
      VALUES ('dop_old', 'session_old', 'key_old', 'hash', 'acct_1', 'send', 'succeeded', 1, 1);
    `);
    sqlite.pragma('user_version = 4');
    sqlite.close();

    const reopened = openDb(dbPath);
    expect(new DeliveryCoordinator(reopened).get('session_new', 'member_1', 'acct_1', 'dop_old').status).toBe(
      'succeeded',
    );
    (reopened as unknown as { $client: { close(): void } }).$client.close();
  });
});
