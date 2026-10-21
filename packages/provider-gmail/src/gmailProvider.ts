import { gmail, type gmail_v1 } from 'googleapis/build/src/apis/gmail/index.js';
import type { OAuth2Client } from 'googleapis-common';
import {
  EmailError,
  invalidResponseError,
  extractSearchContext,
  isEmailError,
  normalizeEmailQuery,
  replySubject,
  type AttachmentMeta,
  type Capabilities,
  type DraftInput,
  type EmailProvider,
  type EmailQuery,
  type Folder,
  type FolderRole,
  type GetAttachmentOpts,
  type GetMessageOpts,
  type Label,
  type Message,
  type ModifyAction,
  type MessageSearchPage,
  type PageOpts,
  type SendResult,
  type SendAsIdentity,
  type Thread,
} from '@fluxmail/core';
import { toGmailQuery, ROLE_TO_LABEL } from './query.js';
import {
  decodeBase64Url,
  decodeTextPart,
  encodeBase64Url,
  findAttachment,
  parseGmailMessage,
  parseGmailMessageWithParts,
  walkParts,
} from './parse.js';
import { buildRawMessage, type ThreadingHeaders } from './mime.js';
import { isInsufficientScope, isRetryableForNonIdempotentRequest, withRetry } from './errors.js';

const LABEL_TO_ROLE: Record<string, FolderRole> = {
  INBOX: 'inbox',
  SENT: 'sent',
  DRAFT: 'drafts',
  TRASH: 'trash',
  SPAM: 'spam',
  STARRED: 'starred',
};

const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Bcc',
  'Reply-To',
  'Subject',
  'Date',
  'Message-ID',
  'References',
  'In-Reply-To',
];
const LABEL_CACHE_TTL_MS = 60_000;
const SEND_AS_CACHE_TTL_MS = 60_000;
const HYDRATE_CONCURRENCY = 10;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const NON_IDEMPOTENT_MAX_RETRIES = 3;
const BATCH_MODIFY_MAX_IDS = 1_000;
const FILTERED_PAGE_TOKEN_VERSION = 1;
const FILTERED_PAGE_TOKEN_PREFIX = 'fm1.';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const IMMUTABLE_SYSTEM_LABELS = new Set(['sent', 'draft', 'drafts', 'trash']);

interface FilteredPageToken {
  v: typeof FILTERED_PAGE_TOKEN_VERSION;
  pendingIds: string[];
  providerToken?: string;
}

function invalidFilteredPageToken(): EmailError {
  return new EmailError('invalid_request', 'Invalid Gmail page token');
}

function decodeFilteredPageToken(token: string | undefined): FilteredPageToken {
  if (!token) return { v: FILTERED_PAGE_TOKEN_VERSION, pendingIds: [] };
  try {
    const encoded = token.startsWith(FILTERED_PAGE_TOKEN_PREFIX)
      ? token.slice(FILTERED_PAGE_TOKEN_PREFIX.length)
      : token;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<FilteredPageToken>;
    if (
      parsed.v !== FILTERED_PAGE_TOKEN_VERSION ||
      !Array.isArray(parsed.pendingIds) ||
      parsed.pendingIds.length > MAX_PAGE_SIZE ||
      parsed.pendingIds.some((id) => typeof id !== 'string' || !id) ||
      (parsed.providerToken !== undefined && (typeof parsed.providerToken !== 'string' || !parsed.providerToken))
    ) {
      throw new Error();
    }
    return {
      v: FILTERED_PAGE_TOKEN_VERSION,
      pendingIds: parsed.pendingIds,
      ...(parsed.providerToken ? { providerToken: parsed.providerToken } : {}),
    };
  } catch {
    throw invalidFilteredPageToken();
  }
}

function encodeFilteredPageToken(pendingIds: string[], providerToken: string | undefined): string {
  const encoded = Buffer.from(
    JSON.stringify({
      v: FILTERED_PAGE_TOKEN_VERSION,
      pendingIds,
      ...(providerToken ? { providerToken } : {}),
    } satisfies FilteredPageToken),
  ).toString('base64url');
  return `${FILTERED_PAGE_TOKEN_PREFIX}${encoded}`;
}

