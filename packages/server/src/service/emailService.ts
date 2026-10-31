import {
  assertSearchCapabilities,
  buildForwardBody,
  computeReplyRecipients,
  EmailError,
  formatAddressList,
  forwardSubject,
  isEmailError,
  normalizeEmailQuery,
  parseSingleAddress,
  replySubject,
  selectReplySender,
  type Account,
  type AttachmentInput,
  type AttachmentMeta,
  type DraftInput,
  type EmailAddress,
  type EmailQuery,
  type Folder,
  type GetMessageOpts,
  type Label,
  type Message,
  type Provider,
  type MessageSearchPage,
  type ModifyAction,
  type PageOpts,
  type PortableEmailQuery,
  type SendResult,
  type SendAsIdentity,
  type Thread,
} from '@fluxmail/core';
import { randomBytes } from 'node:crypto';
import { SearchCursorCodec } from '@fluxmail/core/search-cursor';
import type { AccountRegistry } from '../accounts/registry.js';
import { assertWithinQuota, checkLicenseState, type Entitlements } from '../licensing/entitlements.js';
import type { FluxmailDb } from '../storage/db.js';
import { listMembers } from '../storage/members.js';
import type { Principal } from '../auth.js';
import { canAccessAccount, canAdminister, canSeeAccountMetadata } from '../authorization.js';
import {
  cancelScheduledSend,
  countPending,
  createScheduledSend,
  findPendingByDraft,
  getScheduledSend,
  listScheduledSends,
  markSent,
  type ScheduledSendRow,
  type ScheduledSendStatus,
} from '../storage/scheduledSends.js';
import { DeliveryCoordinator, isDefiniteDeliveryFailure, type DeliveryOperation } from './deliveryCoordinator.js';
import { ClientInputError } from './publicErrors.js';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from '../config.js';
import { listConfiguredSendAs, replaceConfiguredSendAs, type ConfiguredSendAsInput } from '../storage/sendAs.js';

export interface SendInput extends DraftInput {
  /** With replyToMessageId: compute recipients from the original (reply-all semantics). */
  replyAll?: boolean;
}

export interface ForwardInput {
  messageId: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  /** Optional note placed above the forwarded content. */
  comment?: string;
  includeAttachments?: boolean;
  from?: string;
}

export interface ServiceStatus {
  accounts: Array<
    Pick<Account, 'id' | 'provider' | 'email' | 'status' | 'ownerMemberId'> & {
      error?: { code: string; message: string };
      warnings?: string[];
    }
  >;
  /** Instance-wide fields are only returned to administrators. */
  members?: { count: number };
  entitlements?: Entitlements;
  /** Renewal warning while the license is in grace or has lapsed. */
  licenseWarning?: string;
  providersAvailable: string[];
  scheduled: { pending: number; nextSendAt?: string };
}

export interface ScheduledSendInfo {
  scheduleId: string;
  operationId?: string;
  accountId: string;
  draftId: string;
  /** ISO 8601 UTC. */
  sendAt: string;
  status: ScheduledSendStatus;
  attempts: number;
  subject?: string;
  to?: string;
  lastError?: string;
  sentMessageId?: string;
  sentThreadId?: string;
}

export interface BatchSearchAccount {
  accountId: string;
  pageToken?: string;
}

export interface BatchSearchInput {
  accounts: BatchSearchAccount[];
  query: PortableEmailQuery;
  pageSize?: number;
  includeSnippet?: boolean;
  includeSearchContext?: boolean;
}

export interface BatchSearchError {
  code: string;
  message: string;
  data?: Record<string, unknown>;
  exhausted: false;
}

export interface BatchSearchGroup {
  accountId: string;
  page?: MessageSearchPage;
  error?: BatchSearchError;
}

export interface BatchSearchResult {
  groups: BatchSearchGroup[];
  exhausted: boolean;
}

export interface ModifyResult {
  action: ModifyAction;
  succeededIds: string[];
  failed: Array<{ messageId: string; code: string }>;
  uncertainIds: string[];
}

export interface SendPreview {
  accountId: string;
  from: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  attachments: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
  bodyTextChars: number;
  bodyHtmlChars: number;
}

const SCHEDULE_GRACE_MS = 60_000;
const SCHEDULE_MAX_HORIZON_MS = 365 * 24 * 3_600_000;
const SEARCH_SOFT_BUDGET_MS = 10_000;
const SEARCH_HARD_DEADLINE_MS = 15_000;
const BATCH_SEARCH_CONCURRENCY = 3;

function searchTimeoutError(provider?: Provider): EmailError {
  return new EmailError(
    'provider_unavailable',
    'The search took too long. Try a narrower search, such as a date range or one folder.',
    { reason: 'search_timeout', exhausted: false },
    { ...(provider ? { provider } : {}), phase: 'search', reason: 'search_timeout' },
  );
}

const batchErrorCauses = new WeakMap<BatchSearchError, unknown>();

/** The error behind the first failed batch group, for telemetry. It is never part of the response. */
export function batchFailureCause(groups: BatchSearchGroup[]): unknown {
  const failed = groups.find((group) => group.error)?.error;
  return failed ? batchErrorCauses.get(failed) : undefined;
}

function batchError(error: unknown): BatchSearchError {
  const result = batchErrorResult(error);
  batchErrorCauses.set(result, error);
  return result;
}

