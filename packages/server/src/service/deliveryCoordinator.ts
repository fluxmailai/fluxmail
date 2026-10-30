import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { EmailError, isDefiniteDeliveryFailure, isEmailError, type SendResult } from '@fluxmail/core';
import { deliveryOperations, type FluxmailDb } from '../storage/db.js';
import { ClientInputError } from './publicErrors.js';

export type DeliveryKind = 'send' | 'forward' | 'scheduled';
export type DeliveryStatus = 'queued' | 'sending' | 'succeeded' | 'failed' | 'uncertain';

export interface DeliveryOperation {
  operationId: string;
  accountId: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  result?: SendResult;
  error?: { code: string };
  scheduleId?: string;
}

type Row = typeof deliveryOperations.$inferSelect;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fromRow(row: Row): DeliveryOperation {
  return {
    operationId: row.id,
    accountId: row.accountId,
    kind: row.kind as DeliveryKind,
    status: row.status as DeliveryStatus,
    ...(row.resultJson ? { result: JSON.parse(row.resultJson) as SendResult } : {}),
    ...(row.errorCode ? { error: { code: row.errorCode } } : {}),
    ...(row.scheduleId ? { scheduleId: row.scheduleId } : {}),
  };
}

export { isDefiniteDeliveryFailure };

function isPermanentScheduledPreflightFailure(error: unknown): boolean {
  return (
    isEmailError(error) &&
    ['invalid_request', 'not_found', 'permission_denied', 'unsupported_capability'].includes(error.code)
  );
}

export class DeliveryCoordinator {
  constructor(private readonly db: FluxmailDb) {}

  get(principalId: string, memberId: string, accountId: string, operationId: string): DeliveryOperation {
    const row = this.db.select().from(deliveryOperations).where(eq(deliveryOperations.id, operationId)).get();
    if (
      !row ||
      row.accountId !== accountId ||
      (row.kind !== 'scheduled' && row.principalId !== principalId && row.memberId !== memberId)
    ) {
      throw new EmailError('not_found', 'Delivery operation not found.');
    }
    if (row.status === 'sending' && Date.now() - row.updatedAt > 5 * 60_000) {
      this.db
        .update(deliveryOperations)
        .set({ status: 'uncertain', updatedAt: Date.now() })
        .where(and(eq(deliveryOperations.id, row.id), eq(deliveryOperations.status, 'sending')))
        .run();
      return fromRow(this.db.select().from(deliveryOperations).where(eq(deliveryOperations.id, row.id)).get()!);
    }
    return fromRow(row);
  }

  findScheduled(accountId: string, scheduleId: string): DeliveryOperation | undefined {
    const row = this.db.select().from(deliveryOperations).where(eq(deliveryOperations.scheduleId, scheduleId)).get();
    return row?.accountId === accountId ? fromRow(row) : undefined;
  }

  cancelScheduled(accountId: string, scheduleId: string): void {
    const operation = this.findScheduled(accountId, scheduleId);
    if (!operation) return;
    this.db
      .update(deliveryOperations)
      .set({ status: 'failed', errorCode: 'canceled', updatedAt: Date.now() })
      .where(and(eq(deliveryOperations.id, operation.operationId), eq(deliveryOperations.status, 'queued')))
      .run();
  }