function assertAttachmentSize(sizeBytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && sizeBytes > maxBytes) {
    throw new EmailError('invalid_request', 'Attachment is too large to return through MCP.', {
      sizeBytes,
      maxBytes,
    });
  }
}

export interface GmailProviderOptions {
  accountId: string;
  email: string;
  /** Stored sender name used when Gmail settings and the current Google profile have no name. */
  displayName?: string;
  auth: OAuth2Client;
}

export const GMAIL_CAPABILITIES: Capabilities = {
  labels: true,
  serverThreads: true,
  serverSearch: 'rich',
  search: {
    filters: ['folder', 'text', 'from', 'to', 'subject', 'read', 'starred', 'hasAttachment', 'after', 'before'],
    folderRoles: {
      inbox: 'available',
      sent: 'available',
      drafts: 'available',
      archive: 'available',
      spam: 'available',
      trash: 'available',
      all: 'available',
    },
    nativeQuery: { syntax: 'gmail', availability: 'available' },
  },
  snippets: true,
  searchContext: true,
};

export class GmailProvider implements EmailProvider {
  readonly capabilities: Capabilities = GMAIL_CAPABILITIES;

  private readonly gmail: gmail_v1.Gmail;
  private readonly accountId: string;
  private readonly email: string;
  private readonly displayName: string | undefined;
  private readonly auth: OAuth2Client;
  private labelCache: { fetchedAt: number; labels: gmail_v1.Schema$Label[] } | null = null;
  private sendAsCache: { fetchedAt: number; identities: SendAsIdentity[] } | null = null;
  /** undefined = not resolved yet; null = no name available. */
  private senderName: string | null | undefined;

  constructor(opts: GmailProviderOptions) {
    this.accountId = opts.accountId;
    this.email = opts.email;
    this.displayName = opts.displayName;
    this.auth = opts.auth;
    this.gmail = gmail({ version: 'v1', auth: opts.auth });
  }

  /**
   * Sender name for the From header, matching what the Gmail UI would use:
   * the primary send-as displayName when set, else the current Google profile
   * name, with the stored account name as an offline fallback.
   */
  private async resolveSenderName(): Promise<string | null> {
    if (this.senderName !== undefined) return this.senderName;
    let lookupFailed = false;
    let sendAsName: string | undefined;
    try {
      const primary = (await this.listSendAs()).find((identity) => identity.isPrimary);
      sendAsName = primary?.name?.trim() || undefined;
    } catch {
      // Fall through to the profile and stored account name.
      lookupFailed = true;
    }
    if (sendAsName) {
      return sendAsName;
    }

    try {
      const res = await withRetry(() => this.auth.request<{ name?: string }>({ url: GOOGLE_USERINFO_URL }));
      const profileName = res.data.name?.trim();
      if (profileName) {
        this.senderName = profileName;
        return this.senderName;
      }
    } catch {
      // Profile lookup is optional; sending should still work without it.
      lookupFailed = true;
    }
    const fallback = this.displayName?.trim() || null;
    // Cache "no name configured", but not a transient lookup failure: the next
    // send should try Gmail again rather than pin the offline fallback.
    if (!lookupFailed) this.senderName = fallback;
    return fallback;
  }

  async testConnection(): Promise<void> {
    await withRetry(() => this.gmail.users.getProfile({ userId: 'me' }));
  }

  async listSendAs(): Promise<SendAsIdentity[]> {
    if (this.sendAsCache && Date.now() - this.sendAsCache.fetchedAt < SEND_AS_CACHE_TTL_MS) {
      return this.sendAsCache.identities;
    }
    const res = await withRetry(() => this.gmail.users.settings.sendAs.list({ userId: 'me' }));
    const identities = (res.data.sendAs ?? []).flatMap((identity) => {
      const email = identity.sendAsEmail?.trim() || (identity.isPrimary ? this.email : undefined);
      if (!email || (!identity.isPrimary && identity.verificationStatus !== 'accepted')) return [];
      const name = identity.displayName?.trim();
      const replyTo = identity.replyToAddress?.trim();
      return [
        {
          email,
          ...(name ? { name } : {}),
          ...(replyTo ? { replyTo } : {}),
          isPrimary: Boolean(identity.isPrimary),
          source: 'provider' as const,
        },
      ];
    });
    if (!identities.some((identity) => identity.email.toLowerCase() === this.email.toLowerCase())) {
      identities.unshift({
        email: this.email,
        ...(this.displayName ? { name: this.displayName } : {}),
        isPrimary: true,
        source: 'provider',
      });
    }
    this.sendAsCache = { fetchedAt: Date.now(), identities };
    return identities;
  }