function batchErrorResult(error: unknown): BatchSearchError {
  if (isEmailError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
      exhausted: false,
    };
  }
  return {
    code: 'provider_unavailable',
    message: 'The email provider could not complete the search.',
    exhausted: false,
  };
}

/** Parse and validate a sendAt timestamp; returns epoch ms. */
export function resolveSendAt(sendAtIso: string, now = Date.now()): number {
  // Require an ISO 8601 shape: Date.parse alone is lenient enough to accept junk.
  const sendAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(sendAtIso) ? Date.parse(sendAtIso) : NaN;
  if (Number.isNaN(sendAt)) {
    throw new ClientInputError('invalid_request', `Could not parse sendAt: "${sendAtIso}" (expected ISO 8601)`);
  }
  if (sendAt < now - SCHEDULE_GRACE_MS) {
    throw new ClientInputError('invalid_request', 'sendAt is in the past; leave it out to send now');
  }
  if (sendAt > now + SCHEDULE_MAX_HORIZON_MS) {
    throw new ClientInputError('invalid_request', 'sendAt is more than a year away');
  }
  return sendAt;
}

function toScheduledInfo(row: ScheduledSendRow): ScheduledSendInfo {
  return {
    scheduleId: row.id,
    accountId: row.accountId,
    draftId: row.draftId,
    sendAt: new Date(row.sendAt).toISOString(),
    status: row.status,
    attempts: row.attempts,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    ...(row.toRecipients !== null ? { to: row.toRecipients } : {}),
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    ...(row.sentMessageId !== null ? { sentMessageId: row.sentMessageId } : {}),
    ...(row.sentThreadId !== null ? { sentThreadId: row.sentThreadId } : {}),
  };
}

/**
 * All business logic lives here: account routing, reply/forward computation,
 * entitlement enforcement, auth-failure bookkeeping. MCP tools (and the future
 * REST API / CLI) are thin wrappers over this service.
 */
export class EmailService {
  /** Wired to SendScheduler.wake() in long-lived processes; a no-op for one-shot CLI commands. */
  onScheduleChanged: () => void = () => {};

  private readonly cursorSecret: Buffer;
  private readonly cursorCodec: SearchCursorCodec;

  constructor(
    private readonly registry: AccountRegistry,
    private readonly db: FluxmailDb,
    private readonly principal?: Principal,
    cursorSecret?: Buffer,
    private readonly maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  ) {
    this.cursorSecret = cursorSecret ?? randomBytes(32);
    this.cursorCodec = new SearchCursorCodec(this.cursorSecret, {
      invalidCursor: () => new ClientInputError('invalid_request', 'Invalid or expired search page token.'),
    });
  }

  /**
   * A view restricted to a member's mailbox grants and optional connection
   * allowlist. Internal background workers use the default service instead.
   */
  withPrincipal(principal: Principal): EmailService {
    const scoped = new EmailService(this.registry, this.db, principal, this.cursorSecret, this.maxAttachmentBytes);
    scoped.onScheduleChanged = () => this.onScheduleChanged();
    return scoped;
  }

  /** Internal background work only. HTTP, MCP, and CLI requests always use withPrincipal(). */
  private isInternal(): boolean {
    return this.principal === undefined;
  }

  private canAccess(account: Account): boolean {
    return this.principal ? canAccessAccount(this.principal, account) : true;
  }

  private accessibleAccounts(): Account[] {
    const all = this.registry.listAccounts();
    return all.filter((a) => this.canAccess(a));
  }

  private metadataAccounts(): Account[] {
    return this.principal
      ? this.registry.listAccounts().filter((account) => canSeeAccountMetadata(this.principal!, account))
      : this.registry.listAccounts();
  }

  /**
   * Resolve an account id within the current scope. A member connection defaults
   * to its sole accessible mailbox and can never reach another member's mailbox;
   * inaccessible ids surface as not_found so a key cannot probe for their existence.
   */
  private resolveScopedAccountId(accountId?: string): string {
    if (accountId !== undefined) {
      const account = this.registry.getAccount(accountId);
      if (!this.canAccess(account)) {
        throw new EmailError('not_found', `No account with id "${accountId}"`);
      }
      return account.id;
    }
    if (this.isInternal()) return this.registry.resolveAccountId();
    const accessible = this.accessibleAccounts();
    if (accessible.length === 0) {
      throw new ClientInputError('invalid_request', 'No email accounts are available for this member.');
    }
    if (accessible.length > 1) {
      throw new ClientInputError(
        'invalid_request',
        `Multiple accounts are available; specify accountId. Available: ${accessible
          .map((a) => `${a.id} (${a.email})`)
          .join(', ')}`,
      );
    }
    return accessible[0]!.id;
  }

  /** Verify mailbox access without making a provider call. */
  assertAccountAccess(accountId: string): void {
    this.resolveScopedAccountId(accountId);
  }

