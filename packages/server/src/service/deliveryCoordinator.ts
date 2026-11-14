import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gte, ne, or } from 'drizzle-orm';
import { EmailError, isDefiniteDeliveryFailure, isEmailError, type SendResult } from '@fluxmail/core';
import { deliveryOperations, scheduledSends, type FluxmailDb } from '../storage/db.js';
import { ClientInputError, deliveryErrorMessage } from './publicErrors.js';

export type DeliveryKind = 'send' | 'forward' | 'scheduled';
export type DeliveryStatus = 'queued' | 'sending' | 'succeeded' | 'failed' | 'uncertain';

export interface DeliveryOperation {
  operationId: string;
  accountId: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  result?: SendResult;
  error?: { code: string; message: string };
  scheduleId?: string;
}

type Row = typeof deliveryOperations.$inferSelect;

/** The error behind a delivery that just failed, kept out of the operation clients see. */
const failureCauses = new WeakMap<DeliveryOperation, unknown>();

/**
 * The telemetry error code of a failed or uncertain delivery, with the error
 * behind it when this process attempted the delivery. Undefined otherwise.
 */
export function deliveryFailure(operation: DeliveryOperation): { errorCode: string; cause?: unknown } | undefined {
  if (operation.status !== 'failed' && operation.status !== 'uncertain') return undefined;
  return {
    errorCode: operation.status === 'uncertain' ? 'uncertain' : (operation.error?.code ?? 'internal'),
    cause: failureCauses.get(operation),
  };
}

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
    ...(row.errorCode
      ? { error: { code: row.errorCode, message: deliveryErrorMessage(row.status, row.errorCode) } }
      : {}),
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

  /** Whether this principal already started a delivery with this idempotency key. */
  findByKey(principalId: string, key: string): boolean {
    return !!this.db
      .select({ id: deliveryOperations.id })
      .from(deliveryOperations)
      .where(and(eq(deliveryOperations.principalId, principalId), eq(deliveryOperations.idempotencyKey, key)))
      .get();
  }

  /** Records the digest of a delivery's recipients and subject once the message is resolved, before it is sent. */
  setMatchHash(principalId: string, key: string, matchHash: string): void {
    this.db
      .update(deliveryOperations)
      .set({ matchHash })
      .where(and(eq(deliveryOperations.principalId, principalId), eq(deliveryOperations.idempotencyKey, key)))
      .run();
  }

  /**
   * Replaces a schedule's match digest when its draft is edited, since the draft sends as edited. The edit
   * counts as a change to the schedule for cards issued before it.
   */
  setScheduledMatchHash(accountId: string, scheduleId: string, matchHash: string): void {
    this.db
      .update(deliveryOperations)
      .set({ matchHash, updatedAt: Date.now() })
      .where(and(eq(deliveryOperations.accountId, accountId), eq(deliveryOperations.scheduleId, scheduleId)))
      .run();
  }

  /**
   * A delivery by a member from an account that a card issued at a time must yield to, other than one that
   * surely failed, a canceled schedule, or one with the given idempotency key. It is `scheduled` when every
   * match is a schedule that hasn't fired, and `sent` for any other match.
   *
   * A send or forward counts when it started at or after the time. A schedule counts when it was made,
   * edited or retried at or after the time, or when it fired then or is firing now. A schedule made earlier
   * that is still waiting doesn't count, and neither does one whose creation failed before a schedule was
   * stored, because nothing can send it.
   *
   * With a match hash, only a delivery of the same recipients and subject counts, or one made since the
   * time that has no hash because its message isn't resolved yet. An older schedule with no hash predates
   * the hash and never matches. Without a match hash, every delivery counts.
   */
  deliverySince(
    memberId: string,
    accountId: string,
    since: number,
    exceptKey: string,
    matchHash?: string,
  ): 'sent' | 'scheduled' | undefined {
    const rows = this.db
      .select({
        kind: deliveryOperations.kind,
        status: deliveryOperations.status,
        scheduleId: deliveryOperations.scheduleId,
        matchHash: deliveryOperations.matchHash,
        createdAt: deliveryOperations.createdAt,
        scheduleStatus: scheduledSends.status,
      })
      .from(deliveryOperations)
      .leftJoin(scheduledSends, eq(scheduledSends.id, deliveryOperations.scheduleId))
      .where(
        and(
          eq(deliveryOperations.memberId, memberId),
          eq(deliveryOperations.accountId, accountId),
          ne(deliveryOperations.status, 'failed'),
          ne(deliveryOperations.idempotencyKey, exceptKey),
          or(
            gte(deliveryOperations.createdAt, since),
            and(
              eq(deliveryOperations.kind, 'scheduled'),
              or(gte(deliveryOperations.updatedAt, since), eq(scheduledSends.status, 'sending')),
            ),
          ),
        ),
      )
      .all();
    const outcomes = rows.map((row) => {
      const sameEmail =
        matchHash === undefined || row.matchHash === matchHash || (row.matchHash === null && row.createdAt >= since);
      if (!sameEmail) return undefined;
      if (row.kind !== 'scheduled') return 'sent';
      // Without a schedule the row is still being created, or its creation failed and nothing can send it.
      if (!row.scheduleId) return row.status === 'sending' ? 'scheduled' : undefined;
      if (row.scheduleStatus === 'pending') return 'scheduled';
      if (row.scheduleStatus === 'sending' || row.scheduleStatus === 'sent' || row.scheduleStatus === 'uncertain') {
        return 'sent';
      }
      return undefined;
    });
    if (outcomes.includes('sent')) return 'sent';
    return outcomes.includes('scheduled') ? 'scheduled' : undefined;
  }

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
    let failure: unknown;
    try {
      const scheduled = await create();
      this.db
        .update(deliveryOperations)
        .set({ status: 'queued', scheduleId: scheduled.scheduleId, updatedAt: Date.now() })
        .where(eq(deliveryOperations.id, id))
        .run();
    } catch (error) {
      failure = error;
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
    return this.load(id, failure);
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
    let failure: unknown;
    try {
      const result = await deliver();
      this.db
        .update(deliveryOperations)
        .set({ status: 'succeeded', resultJson: JSON.stringify(result), updatedAt: Date.now() })
        .where(eq(deliveryOperations.id, id))
        .run();
    } catch (error) {
      failure = error;
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
    return this.load(id, failure);
  }

  /** Reads an operation back, keeping the error from this attempt for telemetry. */
  private load(id: string, failure: unknown): DeliveryOperation {
    const operation = fromRow(this.db.select().from(deliveryOperations).where(eq(deliveryOperations.id, id)).get()!);
    if (failure !== undefined) failureCauses.set(operation, failure);
    return operation;
  }
}