  private async labels(forceRefresh = false, signal?: AbortSignal): Promise<gmail_v1.Schema$Label[]> {
    if (!forceRefresh && this.labelCache && Date.now() - this.labelCache.fetchedAt < LABEL_CACHE_TTL_MS) {
      return this.labelCache.labels;
    }
    const res = await withRetry(
      () =>
        signal
          ? this.gmail.users.labels.list({ userId: 'me' }, { signal })
          : this.gmail.users.labels.list({ userId: 'me' }),
      3,
      undefined,
      signal,
    );
    const labels = res.data.labels ?? [];
    this.labelCache = { fetchedAt: Date.now(), labels };
    return labels;
  }

  private async labelNameMap(signal?: AbortSignal): Promise<Map<string, string>> {
    const labels = await this.labels(false, signal);
    return new Map(labels.filter((l) => l.id && l.name).map((l) => [l.id!, l.name!]));
  }

  /** Gmail messages carry the DRAFT label, but only Draft resources expose the draft id. */
  private async attachDraftIds(messages: Message[], signal?: AbortSignal): Promise<void> {
    const unresolved = new Map(
      messages.filter((message) => message.flags.draft).map((message) => [message.id, message]),
    );
    if (!unresolved.size) return;

    let pageToken: string | undefined;
    do {
      const res = await withRetry(
        () => {
          const params = {
            userId: 'me',
            maxResults: 500,
            ...(pageToken ? { pageToken } : {}),
          };
          return signal ? this.gmail.users.drafts.list(params, { signal }) : this.gmail.users.drafts.list(params);
        },
        3,
        undefined,
        signal,
      );
      for (const draft of res.data.drafts ?? []) {
        const message = draft.message?.id ? unresolved.get(draft.message.id) : undefined;
        if (message && draft.id) {
          message.draftId = draft.id;
          unresolved.delete(message.id);
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (unresolved.size && pageToken);
  }

  private async resolveLabelId(folder: string, createIfMissing = false, systemLabelsAllowed = true): Promise<string> {
    const role = folder.toLowerCase();
    if (IMMUTABLE_SYSTEM_LABELS.has(role)) {
      throw new EmailError('invalid_request', `Gmail does not allow changing the "${role}" system label`);
    }
    if (ROLE_TO_LABEL[role]) {
      if (!systemLabelsAllowed) {
        throw new EmailError('invalid_request', `Use the dedicated message action instead of changing ${role}`);
      }
      return ROLE_TO_LABEL[role];
    }
    const labels = await this.labels();
    const match = labels.find((l) => l.id === folder || l.name?.toLowerCase() === folder.toLowerCase());
    if (match?.id) {
      if (!systemLabelsAllowed && match.type === 'system') {
        throw new EmailError('invalid_request', `Use the dedicated message action instead of changing ${match.name}`);
      }
      return match.id;
    }
    if (!createIfMissing) {
      throw new EmailError('not_found', `No Gmail label or folder named "${folder}"`);
    }
    const created = await withRetry(() =>
      this.gmail.users.labels.create({ userId: 'me', requestBody: { name: folder } }),
    );
    this.labelCache = null;
    if (!created.data.id) throw invalidResponseError('Gmail did not return a label id');
    return created.data.id;
  }

  async listMessages(input: EmailQuery, page?: PageOpts): Promise<MessageSearchPage> {
    page?.signal?.throwIfAborted();
    const normalized = normalizeEmailQuery(input);
    if (!normalized.success) {
      throw new EmailError('invalid_request', normalized.diagnostics.map((item) => item.message).join(' '), {
        diagnostics: normalized.diagnostics,
      });
    }
    const q = normalized.query;
    if (page?.includeSearchContext && !q.text) {
      throw new EmailError('invalid_request', 'includeSearchContext requires a portable text query.');
    }
    const labels = await this.labels(false, page?.signal);
    const gq = toGmailQuery(q, (folder) => {
      const match = labels.find((l) => l.id === folder || l.name?.toLowerCase() === folder.toLowerCase());
      return match?.id ?? null;
    });
    const pageSize = Math.min(Math.max(page?.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const labelNames = await this.labelNameMap(page?.signal);
    const items: Message[] = [];
    const localFilter = q.hasAttachment !== undefined || q.after !== undefined || q.before !== undefined;
    let inspectedCandidates = 0;
    const decodedToken =
      localFilter || page?.pageToken?.startsWith(FILTERED_PAGE_TOKEN_PREFIX)
        ? decodeFilteredPageToken(page?.pageToken)
        : undefined;
    let pendingIds = decodedToken?.pendingIds ?? [];
    let providerToken = decodedToken ? decodedToken.providerToken : page?.pageToken;
    let remainingIds: string[] = [];
    let timeLimited = false;
    const diagnostics: NonNullable<MessageSearchPage['diagnostics']> = [];
    do {
      let ids: string[];
      if (pendingIds.length) {
        ids = pendingIds;
        pendingIds = [];
      } else {
        const batchSize = Math.min(localFilter ? MAX_PAGE_SIZE : pageSize - items.length, 1_000 - inspectedCandidates);
        const res = await withRetry(
          () => {
            const params = {
              userId: 'me',
              maxResults: batchSize,
              ...(providerToken ? { pageToken: providerToken } : {}),
              ...(gq.q ? { q: gq.q } : {}),
              ...(gq.labelIds ? { labelIds: gq.labelIds } : {}),
              ...(gq.includeSpamTrash ? { includeSpamTrash: true } : {}),
            };
            return page?.signal
              ? this.gmail.users.messages.list(params, { signal: page.signal })
              : this.gmail.users.messages.list(params);
          },
          3,
          undefined,
          page?.signal,
        );
        ids = (res.data.messages ?? []).map((message) => message.id!).filter(Boolean);
        providerToken = res.data.nextPageToken ?? undefined;
      }
      let processedIds = 0;
      for (let i = 0; i < ids.length; i += HYDRATE_CONCURRENCY) {
        page?.signal?.throwIfAborted();
        if (page?.softDeadlineAt !== undefined && Date.now() >= page.softDeadlineAt) {
          timeLimited = true;
          break;
        }
        const chunk = ids.slice(i, i + HYDRATE_CONCURRENCY);
        const contextTargets: { message: Message; full?: gmail_v1.Schema$Message }[] = [];
        const fetched = await Promise.allSettled(
          chunk.map((id) =>
            withRetry(
              () => {
                const params = {
                  userId: 'me',
                  id,
                  format: q.hasAttachment !== undefined ? ('full' as const) : ('metadata' as const),
                  metadataHeaders: METADATA_HEADERS,
                };
                return page?.signal
                  ? this.gmail.users.messages.get(params, { signal: page.signal })
                  : this.gmail.users.messages.get(params);
              },
              3,
              undefined,
              page?.signal,
            ),
          ),
        );
        for (const result of fetched) {
          inspectedCandidates += 1;
          processedIds += 1;
          if (result.status === 'rejected') {
            if (isEmailError(result.reason) && result.reason.code === 'not_found') continue;
            throw result.reason;
          }
          const message = parseGmailMessage(result.value.data, {
            accountId: this.accountId,
            labelNames,
            includeBody: false,
            includeAttachments: q.hasAttachment !== undefined,
          });
          if (page?.includeSnippet === false) delete message.snippet;
          if (q.after && message.date < `${q.after}T00:00:00.000Z`) continue;
          if (q.before && message.date >= `${q.before}T00:00:00.000Z`) continue;
          if (q.hasAttachment !== undefined) {
            const hasAttachment =
              message.attachments?.some((attachment) => attachment.disposition !== 'inline') ?? false;
            if (hasAttachment !== q.hasAttachment) continue;
          }
          if (page?.includeSearchContext) {
            // Full MIME is already loaded when local attachment filtering required it.
            contextTargets.push(q.hasAttachment !== undefined ? { message, full: result.value.data } : { message });
          }
          items.push(message);
          if (items.length === pageSize) break;
        }
        if (q.text && contextTargets.length) {
          const queryText = q.text;
          await Promise.all(
            contextTargets.map(({ message, full }) =>
              this.attachSearchContext(message, full, queryText, diagnostics, page?.signal),
            ),
          );
        }
        if (timeLimited || items.length === pageSize || inspectedCandidates >= 1_000) break;
      }
      remainingIds = ids.slice(processedIds);
      if (timeLimited || items.length === pageSize || inspectedCandidates >= 1_000) break;
      if (!providerToken) break;
    } while (items.length < pageSize && inspectedCandidates < 1_000);

    await this.attachDraftIds(items, page?.signal);
    const out: MessageSearchPage = {
      items,
      exhausted: false,
      ...(localFilter ? { inspectedCandidates } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
    };
    const nextPageToken =
      localFilter || timeLimited
        ? remainingIds.length || providerToken
          ? encodeFilteredPageToken(remainingIds, providerToken)
          : undefined
        : providerToken;
    if (nextPageToken) out.nextPageToken = nextPageToken;
    if (items.length < pageSize && inspectedCandidates >= 1_000 && nextPageToken) {
      out.incomplete = true;
      out.incompleteReason = 'scan_limit';
    }
    if (timeLimited && nextPageToken) {
      out.incomplete = true;
      out.incompleteReason = 'time_limit';
    }
    out.exhausted = !nextPageToken && out.incompleteReason !== 'provider_limit';
    return out;
  }

  private async attachSearchContext(
    message: Message,
    full: gmail_v1.Schema$Message | undefined,
    queryText: string,
    diagnostics: NonNullable<MessageSearchPage['diagnostics']>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      let raw = full;
      if (!raw) {
        const params = { userId: 'me', id: message.id, format: 'full' as const };
        const response = await withRetry(
          () => (signal ? this.gmail.users.messages.get(params, { signal }) : this.gmail.users.messages.get(params)),
          3,
          undefined,
          signal,
        );
        raw = response.data;
      }
      message.searchContext = await this.searchContext(raw, queryText, signal);
    } catch {
      signal?.throwIfAborted();
      message.searchContext = { status: 'unavailable' };
      diagnostics.push({
        code: 'search_context_unavailable',
        severity: 'warning',
        message: 'Search context could not be loaded for a message. Message metadata is still available.',
      });
    }
  }

  private async searchContext(
    raw: gmail_v1.Schema$Message,
    queryText: string,
    signal?: AbortSignal,
  ): Promise<NonNullable<Message['searchContext']>> {
    const walked = walkParts(raw.payload);
    for (const field of ['text', 'html'] as const) {
      if (walked.body[field] !== undefined) {
        return extractSearchContext({ [field]: walked.body[field] }, queryText);
      }
      const external = walked.externalBodyParts[field];
      if (!external) continue;
      const params = { userId: 'me', messageId: raw.id!, id: external.attachmentId };
      const response = await withRetry(
        () =>
          signal
            ? this.gmail.users.messages.attachments.get(params, { signal })
            : this.gmail.users.messages.attachments.get(params),
        3,
        undefined,
        signal,
      );
      if (response.data.data == null) return { status: 'unavailable' };
      return extractSearchContext({ [field]: decodeTextPart(external.part, response.data.data) }, queryText);
    }
    return { status: 'unavailable' };
  }

  async getMessage(id: string, opts?: GetMessageOpts): Promise<Message> {
    const res = await withRetry(() => this.gmail.users.messages.get({ userId: 'me', id, format: 'full' }));
    const labelNames = await this.labelNameMap();
    const message = await this.parseFullMessage(res.data, labelNames, opts?.includeHeaders ?? false);
    await this.attachDraftIds([message]);
    return message;
  }

  async getThread(threadId: string): Promise<Thread> {
    const res = await withRetry(() => this.gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
    const labelNames = await this.labelNameMap();
    const messages = await Promise.all(
      (res.data.messages ?? []).map((message) => this.parseFullMessage(message, labelNames)),
    );
    await this.attachDraftIds(messages);
    return {
      id: res.data.id ?? threadId,
      subject: messages[0]?.subject ?? '',
      messages,
    };
  }

  private async parseFullMessage(
    raw: gmail_v1.Schema$Message,
    labelNames: Map<string, string>,
    includeHeaders = false,
  ): Promise<Message> {
    const { message, externalBodyParts } = parseGmailMessageWithParts(raw, {
      accountId: this.accountId,
      labelNames,
      includeBody: true,
      includeAttachments: true,
      includeHeaders,
    });
    for (const field of ['text', 'html'] as const) {
      const external = externalBodyParts[field];
      if (!external) continue;
      const res = await withRetry(() =>
        this.gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: raw.id ?? message.id,
          id: external.attachmentId,
        }),
      );
      if (res.data.data == null) {
        throw invalidResponseError(`Gmail returned no ${field} body data`);
      }
      message.body ??= {};
      message.body[field] = decodeTextPart(external.part, res.data.data);
    }
    return message;
  }

  async listFolders(): Promise<Folder[]> {
    const labels = await this.labels(true);
    const folders: Folder[] = [];
    for (const label of labels) {
      if (!label.id || !label.name) continue;
      // Hide Gmail-internal labels that aren't useful as folders.
      if (
        label.id.startsWith('CATEGORY_') ||
        label.id === 'CHAT' ||
        label.id === 'UNREAD' ||
        label.id === 'IMPORTANT'
      ) {
        continue;
      }
      const folder: Folder = { id: label.id, name: label.name };
      const role = LABEL_TO_ROLE[label.id];
      if (role) folder.role = role;
      if (typeof label.messagesUnread === 'number') folder.unreadCount = label.messagesUnread;
      folders.push(folder);
    }
    return folders;
  }

  async listLabels(): Promise<Label[]> {
    const labels = await this.labels(true);
    return labels.flatMap((label) => {
      if (!label.id || !label.name || label.type !== 'user') return [];
      const background = label.color?.backgroundColor ?? undefined;
      const text = label.color?.textColor ?? undefined;
      return [
        {
          id: label.id,
          name: label.name,
          ...(background || text
            ? {
                color: {
                  ...(background ? { background } : {}),
                  ...(text ? { text } : {}),
                },
              }
            : {}),
        },
      ];
    });
  }

  /** Resolve reply threading (headers + Gmail thread id) from the message being replied to. */
  private async resolveReply(
    replyToMessageId: string,
  ): Promise<ThreadingHeaders & { threadId: string; subject: string }> {
    const res = await withRetry(() =>
      this.gmail.users.messages.get({
        userId: 'me',
        id: replyToMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References', 'Subject'],
      }),
    );
    const headers = res.data.payload?.headers ?? [];
    const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
    const messageId = get('Message-ID');
    const references = [get('References'), messageId].filter(Boolean).join(' ');
    const out: ThreadingHeaders & { threadId: string; subject: string } = {
      threadId: res.data.threadId ?? '',
      subject: get('Subject'),
    };
    if (messageId) out.inReplyTo = messageId;
    if (references) out.references = references;
    return out;
  }

  /** Threading already present on an existing draft, so content updates keep a reply on its thread. */
  private async resolveExistingDraftThreading(
    draftId: string,
  ): Promise<(ThreadingHeaders & { threadId?: string }) | undefined> {
    const res = await withRetry(() => this.gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'metadata' }));
    const message = res.data.message;
    if (!message) return undefined;
    const headers = message.payload?.headers ?? [];
    const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
    const out: ThreadingHeaders & { threadId?: string } = {};
    if (message.threadId) out.threadId = message.threadId;
    const inReplyTo = get('In-Reply-To');
    if (inReplyTo) out.inReplyTo = inReplyTo;
    const references = get('References');
    if (references) out.references = references;
    return out;
  }

  private async composeRaw(
    d: DraftInput,
    existingThreading?: ThreadingHeaders & { threadId?: string },
  ): Promise<{ raw: string; threadId?: string }> {
    let threading: ThreadingHeaders | undefined;
    let threadId: string | undefined;
    const draft = { ...d };
    if (d.replyToMessageId) {
      const reply = await this.resolveReply(d.replyToMessageId);
      threading = reply;
      threadId = reply.threadId || undefined;
      if (!draft.subject) draft.subject = replySubject(reply.subject);
    } else if (existingThreading) {
      threading = existingThreading;
      threadId = existingThreading.threadId;
    }
    let from = { email: this.email } as { email: string; name?: string };
    let replyTo: { email: string } | undefined;
    if (draft.from && draft.from.toLowerCase() !== this.email.toLowerCase()) {
      const identity = (await this.listSendAs()).find(
        (candidate) => candidate.email.toLowerCase() === draft.from!.toLowerCase(),
      );
      if (!identity) throw new EmailError('invalid_request', `Sender address "${draft.from}" is not available.`);
      from = { email: identity.email, ...(identity.name ? { name: identity.name } : {}) };
      if (identity.replyTo) replyTo = { email: identity.replyTo };
    } else {
      const senderName = await this.resolveSenderName();
      from = senderName ? { name: senderName, email: this.email } : { email: this.email };
    }
    const raw = await buildRawMessage(draft, from, threading, replyTo);
    const out: { raw: string; threadId?: string } = { raw: encodeBase64Url(raw) };
    if (threadId) out.threadId = threadId;
    return out;
  }

  private async draftToMessage(draft: gmail_v1.Schema$Draft): Promise<Message> {
    const messageId = draft.message?.id;
    if (!messageId) throw invalidResponseError('Gmail draft has no message id');
    const message = await this.getMessage(messageId);
    if (draft.id) message.draftId = draft.id;
    return message;
  }

  async createDraft(d: DraftInput): Promise<Message> {
    const { raw, threadId } = await this.composeRaw(d);
    const res = await withRetry(
      () =>
        this.gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
        }),
      NON_IDEMPOTENT_MAX_RETRIES,
      isRetryableForNonIdempotentRequest,
    );
    return this.draftToMessage(res.data);
  }