  /** Route a call to the right provider, recording auth failures on the account. */
  private async withProvider<T>(
    accountId: string | undefined,
    fn: (provider: ReturnType<AccountRegistry['getProvider']>, resolvedId: string, account: Account) => Promise<T>,
  ): Promise<T> {
    const resolvedId = this.resolveScopedAccountId(accountId);
    const account = this.registry.getAccount(resolvedId);
    if (account.status === 'disabled') {
      throw new ClientInputError('invalid_request', `Account ${resolvedId} is disabled`);
    }
    try {
      const result = await fn(this.registry.getProvider(resolvedId), resolvedId, account);
      if (account.status === 'auth_error') this.registry.markStatus(resolvedId, 'active');
      return result;
    } catch (err) {
      if (isEmailError(err)) err.failure = { provider: account.provider, ...err.failure };
      if (isEmailError(err) && err.code === 'auth_expired') {
        this.registry.markStatus(resolvedId, 'auth_error');
      }
      throw err;
    }
  }

  listAccounts(): Account[] {
    return this.metadataAccounts();
  }

  async status(): Promise<ServiceStatus> {
    const accessibleAccounts = this.accessibleAccounts();
    const errors = new Map<string, { code: string; message: string }>();
    const warnings = new Map<string, string[]>();
    await Promise.all(
      accessibleAccounts
        .filter((account) => account.status !== 'disabled')
        .map(async (account) => {
          try {
            await this.registry.getProvider(account.id).testConnection();
            const provider = this.registry.getProvider(account.id) as ReturnType<AccountRegistry['getProvider']> & {
              getFolderWarnings?: () => Promise<Array<{ message: string }>>;
            };
            if (provider.getFolderWarnings) {
              const folderWarnings = await provider.getFolderWarnings();
              if (folderWarnings.length)
                warnings.set(
                  account.id,
                  folderWarnings.map((warning) => warning.message),
                );
            }
            if (account.status === 'auth_error') this.registry.markStatus(account.id, 'active');
          } catch (err) {
            if (isEmailError(err) && err.code === 'auth_expired') {
              this.registry.markStatus(account.id, 'auth_error');
            }
            errors.set(
              account.id,
              isEmailError(err)
                ? { code: err.code, message: err.message }
                : { code: 'internal', message: err instanceof Error ? err.message : String(err) },
            );
          }
        }),
    );

    const canReadMembers = this.principal === undefined || canAdminister(this.principal, 'admin.members');
    const canReadLicense = this.principal === undefined || canAdminister(this.principal, 'admin.license');
    const license = canReadLicense ? checkLicenseState(this.db) : undefined;
    return {
      // Re-read so statuses reflect any markStatus writes from the live checks above.
      accounts: this.metadataAccounts().map(({ id, provider, email, status, ownerMemberId }) => ({
        id,
        provider,
        email,
        status,
        ownerMemberId,
        ...(errors.has(id) ? { error: errors.get(id)! } : {}),
        ...(warnings.has(id) ? { warnings: warnings.get(id)! } : {}),
      })),
      ...(canReadMembers ? { members: { count: listMembers(this.db).length } } : {}),
      ...(license
        ? {
            entitlements: license.entitlements,
            ...(license.warning ? { licenseWarning: license.warning } : {}),
          }
        : {}),
      providersAvailable: ['gmail', 'outlook', 'imap'],
      scheduled: this.scheduledStatus(),
    };
  }

  /**
   * Gate for MCP tool calls: throws once the instance is over the entitled
   * caps, after a lapse or once a cap reduction's grace period ends; returns a
   * warning to attach to results while a grace period runs or after a lapse.
   */
  enforceQuota(): string | undefined {
    if (!this.isInternal() && (!this.principal || !canAdminister(this.principal, 'admin.license'))) {
      const state = checkLicenseState(this.db);
      if (state.blocked) {
        throw new EmailError(
          'entitlement_exceeded',
          'This Fluxmail instance is over its plan limits. Ask an administrator to ' +
            (state.entitlements.licensed ? 'upgrade the plan' : 'renew the license') +
            ' or reduce usage.',
        );
      }
      // License dates and renewal state are instance administration details.
      return undefined;
    }
    return assertWithinQuota(this.db).warning;
  }

  private scheduledStatus(): ServiceStatus['scheduled'] {
    if (this.isInternal()) {
      const { pending, nextSendAt } = countPending(this.db);
      return {
        pending,
        ...(nextSendAt !== undefined ? { nextSendAt: new Date(nextSendAt).toISOString() } : {}),
      };
    }
    const accessible = new Set(this.accessibleAccounts().map((account) => account.id));
    const active = listScheduledSends(this.db).filter(
      (row) => accessible.has(row.accountId) && (row.status === 'pending' || row.status === 'sending'),
    );
    const nextSendAt = active.length ? Math.min(...active.map((row) => row.sendAt)) : undefined;
    return {
      pending: active.length,
      ...(nextSendAt !== undefined ? { nextSendAt: new Date(nextSendAt).toISOString() } : {}),
    };
  }

  listFolders(accountId?: string): Promise<Folder[]> {
    return this.withProvider(accountId, (p) => p.listFolders());
  }

  listLabels(accountId?: string): Promise<Label[]> {
    return this.withProvider(accountId, (p) => p.listLabels());
  }

  listSendAs(accountId?: string): Promise<SendAsIdentity[]> {
    return this.withProvider(accountId, (provider, resolvedId, account) =>
      this.sendAsIdentities(provider, resolvedId, account),
    );
  }