  queueScheduled(accountId: string, scheduleId: string, draftId: string): DeliveryOperation {
    const now = Date.now();
    const id = `dop_${randomBytes(12).toString('hex')}`;
    this.db
      .insert(deliveryOperations)
      .values({
        id,
        principalId: 'scheduler',
        idempotencyKey: scheduleId,
        requestHash: createHash('sha256')
          .update(canonical({ accountId, kind: 'scheduled', request: { draftId } }))
          .digest('hex'),
        accountId,
        kind: 'scheduled',
        status: 'queued',
        scheduleId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { operationId: id, accountId, kind: 'scheduled', status: 'queued', scheduleId };
  }

  async schedule(
    input: { principalId: string; memberId: string; accountId: string; key: string; request: unknown },
    create: () => Promise<{ scheduleId: string }>,
  ): Promise<DeliveryOperation> {
    if (!/^[\x21-\x7e]{1,255}$/.test(input.key)) {
      throw new ClientInputError(
        'invalid_request',
        'An idempotency key of 1 to 255 printable characters without spaces is required.',
      );
    }
    const hash = createHash('sha256')
      .update(canonical({ accountId: input.accountId, kind: 'scheduled', request: input.request }))
      .digest('hex');
    const id = `dop_${randomBytes(12).toString('hex')}`;
    const now = Date.now();
    const inserted = this.db
      .insert(deliveryOperations)
      .values({
        id,
        principalId: input.principalId,
        memberId: input.memberId,
        idempotencyKey: input.key,
        requestHash: hash,
        accountId: input.accountId,
        kind: 'scheduled',
        status: 'sending',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) {
      const existing = this.db
        .select()
        .from(deliveryOperations)
        .where(
          and(eq(deliveryOperations.principalId, input.principalId), eq(deliveryOperations.idempotencyKey, input.key)),
        )
        .get();
      if (!existing || existing.requestHash !== hash) {
        throw new EmailError('idempotency_conflict', 'This idempotency key was used for a different delivery request.');
      }
      return this.get(input.principalId, input.memberId, input.accountId, existing.id);
    }
    try {
      const scheduled = await create();
      this.db
        .update(deliveryOperations)
        .set({ status: 'queued', scheduleId: scheduled.scheduleId, updatedAt: Date.now() })
        .where(eq(deliveryOperations.id, id))
        .run();
    } catch (error) {
      this.db
        .update(deliveryOperations)
        .set({
          status: isDefiniteDeliveryFailure(error) ? 'failed' : 'uncertain',
          errorCode: isEmailError(error) ? error.code : 'internal',
          updatedAt: Date.now(),
        })
        .where(eq(deliveryOperations.id, id))
        .run();
    }
    return fromRow(this.db.select().from(deliveryOperations).where(eq(deliveryOperations.id, id)).get()!);
  }

  async fireScheduled(
    accountId: string,
    draftId: string,
    scheduleId: string,
    preflight: () => Promise<void>,
    deliver: () => Promise<SendResult>,
    ownsClaim: () => boolean = () => true,
  ): Promise<DeliveryOperation> {
    let row = this.db.select().from(deliveryOperations).where(eq(deliveryOperations.scheduleId, scheduleId)).get();
    if (!row) {
      this.queueScheduled(accountId, scheduleId, draftId);
      row = this.db.select().from(deliveryOperations).where(eq(deliveryOperations.scheduleId, scheduleId)).get();
    }
    if (!row || row.accountId !== accountId)
      throw new EmailError('not_found', 'Scheduled delivery operation not found.');
    if (row.status === 'sending') {
      this.db
        .update(deliveryOperations)
        .set({ status: 'uncertain', updatedAt: Date.now() })
        .where(eq(deliveryOperations.id, row.id))
        .run();
      return fromRow(this.db.select().from(deliveryOperations).where(eq(deliveryOperations.id, row.id)).get()!);
    }
    if (row.status !== 'queued') return fromRow(row);
    try {
      await preflight();
    } catch (error) {
      if (isPermanentScheduledPreflightFailure(error) && isEmailError(error)) {
        this.db
          .update(deliveryOperations)
          .set({ status: 'failed', errorCode: error.code, updatedAt: Date.now() })
          .where(and(eq(deliveryOperations.id, row.id), eq(deliveryOperations.status, 'queued')))
          .run();
      }
      throw error;
    }
    if (!ownsClaim()) return fromRow(row);
    const claimed = this.db
      .update(deliveryOperations)
      .set({ status: 'sending', updatedAt: Date.now() })
      .where(and(eq(deliveryOperations.id, row.id), eq(deliveryOperations.status, 'queued')))
      .run();
    return claimed.changes === 1
      ? this.finish(row.id, deliver, true)
      : fromRow(this.db.select().from(deliveryOperations).where(eq(deliveryOperations.id, row.id)).get()!);
  }

  async run(
    input: {
      principalId: string;
      memberId: string;
      accountId: string;
      key: string;
      kind: DeliveryKind;
      request: unknown;
      scheduleId?: string;
    },
    deliver: () => Promise<SendResult>,
  ): Promise<DeliveryOperation> {
    if (!/^[\x21-\x7e]{1,255}$/.test(input.key)) {
      throw new ClientInputError(
        'invalid_request',
        'An idempotency key of 1 to 255 printable characters without spaces is required.',
      );
    }
    const hash = createHash('sha256')
      .update(canonical({ accountId: input.accountId, kind: input.kind, request: input.request }))
      .digest('hex');
    const now = Date.now();
    const id = `dop_${randomBytes(12).toString('hex')}`;
    const inserted = this.db
      .insert(deliveryOperations)
      .values({
        id,
        principalId: input.principalId,
        memberId: input.memberId,
        idempotencyKey: input.key,
        requestHash: hash,
        accountId: input.accountId,
        kind: input.kind,
        status: 'sending',
        createdAt: now,
        updatedAt: now,
        ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) {
      const existing = this.db
        .select()
        .from(deliveryOperations)
        .where(
          and(eq(deliveryOperations.principalId, input.principalId), eq(deliveryOperations.idempotencyKey, input.key)),
        )
        .get();
      if (!existing || existing.requestHash !== hash) {
        throw new EmailError('idempotency_conflict', 'This idempotency key was used for a different delivery request.');
      }
      if (existing.status === 'queued' && input.kind === 'scheduled') {
        const claimed = this.db
          .update(deliveryOperations)
          .set({ status: 'sending', updatedAt: Date.now() })
          .where(and(eq(deliveryOperations.id, existing.id), eq(deliveryOperations.status, 'queued')))
          .run();
        if (claimed.changes === 1) return this.finish(existing.id, deliver);
      }
      return this.get(input.principalId, input.memberId, input.accountId, existing.id);
    }
    return this.finish(id, deliver);
  }

  private async finish(
    id: string,
    deliver: () => Promise<SendResult>,
    retryConfirmedRejection = false,
  ): Promise<DeliveryOperation> {
    const heartbeat = setInterval(() => {
      try {
        this.db
          .update(deliveryOperations)
          .set({ updatedAt: Date.now() })
          .where(and(eq(deliveryOperations.id, id), eq(deliveryOperations.status, 'sending')))
          .run();
      } catch {
        // A failed heartbeat must not start another delivery.
      }
    }, 60_000);
    heartbeat.unref();
    try {
      const result = await deliver();
      this.db
        .update(deliveryOperations)
        .set({ status: 'succeeded', resultJson: JSON.stringify(result), updatedAt: Date.now() })
        .where(eq(deliveryOperations.id, id))
        .run();
    } catch (error) {
      if (
        retryConfirmedRejection &&
        isEmailError(error) &&
        ['auth_expired', 'rate_limited', 'entitlement_exceeded'].includes(error.code)
      ) {
        this.db
          .update(deliveryOperations)
          .set({ status: 'queued', updatedAt: Date.now() })
          .where(and(eq(deliveryOperations.id, id), eq(deliveryOperations.status, 'sending')))
          .run();
        throw error;
      }
      this.db
        .update(deliveryOperations)
        .set({
          status: isDefiniteDeliveryFailure(error) ? 'failed' : 'uncertain',
          errorCode: isEmailError(error) ? error.code : 'internal',
          updatedAt: Date.now(),
        })
        .where(eq(deliveryOperations.id, id))
        .run();
    } finally {
      clearInterval(heartbeat);
    }
    return fromRow(this.db.select().from(deliveryOperations).where(eq(deliveryOperations.id, id)).get()!);
  }
}
