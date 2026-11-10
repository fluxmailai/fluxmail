import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { EmailError } from '@fluxmail/core';
import { deliveryOperations, openDb } from '../src/storage/db.js';
import { DeliveryCoordinator } from '../src/service/deliveryCoordinator.js';

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