  async replaceSendAs(accountId: string, identities: ConfiguredSendAsInput[]): Promise<SendAsIdentity[]> {
    if (!this.principal || !canAdminister(this.principal, 'admin.accounts')) {
      throw new EmailError('permission_denied', 'This operation requires admin.accounts.');
    }
    const account = this.registry.getAccount(accountId);
    if (!canSeeAccountMetadata(this.principal, account)) {
      throw new EmailError('not_found', `No account with id "${accountId}"`);
    }
    const resolvedId = account.id;
    if (account.provider === 'gmail') {
      throw new EmailError('unsupported_capability', 'Manage Gmail send-as addresses in Gmail.');
    }
    const seen = new Set<string>();
    const normalized = identities.map((identity) => {
      const parsed = parseSingleAddress(identity.email.trim());
      if (!parsed) throw new ClientInputError('invalid_request', `Could not parse sender address: "${identity.email}"`);
      const email = parsed.email;
      const key = email.toLowerCase();
      if (key === account.email.toLowerCase()) {
        throw new ClientInputError(
          'invalid_request',
          'Do not include the connected account address in configured aliases.',
        );
      }
      if (seen.has(key)) throw new ClientInputError('invalid_request', `Duplicate sender address: "${email}"`);
      seen.add(key);
      const name = identity.name?.trim();
      return { email, ...(name ? { name } : {}) };
    });
    replaceConfiguredSendAs(this.db, resolvedId, normalized);
    return [
      {
        email: account.email,
        ...(account.displayName ? { name: account.displayName } : {}),
        isPrimary: true,
        source: 'configured',
      },
      ...listConfiguredSendAs(this.db, resolvedId),
    ];
  }