  async getDraft(draftId: string): Promise<Message> {
    const res = await withRetry(() => this.gmail.users.drafts.get({ userId: 'me', id: draftId }));
    return this.draftToMessage(res.data);
  }

  async updateDraft(draftId: string, d: DraftInput): Promise<Message> {
    // Replacing a reply draft's content must not detach it from its thread:
    // carry the draft's threading over unless the caller re-derives it.
    const current = d.from === undefined ? await this.getDraft(draftId) : undefined;
    const existing = d.replyToMessageId ? undefined : await this.resolveExistingDraftThreading(draftId);
    const { raw, threadId } = await this.composeRaw(
      d.from === undefined && current?.from?.email ? { ...d, from: current.from.email } : d,
      existing,
    );
    const res = await withRetry(() =>
      this.gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
      }),
    );
    return this.draftToMessage(res.data);
  }

  async deleteDraft(draftId: string): Promise<void> {
    await withRetry(() => this.gmail.users.drafts.delete({ userId: 'me', id: draftId }));
  }

  async send(input: DraftInput | { draftId: string }): Promise<SendResult> {
    if ('draftId' in input) {
      const res = await withRetry(
        () => this.gmail.users.drafts.send({ userId: 'me', requestBody: { id: input.draftId } }),
        NON_IDEMPOTENT_MAX_RETRIES,
        isRetryableForNonIdempotentRequest,
      );
      return { id: res.data.id ?? '', threadId: res.data.threadId ?? res.data.id ?? '' };
    }
    if (!input.to?.length && !input.cc?.length && !input.bcc?.length) {
      throw new EmailError('invalid_request', 'Cannot send a message with no recipients');
    }
    const { raw, threadId } = await this.composeRaw(input);
    const res = await withRetry(
      () =>
        this.gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw, ...(threadId ? { threadId } : {}) },
        }),
      NON_IDEMPOTENT_MAX_RETRIES,
      isRetryableForNonIdempotentRequest,
    );
    return { id: res.data.id ?? '', threadId: res.data.threadId ?? res.data.id ?? '' };
  }

  async modify(ids: string[], action: ModifyAction): Promise<void> {
    if (!ids.length) return;

    if (action === 'delete') {
      for (const id of ids) {
        try {
          await withRetry(() => this.gmail.users.messages.delete({ userId: 'me', id }));
        } catch (err) {
          if (!isInsufficientScope(err)) throw err;
          throw new EmailError(
            'unsupported_capability',
            "This Gmail account's OAuth permission does not allow permanent deletion. Move the messages to the trash instead.",
          );
        }
      }
      return;
    }

    if (action === 'trash' || action === 'untrash') {
      for (const id of ids) {
        if (action === 'trash') await withRetry(() => this.gmail.users.messages.trash({ userId: 'me', id }));
        else await withRetry(() => this.gmail.users.messages.untrash({ userId: 'me', id }));
      }
      return;
    }

    let addLabelIds: string[] = [];
    let removeLabelIds: string[] = [];
    if (action === 'markRead') removeLabelIds = ['UNREAD'];
    else if (action === 'markUnread') addLabelIds = ['UNREAD'];
    else if (action === 'star') addLabelIds = ['STARRED'];
    else if (action === 'unstar') removeLabelIds = ['STARRED'];
    else if (action === 'archive') removeLabelIds = ['INBOX'];
    else if ('move' in action) {
      const role = action.move.toLowerCase();
      if (role === 'all' || role === 'starred') {
        throw new EmailError('invalid_request', `Cannot move messages to "${role}"; it is a view, not a destination`);
      }
      if (role === 'archive') {
        // Gmail has no archive label: archiving is just leaving the inbox.
        removeLabelIds = ['INBOX', 'SPAM'];
      } else {
        const target = await this.resolveLabelId(action.move, true);
        addLabelIds = [target];
        if (target !== 'INBOX') removeLabelIds = ['INBOX'];
        if (target !== 'SPAM') removeLabelIds.push('SPAM');
      }
    } else if ('addLabels' in action) {
      const labels = [...new Set(action.addLabels)];
      if (labels.length > 100) {
        throw new EmailError('invalid_request', 'Gmail allows at most 100 labels in one modification');
      }
      addLabelIds = await Promise.all(labels.map((label) => this.resolveLabelId(label, true, false)));
    } else if ('removeLabels' in action) {
      const labels = [...new Set(action.removeLabels)];
      if (labels.length > 100) {
        throw new EmailError('invalid_request', 'Gmail allows at most 100 labels in one modification');
      }
      const resolved = await Promise.all(
        labels.map(async (label) => {
          try {
            return await this.resolveLabelId(label, false, false);
          } catch (error) {
            if (isEmailError(error) && error.code === 'not_found') return undefined;
            throw error;
          }
        }),
      );
      removeLabelIds = resolved.filter((label): label is string => label !== undefined);
    }

    if (!addLabelIds.length && !removeLabelIds.length) return;

    for (let offset = 0; offset < ids.length; offset += BATCH_MODIFY_MAX_IDS) {
      const chunk = ids.slice(offset, offset + BATCH_MODIFY_MAX_IDS);
      await withRetry(() =>
        this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: chunk,
            ...(addLabelIds.length ? { addLabelIds } : {}),
            ...(removeLabelIds.length ? { removeLabelIds } : {}),
          },
        }),
      );
    }
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    opts: GetAttachmentOpts = {},
  ): Promise<{ meta: AttachmentMeta; content: Buffer }> {
    const msg = await withRetry(() => this.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' }));
    const attachment = findAttachment(msg.data.payload, attachmentId);
    if (!attachment) throw new EmailError('not_found', `Attachment ${attachmentId} not found on message ${messageId}`);
    assertAttachmentSize(attachment.meta.sizeBytes, opts.maxBytes);
    if (attachment.content !== undefined) {
      assertAttachmentSize(attachment.content.length, opts.maxBytes);
      return { meta: attachment.meta, content: attachment.content };
    }
    if (!attachment.providerAttachmentId) {
      throw invalidResponseError('Gmail returned attachment metadata without a content id');
    }
    const res = await withRetry(() =>
      this.gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachment.providerAttachmentId,
      }),
    );
    if (res.data.data == null) throw invalidResponseError('Gmail returned no attachment data');
    const content = decodeBase64Url(res.data.data);
    assertAttachmentSize(content.length, opts.maxBytes);
    return { meta: attachment.meta, content };
  }
}