  async listMessages(accountId: string | undefined, q: EmailQuery, page: PageOpts = {}): Promise<MessageSearchPage> {
    const normalized = normalizeEmailQuery(q);
    if (!normalized.success) {
      throw new ClientInputError('invalid_request', normalized.diagnostics.map((item) => item.message).join(' '), {
        diagnostics: normalized.diagnostics,
      });
    }
    const query = normalized.query;
    if (page.includeSearchContext && !query.text) {
      throw new ClientInputError('invalid_request', 'includeSearchContext requires a portable text query.');
    }
    const pageSize = Math.min(Math.max(page.pageSize ?? 25, 1), 100);
    const ownsController = page.signal === undefined;
    const controller = ownsController ? new AbortController() : undefined;
    const signal = page.signal ?? controller!.signal;
    const startedAt = Date.now();
    const softDeadlineAt = page.softDeadlineAt ?? startedAt + SEARCH_SOFT_BUDGET_MS;
    const hardDeadlineAt = startedAt + SEARCH_HARD_DEADLINE_MS;
    let accountProvider: Provider | undefined;
    const timeout = ownsController
      ? setTimeout(
          () => controller!.abort(searchTimeoutError(accountProvider)),
          Math.max(0, hardDeadlineAt - Date.now()),
        )
      : undefined;
    let rejectOnAbort: (() => void) | undefined;
    try {
      const operation = this.withProvider(accountId, async (provider, resolvedId, account) => {
        accountProvider = account.provider;
        assertSearchCapabilities(provider.capabilities, query, { includeSearchContext: page.includeSearchContext });
        const providerToken = page.pageToken
          ? this.cursorCodec.decode(page.pageToken, {
              accountId: resolvedId,
              provider: account.provider,
              query,
              pageSize,
              ...(page.includeSnippet !== undefined ? { includeSnippet: page.includeSnippet } : {}),
              ...(page.includeSearchContext !== undefined ? { includeSearchContext: page.includeSearchContext } : {}),
            })
          : undefined;
        const result = await provider.listMessages(query, {
          pageSize,
          ...(providerToken ? { pageToken: providerToken } : {}),
          ...(page.includeSnippet !== undefined ? { includeSnippet: page.includeSnippet } : {}),
          ...(page.includeSearchContext !== undefined ? { includeSearchContext: page.includeSearchContext } : {}),
          signal,
          softDeadlineAt,
        });
        return {
          ...result,
          exhausted: result.exhausted ?? (!result.nextPageToken && !result.incomplete),
          ...(result.nextPageToken
            ? {
                nextPageToken: this.cursorCodec.encode({
                  accountId: resolvedId,
                  provider: account.provider,
                  query,
                  pageSize,
                  ...(page.includeSnippet !== undefined ? { includeSnippet: page.includeSnippet } : {}),
                  ...(page.includeSearchContext !== undefined
                    ? { includeSearchContext: page.includeSearchContext }
                    : {}),
                  providerToken: result.nextPageToken,
                }),
              }
            : { nextPageToken: undefined }),
        };
      });
      const aborted = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(searchTimeoutError(accountProvider));
        signal.addEventListener('abort', rejectOnAbort, { once: true });
        if (signal.aborted) rejectOnAbort();
      });
      return await Promise.race([operation, aborted]);
    } catch (error) {
      if (signal.aborted) throw searchTimeoutError(accountProvider);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (rejectOnAbort) signal.removeEventListener('abort', rejectOnAbort);
    }
  }

  async searchMessagesBatch(input: BatchSearchInput): Promise<BatchSearchResult> {
    if (input.accounts.length < 1 || input.accounts.length > 20) {
      throw new ClientInputError('invalid_request', 'Batch search requires between 1 and 20 accounts.');
    }
    const seen = new Set<string>();
    for (const account of input.accounts) {
      if (seen.has(account.accountId))
        throw new ClientInputError('invalid_request', 'Batch account IDs must be distinct.');
      seen.add(account.accountId);
    }
    const normalized = normalizeEmailQuery(input.query);
    if (!normalized.success) {
      throw new ClientInputError('invalid_request', normalized.diagnostics.map((item) => item.message).join(' '), {
        diagnostics: normalized.diagnostics,
      });
    }
    const pageSize = Math.min(Math.max(input.pageSize ?? 25, 1), 100);
    if (input.includeSearchContext && !normalized.query.text) {
      throw new ClientInputError('invalid_request', 'includeSearchContext requires a portable text query.');
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    const softDeadlineAt = startedAt + SEARCH_SOFT_BUDGET_MS;
    const timeout = setTimeout(() => controller.abort(searchTimeoutError()), SEARCH_HARD_DEADLINE_MS);
    const groups: BatchSearchGroup[] = [];
    let nextIndex = 0;
    const worker = async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= input.accounts.length) return;
        const account = input.accounts[index]!;
        if (controller.signal.aborted) {
          groups[index] = { accountId: account.accountId, error: batchError(searchTimeoutError()) };
          continue;
        }
        try {
          this.assertAccountAccess(account.accountId);
          const page = await this.listMessages(account.accountId, normalized.query, {
            pageSize,
            ...(account.pageToken ? { pageToken: account.pageToken } : {}),
            ...(input.includeSnippet !== undefined ? { includeSnippet: input.includeSnippet } : {}),
            ...(input.includeSearchContext !== undefined ? { includeSearchContext: input.includeSearchContext } : {}),
            signal: controller.signal,
            softDeadlineAt,
          });
          groups[index] = { accountId: account.accountId, page };
        } catch (error) {
          groups[index] = { accountId: account.accountId, error: batchError(error) };
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(BATCH_SEARCH_CONCURRENCY, input.accounts.length) }, () => worker()),
      );
    } finally {
      clearTimeout(timeout);
    }
    return { groups, exhausted: groups.every((group) => group.page?.exhausted === true) };
  }

  getMessage(accountId: string | undefined, id: string, options?: GetMessageOpts): Promise<Message> {
    return this.withProvider(accountId, (p) => (options ? p.getMessage(id, options) : p.getMessage(id)));
  }

  getThread(accountId: string | undefined, threadId: string): Promise<Thread> {
    return this.withProvider(accountId, (p) => p.getThread(threadId));
  }

  async createDraft(accountId: string | undefined, d: SendInput): Promise<Message> {
    this.assertMailContent(d);
    return this.withProvider(accountId, async (p, _id, account) => {
      return p.createDraft(await this.resolveRecipients(p, account, d));
    });
  }

  async updateDraft(accountId: string | undefined, draftId: string, d: SendInput): Promise<Message> {
    this.assertMailContent(d);
    return this.withProvider(accountId, async (p, _id, account) => {
      return p.updateDraft(draftId, await this.resolveRecipients(p, account, d));
    });
  }

  deleteDraft(accountId: string | undefined, draftId: string): Promise<void> {
    return this.withProvider(accountId, (p) => p.deleteDraft(draftId));
  }

  getDraft(accountId: string | undefined, draftId: string): Promise<Message> {
    return this.withProvider(accountId, (p) => p.getDraft(draftId));
  }

  previewSend(accountId: string | undefined, input: SendInput | { draftId: string }): Promise<SendPreview> {
    return this.withProvider(accountId, async (provider, resolvedId, account) => {
      if ('draftId' in input) {
        const draft = await provider.getDraft(input.draftId);
        if (draft.from?.email && draft.from.email.toLowerCase() !== account.email.toLowerCase()) {
          await this.validateSender(provider, resolvedId, account, draft.from.email);
        }
        return {
          accountId: resolvedId,
          from: draft.from?.email ?? account.email,
          to: draft.to,
          cc: draft.cc ?? [],
          bcc: draft.bcc ?? [],
          subject: draft.subject,
          attachments: (draft.attachments ?? []).map(({ filename, mimeType, sizeBytes }) => ({
            filename,
            mimeType,
            sizeBytes,
          })),
          bodyTextChars: draft.body?.text?.length ?? 0,
          bodyHtmlChars: draft.body?.html?.length ?? 0,
        };
      }
      this.assertMailContent(input);
      const resolved = await this.resolveRecipients(provider, account, input);
      const subject =
        resolved.subject ??
        (input.replyToMessageId ? replySubject((await provider.getMessage(input.replyToMessageId)).subject) : '');
      return {
        accountId: resolvedId,
        from: resolved.from ?? account.email,
        to: resolved.to ?? [],
        cc: resolved.cc ?? [],
        bcc: resolved.bcc ?? [],
        subject,
        attachments: (resolved.attachments ?? []).map(({ filename, mimeType, content }) => ({
          filename,
          mimeType,
          sizeBytes: Buffer.byteLength(content, 'base64'),
        })),
        bodyTextChars: resolved.body.text?.length ?? 0,
        bodyHtmlChars: resolved.body.html?.length ?? 0,
      };
    });
  }

  getDelivery(accountId: string, operationId: string): DeliveryOperation {
    this.assertAccountAccess(accountId);
    if (!this.principal) throw new EmailError('permission_denied', 'A member session is required.');
    return new DeliveryCoordinator(this.db).get(
      this.principal.principalId,
      this.principal.memberId,
      accountId,
      operationId,
    );
  }

  deliver(
    accountId: string | undefined,
    input: SendInput | { draftId: string },
    key: string,
  ): Promise<DeliveryOperation> {
    const resolvedId = this.resolveScopedAccountId(accountId);
    if (!this.principal) throw new EmailError('permission_denied', 'A member session is required.');
    return new DeliveryCoordinator(this.db).run(
      {
        principalId: this.principal.principalId,
        memberId: this.principal.memberId,
        accountId: resolvedId,
        key,
        kind: 'send',
        request: input,
      },
      () => this.send(resolvedId, input),
    );
  }

  deliverForward(accountId: string | undefined, input: ForwardInput, key: string): Promise<DeliveryOperation> {
    const resolvedId = this.resolveScopedAccountId(accountId);
    if (!this.principal) throw new EmailError('permission_denied', 'A member session is required.');
    return new DeliveryCoordinator(this.db).run(
      {
        principalId: this.principal.principalId,
        memberId: this.principal.memberId,
        accountId: resolvedId,
        key,
        kind: 'forward',
        request: input,
      },
      () => this.forward(resolvedId, input),
    );
  }

  deliverScheduled(
    accountId: string,
    draftId: string,
    scheduleId: string,
    ownsClaim: () => boolean = () => true,
  ): Promise<DeliveryOperation> {
    return new DeliveryCoordinator(this.db).fireScheduled(
      accountId,
      draftId,
      scheduleId,
      () =>
        this.withProvider(accountId, async (provider, resolvedId, account) => {
          const draft = await provider.getDraft(draftId);
          if (draft.from?.email && draft.from.email.toLowerCase() !== account.email.toLowerCase()) {
            await this.validateSender(provider, resolvedId, account, draft.from.email);
          }
        }),
      () =>
        this.withProvider(accountId, async (provider, resolvedId) => {
          if (!ownsClaim()) throw new Error('Scheduled delivery claim is no longer owned.');
          const result = await provider.send({ draftId });
          const pending = findPendingByDraft(this.db, resolvedId, draftId);
          if (pending) {
            markSent(this.db, pending.id, result);
            this.onScheduleChanged();
          }
          return result;
        }),
      ownsClaim,
    );
  }

  scheduleDelivery(
    accountId: string | undefined,
    input: SendInput | { draftId: string },
    sendAt: string,
    key: string,
  ): Promise<DeliveryOperation> {
    const resolvedId = this.resolveScopedAccountId(accountId);
    if (!this.principal) throw new EmailError('permission_denied', 'A member session is required.');
    let createdSchedule = false;
    const scheduled = new DeliveryCoordinator(this.db).schedule(
      {
        principalId: this.principal.principalId,
        memberId: this.principal.memberId,
        accountId: resolvedId,
        key,
        request: { input, sendAt },
      },
      async () => {
        const result = await this.createSchedule(resolvedId, input, sendAt);
        createdSchedule = true;
        return result;
      },
    );
    return scheduled.finally(() => {
      if (createdSchedule) this.onScheduleChanged();
    });
  }

  async send(accountId: string | undefined, input: SendInput | { draftId: string }): Promise<SendResult> {
    if (!('draftId' in input)) this.assertMailContent(input);
    return this.withProvider(accountId, async (p, resolvedId, account) => {
      if ('draftId' in input) {
        const draft = await p.getDraft(input.draftId);
        if (draft.from?.email && draft.from.email.toLowerCase() !== account.email.toLowerCase()) {
          await this.validateSender(p, resolvedId, account, draft.from.email);
        }
        const result = await p.send({ draftId: input.draftId });
        // Sending a scheduled draft now supersedes its schedule.
        const pending = findPendingByDraft(this.db, resolvedId, input.draftId);
        if (pending) {
          markSent(this.db, pending.id, result);
          this.onScheduleChanged();
        }
        return result;
      }
      return p.send(await this.resolveRecipients(p, account, input));
    });
  }

  /**
   * Draft-backed scheduled send: the content becomes a real provider draft
   * immediately; only the schedule (draft id + fire time) is stored locally.
   */
  async scheduleSend(
    accountId: string | undefined,
    input: SendInput | { draftId: string },
    sendAtIso: string,
  ): Promise<ScheduledSendInfo> {
    const scheduled = await this.createSchedule(accountId, input, sendAtIso);
    this.onScheduleChanged();
    return scheduled;
  }

  private async createSchedule(
    accountId: string | undefined,
    input: SendInput | { draftId: string },
    sendAtIso: string,
  ): Promise<ScheduledSendInfo> {
    if (!('draftId' in input)) this.assertMailContent(input);
    const sendAt = resolveSendAt(sendAtIso);
    const { draft, resolvedId } = await this.withProvider(accountId, async (p, id, account) => {
      let message: Message;
      if ('draftId' in input) {
        message = await p.getDraft(input.draftId);
      } else {
        const resolved = await this.resolveRecipients(p, account, input);
        if (!resolved.to?.length && !resolved.cc?.length && !resolved.bcc?.length) {
          throw new ClientInputError('invalid_request', 'Cannot schedule a message with no recipients');
        }
        message = await p.createDraft(resolved);
      }
      return { draft: message, resolvedId: id };
    });
    if (!draft.draftId) {
      throw new EmailError('provider_unavailable', 'Provider did not return a draft id');
    }
    const row = createScheduledSend(this.db, {
      accountId: resolvedId,
      draftId: draft.draftId,
      sendAt,
      ...(draft.subject !== undefined ? { subject: draft.subject } : {}),
      ...(draft.to?.length ? { toRecipients: formatAddressList(draft.to) } : {}),
    });
    return toScheduledInfo(row);
  }

  listScheduled(accountId?: string): ScheduledSendInfo[] {
    const coordinator = new DeliveryCoordinator(this.db);
    const withOperation = (row: ScheduledSendRow): ScheduledSendInfo => {
      const operationId = coordinator.findScheduled(row.accountId, row.id)?.operationId;
      return { ...toScheduledInfo(row), ...(operationId ? { operationId } : {}) };
    };
    if (accountId !== undefined) {
      return listScheduledSends(this.db, this.resolveScopedAccountId(accountId)).map(withOperation);
    }
    // Listing must work across accounts, but a member key only sees its own mailboxes'.
    const rows = listScheduledSends(this.db);
    if (this.isInternal()) return rows.map(withOperation);
    const accessible = new Set(this.accessibleAccounts().map((a) => a.id));
    return rows.filter((r) => accessible.has(r.accountId)).map(withOperation);
  }

  /** Cancels a pending schedule; the provider draft is kept. */
  cancelScheduled(scheduleId: string): { scheduleId: string; draftId: string; draftKept: true } {
    const row = getScheduledSend(this.db, scheduleId);
    // A member key cannot see (or cancel) schedules on mailboxes it cannot reach.
    if (!row || !this.canAccess(this.registry.getAccount(row.accountId))) {
      throw new EmailError('not_found', `No scheduled send with id ${scheduleId}`);
    }
    if (row.status !== 'pending') {
      throw new ClientInputError('invalid_request', `Scheduled send ${scheduleId} is already ${row.status}`);
    }
    if (!cancelScheduledSend(this.db, scheduleId)) {
      throw new ClientInputError('invalid_request', `Scheduled send ${scheduleId} has already started sending`);
    }
    new DeliveryCoordinator(this.db).cancelScheduled(row.accountId, scheduleId);
    this.onScheduleChanged();
    return { scheduleId, draftId: row.draftId, draftKept: true };
  }

  /**
   * Reply recipient computation (provider-agnostic): when replying without explicit
   * recipients, derive them from the original message: Reply-To/From for a plain
   * reply; plus original To/Cc (minus our own address) for reply-all.
   */
  private async resolveRecipients(
    p: ReturnType<AccountRegistry['getProvider']>,
    account: Account,
    input: SendInput,
  ): Promise<DraftInput> {
    const { replyAll, ...draft } = input;
    if (!draft.replyToMessageId) {
      if (draft.from) draft.from = (await this.validateSender(p, account.id, account, draft.from)).email;
      return draft;
    }
    const original = await p.getMessage(draft.replyToMessageId);
    const identities = await this.sendAsIdentities(p, account.id, account);
    const requestedSender = draft.from;
    const selected =
      requestedSender !== undefined
        ? await this.validateSender(p, account.id, account, requestedSender, identities)
        : selectReplySender(original, identities);
    if (requestedSender !== undefined || !selected.isPrimary) draft.from = selected.email;
    else delete draft.from;
    if (!draft.to?.length) {
      const recipients = computeReplyRecipients(
        original,
        identities.map((identity) => identity.email),
        replyAll ?? false,
      );
      draft.to = recipients.to;
      if (recipients.cc.length && !draft.cc?.length) draft.cc = recipients.cc;
    }
    return draft;
  }

  private async sendAsIdentities(
    provider: ReturnType<AccountRegistry['getProvider']>,
    accountId: string,
    account: Account,
  ): Promise<SendAsIdentity[]> {
    if (provider.listSendAs) {
      const discovered = await provider.listSendAs();
      const primaryIndex = discovered.findIndex(
        (identity) => identity.email.toLowerCase() === account.email.toLowerCase(),
      );
      if (primaryIndex >= 0) {
        return discovered.map((identity, index) => ({ ...identity, isPrimary: index === primaryIndex }));
      }
      return [
        {
          email: account.email,
          ...(account.displayName ? { name: account.displayName } : {}),
          isPrimary: true,
          source: 'provider',
        },
        ...discovered.map((identity) => ({ ...identity, isPrimary: false })),
      ];
    }
    return [
      {
        email: account.email,
        ...(account.displayName ? { name: account.displayName } : {}),
        isPrimary: true,
        source: 'configured',
      },
      ...listConfiguredSendAs(this.db, accountId),
    ];
  }

  private async validateSender(
    provider: ReturnType<AccountRegistry['getProvider']>,
    accountId: string,
    account: Account,
    sender: string,
    known?: SendAsIdentity[],
  ): Promise<SendAsIdentity> {
    const parsed = parseSingleAddress(sender.trim());
    if (!parsed) throw new ClientInputError('invalid_request', `Could not parse sender address: "${sender}"`);
    if (parsed.email.toLowerCase() === account.email.toLowerCase()) {
      return {
        email: account.email,
        ...(account.displayName ? { name: account.displayName } : {}),
        isPrimary: true,
        source: account.provider === 'gmail' ? 'provider' : 'configured',
      };
    }
    const identity = (known ?? (await this.sendAsIdentities(provider, accountId, account))).find(
      (candidate) => candidate.email.toLowerCase() === parsed.email.toLowerCase(),
    );
    if (!identity) throw new ClientInputError('invalid_request', `Sender address "${parsed.email}" is not available.`);
    return identity;
  }

  async forward(accountId: string | undefined, input: ForwardInput): Promise<SendResult> {
    if (Buffer.byteLength(input.comment ?? '', 'utf8') > 1024 * 1024) {
      throw new ClientInputError('invalid_request', 'Forward comment exceeds the 1 MiB body limit.');
    }
    return this.withProvider(accountId, async (p, resolvedId, account) => {
      const original = await p.getMessage(input.messageId);
      const includeAttachments = input.includeAttachments ?? true;

      const attachments: AttachmentInput[] = [];
      if (includeAttachments) {
        const metadata = original.attachments ?? [];
        if (metadata.length > 20)
          throw new ClientInputError('invalid_request', 'A message may have at most 20 attachments.');
        if (metadata.reduce((total, item) => total + item.sizeBytes, 0) > this.maxAttachmentBytes) {
          throw new ClientInputError('invalid_request', 'Combined attachments exceed the configured size limit.');
        }
        for (const meta of metadata) {
          const { content } = await p.getAttachment(original.id, meta.id);
          attachments.push({
            filename: meta.filename,
            mimeType: meta.mimeType,
            content: content.toString('base64'),
            ...(meta.contentId ? { contentId: meta.contentId } : {}),
            ...(meta.disposition ? { disposition: meta.disposition } : {}),
          });
        }
      }

      const draft: DraftInput = {
        ...(input.from ? { from: (await this.validateSender(p, resolvedId, account, input.from)).email } : {}),
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: forwardSubject(original.subject),
        body: buildForwardBody(original, input.comment),
        ...(attachments.length ? { attachments } : {}),
      };
      this.assertMailContent(draft);
      return p.send(draft);
    });
  }

  async modify(accountId: string | undefined, ids: string[], action: ModifyAction): Promise<ModifyResult> {
    const unique = [...new Set(ids)];
    if (unique.length < 1 || unique.length > 100) {
      throw new ClientInputError('invalid_request', 'Modify between 1 and 100 distinct messages.');
    }
    const resolvedId = this.resolveScopedAccountId(accountId);
    const result = await this.withProvider(resolvedId, async (provider) => {
      const outcomes: Array<'succeeded' | { code: string } | 'uncertain'> = Array.from(
        { length: unique.length },
        () => 'uncertain',
      );
      let next = 0;
      const worker = async () => {
        for (;;) {
          const index = next++;
          if (index >= unique.length) return;
          try {
            await provider.modify([unique[index]!], action);
            outcomes[index] = 'succeeded';
          } catch (error) {
            outcomes[index] = isDefiniteDeliveryFailure(error)
              ? { code: isEmailError(error) ? error.code : 'internal' }
              : 'uncertain';
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, unique.length) }, () => worker()));
      return {
        action,
        succeededIds: unique.filter((_, index) => outcomes[index] === 'succeeded'),
        failed: unique.flatMap((messageId, index) => {
          const outcome = outcomes[index];
          return typeof outcome === 'object' ? [{ messageId, code: outcome.code }] : [];
        }),
        uncertainIds: unique.filter((_, index) => outcomes[index] === 'uncertain'),
      };
    });
    if (result.failed.some(({ code }) => code === 'auth_expired')) {
      this.registry.markStatus(resolvedId, 'auth_error');
    }
    return result;
  }

  getAttachment(
    accountId: string | undefined,
    messageId: string,
    attachmentId: string,
    maxBytes?: number,
  ): Promise<{ meta: AttachmentMeta; content: Buffer; accountId: string }> {
    return this.withProvider(accountId, async (p, resolvedId) => ({
      ...(await p.getAttachment(messageId, attachmentId, { maxBytes })),
      accountId: resolvedId,
    }));
  }

  private assertMailContent(input: DraftInput): void {
    const bodyBytes =
      Buffer.byteLength(input.body.text ?? '', 'utf8') + Buffer.byteLength(input.body.html ?? '', 'utf8');
    if (bodyBytes > 1024 * 1024) {
      throw new ClientInputError('invalid_request', 'Text and HTML bodies together must be at most 1 MiB.');
    }
    const attachments = input.attachments ?? [];
    if (attachments.length > 20)
      throw new ClientInputError('invalid_request', 'A message may have at most 20 attachments.');
    let total = 0;
    for (const attachment of attachments) {
      const content = attachment.content;
      const paddingIndex = content.search(/[^A-Za-z0-9+/]/);
      const padding = paddingIndex === -1 ? '' : content.slice(paddingIndex);
      if (content.length % 4 !== 0 || (padding !== '' && padding !== '=' && padding !== '==')) {
        throw new ClientInputError('invalid_request', 'Attachment content must be base64.');
      }
      total += Buffer.byteLength(attachment.content, 'base64');
      if (total > this.maxAttachmentBytes) {
        throw new ClientInputError('invalid_request', 'Combined attachments exceed the configured size limit.');
      }
    }
  }
}
