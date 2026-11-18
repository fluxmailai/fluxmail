import { gmail, type gmail_v1 } from 'googleapis/build/src/apis/gmail/index.js';
import type { Readable } from 'node:stream';
import type { OAuth2Client } from 'googleapis-common';
import {
  EmailError,
  findByFolderName,
  FolderDeleteRefusedError,
  folderHasMessages,
  folderHasSubfolders,
  folderNameKey,
  FolderNameError,
  folderAlreadyThere,
  FolderMoveRefusedError,
  folderMovedIntoItself,
  movedFolderTakesRole,
  FolderNotFoundError,
  FolderRenameRefusedError,
  folderNameTaken,
  renamedFolderName,
  systemFolderNotMovable,
  systemFolderNotRenamable,
  folderPathLevels,
  invalidResponseError,
  isFolderRoleName,
  LabelNotFoundError,
  newFolderName,
  newLabelName,
  systemFolderNotDeletable,
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
  type RenamedFolder,
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
import { buildRawMessage, buildRawMessageStream, type ThreadingHeaders } from './mime.js';
import {
  isInsufficientScope,
  isRetryableForNonIdempotentRequest,
  READ_ATTEMPT_TIMEOUT_MS,
  SLOW_READ_ATTEMPT_TIMEOUT_MS,
  withReadRetry,
  withRetry,
} from './errors.js';

/**
 * The label a folder value names, by ID or by name. Gmail label names ignore case, and match whichever
 * Unicode form an accented letter was typed in.
 */
function findLabel(labels: readonly gmail_v1.Schema$Label[], folder: string): gmail_v1.Schema$Label | undefined {
  return labels.find((l) => l.id === folder) ?? findByFolderName(labels, folder, (l) => l.name, true);
}

/** A label as listLabels lists it, or undefined when Gmail left out its ID or name. */
function toLabel(label: gmail_v1.Schema$Label): Label | undefined {
  if (!label.id || !label.name) return undefined;
  const background = label.color?.backgroundColor ?? undefined;
  const text = label.color?.textColor ?? undefined;
  return {
    id: label.id,
    name: label.name,
    ...(background || text ? { color: { ...(background ? { background } : {}), ...(text ? { text } : {}) } } : {}),
  };
}

/** The label with a name, by name only. A system label can't be created or used as a folder name. */
function existingLabel(labels: readonly gmail_v1.Schema$Label[], name: string): gmail_v1.Schema$Label | undefined {
  const label = findByFolderName(labels, name, (l) => l.name, true);
  if (label?.type === 'system') {
    throw new FolderNameError(`"${label.name}" is a Gmail system label. Choose another name.`);
  }
  return label?.id ? label : undefined;
}

/**
 * Drops requested label names that Gmail would treat as the same label, keeping the first spelling.
 * A name that is exactly an existing label's ID or name is always kept, so separate labels whose names
 * differ only in Unicode form each resolve to their own ID.
 */
function uniqueLabelNames(names: readonly string[], existing: readonly gmail_v1.Schema$Label[]): string[] {
  const exact = new Set(existing.flatMap((l) => [l.id, l.name]).filter((value) => typeof value === 'string'));
  const seen = new Set<string>();
  return [...new Set(names)].filter((name) => {
    if (exact.has(name)) return true;
    const key = folderNameKey(name, true);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
/** Messages trashed, restored or deleted at once. Gmail has no batch call for these. */
const MESSAGE_CONCURRENCY = 4;
const FILTERED_PAGE_TOKEN_VERSION = 1;
const FILTERED_PAGE_TOKEN_PREFIX = 'fm1.';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
/** The most nested labels rename_folder renames along with their parent. Each one is its own Gmail request. */
const MAX_RENAMED_NESTED_LABELS = 100;

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

/**
 * Run `fn` for each item with at most `limit` calls in flight. After the first
 * failure no new calls start. The in-flight calls settle before the first
 * error is thrown, so nothing keeps changing the mailbox after the caller sees it.
 */
async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw firstError;
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
  /**
   * Downloads an attachment's decoded content in place of the Gmail client, for example to
   * stream it without holding the base64 response. Reject content larger than maxBytes.
   */
  getAttachmentContent?: (messageId: string, attachmentId: string, maxBytes?: number) => Promise<Buffer>;
  /**
   * Sends a composed RFC 5322 message in place of the Gmail client, for example as a streamed
   * upload. Used for new messages; sending a saved draft still uses the Gmail client. The stream
   * can be read once, so the hook can't retry it, and the provider's retries and error mapping
   * don't apply. Throw an EmailError with a definite code, such as invalid_request, only when
   * Gmail certainly did not accept the message.
   */
  sendRawMessage?: (message: Readable, threadId?: string) => Promise<SendResult>;
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
  private readonly getAttachmentContent: GmailProviderOptions['getAttachmentContent'];
  private readonly sendRawMessage: GmailProviderOptions['sendRawMessage'];
  private labelCache: { fetchedAt: number; labels: gmail_v1.Schema$Label[] } | null = null;
  private sendAsCache: { fetchedAt: number; identities: SendAsIdentity[] } | null = null;
  /** undefined = not resolved yet; null = no name available. */
  private cachedSenderName: string | null | undefined;

  constructor(opts: GmailProviderOptions) {
    this.accountId = opts.accountId;
    this.email = opts.email;
    this.displayName = opts.displayName;
    this.auth = opts.auth;
    this.getAttachmentContent = opts.getAttachmentContent;
    this.sendRawMessage = opts.sendRawMessage;
    this.gmail = gmail({ version: 'v1', auth: opts.auth });
  }

  /**
   * Sender name for the From header, matching what the Gmail UI would use:
   * the primary send-as displayName when set, else the current Google profile
   * name, with the stored account name as an offline fallback.
   */
  private async resolveSenderName(): Promise<string | null> {
    return (await this.resolveDefaultSender()).name;
  }

  /**
   * The default sender's name, and whether it is settled. It is not settled after a failed lookup: the
   * name is then a fallback, and the next send looks again and may find another.
   */
  private async resolveDefaultSender(): Promise<{ name: string | null; settled: boolean }> {
    if (this.cachedSenderName !== undefined) return { name: this.cachedSenderName, settled: true };
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
      return { name: sendAsName, settled: true };
    }

    try {
      const res = await withRetry(() => this.auth.request<{ name?: string }>({ url: GOOGLE_USERINFO_URL }));
      const profileName = res.data.name?.trim();
      if (profileName) {
        // Don't pin the profile name when the send-as lookup failed: the primary identity may have its own.
        if (!lookupFailed) this.cachedSenderName = profileName;
        return { name: profileName, settled: !lookupFailed };
      }
    } catch {
      // Profile lookup is optional; sending should still work without it.
      lookupFailed = true;
    }
    const fallback = this.displayName?.trim() || null;
    // Cache "no name configured", but not a transient lookup failure: the next
    // send should try Gmail again rather than pin the offline fallback.
    if (!lookupFailed) this.cachedSenderName = fallback;
    return { name: fallback, settled: !lookupFailed };
  }

  /**
   * The From address and name a message from this sender carries, and the identity's Reply-To. The name is
   * not settled when a lookup failed and a later send may carry a different one.
   */
  private async resolveFrom(
    requested?: string,
  ): Promise<{ from: { email: string; name?: string }; replyTo?: { email: string }; settled: boolean }> {
    if (requested && requested.toLowerCase() !== this.email.toLowerCase()) {
      const identity = (await this.listSendAs()).find(
        (candidate) => candidate.email.toLowerCase() === requested.toLowerCase(),
      );
      if (!identity) throw new EmailError('invalid_request', `Sender address "${requested}" is not available.`);
      return {
        from: { email: identity.email, ...(identity.name ? { name: identity.name } : {}) },
        ...(identity.replyTo ? { replyTo: { email: identity.replyTo } } : {}),
        settled: true,
      };
    }
    const { name, settled } = await this.resolveDefaultSender();
    return { from: name ? { name, email: this.email } : { email: this.email }, settled };
  }

  async senderName(from?: string): Promise<string | undefined> {
    const { from: sender, settled } = await this.resolveFrom(from);
    return settled ? sender.name : undefined;
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
    const res = await withReadRetry(
      (attemptSignal) => this.gmail.users.labels.list({ userId: 'me' }, { signal: attemptSignal }),
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
      const res = await withReadRetry(
        (attemptSignal) =>
          this.gmail.users.drafts.list(
            { userId: 'me', maxResults: 500, ...(pageToken ? { pageToken } : {}) },
            { signal: attemptSignal },
          ),
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
    const match = findLabel(labels, folder);
    if (match?.id) {
      if (!systemLabelsAllowed && match.type === 'system') {
        throw new EmailError('invalid_request', `Use the dedicated message action instead of changing ${match.name}`);
      }
      return match.id;
    }
    if (!createIfMissing) {
      throw new EmailError('not_found', `No Gmail label or folder named "${folder}"`);
    }
    return (await this.createUserLabel(folder)).id!;
  }

  /** Creates a user label and clears the label cache. */
  private async createUserLabel(name: string): Promise<gmail_v1.Schema$Label> {
    const created = await withRetry(() => this.gmail.users.labels.create({ userId: 'me', requestBody: { name } }));
    this.labelCache = null;
    if (!created.data.id) throw invalidResponseError('Gmail did not return a label id');
    return created.data;
  }

  /**
   * Creates a user label, with any missing parent labels so Gmail nests it, and returns it as a folder.
   * Gmail separates nested labels with "/" and ignores case in label names. An existing label is returned.
   */
  async createFolder(name: string): Promise<Folder> {
    const label = await this.createNestedLabel(newFolderName(name));
    return { id: label.id!, name: label.name! };
  }

  /** Creates a user label and any missing parents, or finds the existing one, and returns it as Gmail lists it. */
  private async createNestedLabel(requested: string): Promise<gmail_v1.Schema$Label> {
    if (IMMUTABLE_SYSTEM_LABELS.has(requested.toLowerCase())) {
      throw new FolderNameError(`"${requested}" is a Gmail system label. Choose another name.`);
    }
    const levels = folderPathLevels(requested, '/');
    let labels = await this.labels(true);
    let label: gmail_v1.Schema$Label | undefined;
    let path = '';
    for (let depth = 1; depth <= levels.length; depth++) {
      // A level under an existing label uses that label's own spelling, since Gmail nests labels by name.
      path = depth === 1 ? levels[0]! : `${label?.name ?? path}/${levels[depth - 1]}`;
      label = existingLabel(labels, path);
      if (label) continue;
      // A missing parent such as "Archive" in "Archive/2025" would be created as a label searches read as a role.
      if (isFolderRoleName(path) || IMMUTABLE_SYSTEM_LABELS.has(path.toLowerCase())) {
        throw new FolderNameError(`"${path}" is a system folder. Choose another name.`);
      }
      try {
        label = await this.createUserLabel(path);
      } catch (error) {
        if (isEmailError(error) && error.code === 'invalid_request') {
          throw new FolderNameError(
            `Gmail would not create the label "${path}". The name may use characters or a length Gmail doesn't allow.`,
            error.failure,
          );
        }
        // Gmail answers 409 when the name is taken, including by a label created since the listing.
        if (!isEmailError(error) || error.failure?.httpStatus !== 409) throw error;
        labels = await this.labels(true);
        label = existingLabel(labels, path);
        if (!label) {
          throw new FolderNameError(
            `Gmail would not create the label "${path}" because the name is reserved or conflicts with another label.`,
            error.failure,
          );
        }
      }
    }
    return { ...label!, name: label!.name ?? requested };
  }

  /**
   * Deletes an empty user label. Deleting a Gmail label never deletes mail, but a label still on messages, or
   * with nested labels, is refused like a folder in any other mailbox, so the caller decides where its mail goes.
   */
  async deleteFolder(folder: string): Promise<Folder> {
    const requested = folder.trim();
    if (!requested) throw new FolderNameError('The folder name is empty.');
    return this.deleteUserLabel(requested, 'folder');
  }

  /**
   * Creates a user label, with any missing parent labels, and returns it as listLabels lists it. Gmail labels are
   * also folders, so the name follows the same rules as createFolder. An existing label is returned.
   */
  async createLabel(name: string): Promise<Label> {
    const requested = newLabelName(name);
    // Searches and moves read these words as the system folder, so a label with the name couldn't be reached.
    if (isFolderRoleName(requested) || IMMUTABLE_SYSTEM_LABELS.has(requested.toLowerCase())) {
      throw new FolderNameError(`"${requested}" is the name of a Gmail system label or folder. Choose another name.`);
    }
    const label = await this.createNestedLabel(requested);
    return toLabel(label) ?? { id: label.id!, name: label.name! };
  }

  /**
   * Deletes a user label. Gmail removes it from its messages, which keep their other labels and stay in All Mail.
   * A label with nested labels is refused, since Gmail would leave them behind.
   */
  async deleteLabel(label: string): Promise<Label> {
    const requested = label.trim();
    if (!requested) throw new FolderNameError('The label name is empty.');
    return this.deleteUserLabel(requested, 'label');
  }

  /** Deletes a user label by ID or name. As a folder, the label must also be on no messages. */
  private async deleteUserLabel(requested: string, as: 'folder' | 'label'): Promise<Label> {
    const notFound = () => (as === 'folder' ? new FolderNotFoundError(requested) : new LabelNotFoundError(requested));
    // Another mail app may have changed the labels within the cache lifetime.
    const labels = await this.labels(true);
    // A user label wins over a role word, so a label named Archive, which Gmail has no system label for, can go.
    const label = findLabel(labels, requested);
    if (!label?.id || !label.name) {
      if (isFolderRoleName(requested) || IMMUTABLE_SYSTEM_LABELS.has(requested.toLowerCase())) {
        throw as === 'folder'
          ? systemFolderNotDeletable(requested)
          : new FolderDeleteRefusedError(`"${requested}" is a Gmail system label and can't be deleted.`);
      }
      throw notFound();
    }
    if (label.type === 'system') {
      throw new FolderDeleteRefusedError(`"${label.name}" is a Gmail system label and can't be deleted.`);
    }
    // Gmail nests labels by name and ignores case in label names.
    const prefix = `${label.name.toLowerCase()}/`;
    if (labels.some((candidate) => candidate.id !== label.id && candidate.name?.toLowerCase().startsWith(prefix))) {
      throw as === 'folder'
        ? folderHasSubfolders(label.name)
        : new FolderDeleteRefusedError(`"${label.name}" has nested labels. Delete them first.`);
    }
    if (as === 'folder') {
      // Only labels.get reports message counts; the listing leaves them out.
      let current: gmail_v1.Schema$Label;
      try {
        current = (
          await withReadRetry((signal) => this.gmail.users.labels.get({ userId: 'me', id: label.id! }, { signal }))
        ).data;
      } catch (error) {
        if (isEmailError(error) && error.code === 'not_found') throw notFound();
        throw error;
      }
      // Without a count, the label can't be shown to be unused, so it stays.
      if (typeof current.messagesTotal !== 'number') {
        throw invalidResponseError(`Gmail did not say how many messages have the label "${label.name}"`);
      }
      if (current.messagesTotal > 0) {
        throw folderHasMessages(label.name, current.messagesTotal, true);
      }
    }
    try {
      // A delete resent after a lost response would answer 404 and be reported as a missing label.
      await withRetry(
        () => this.gmail.users.labels.delete({ userId: 'me', id: label.id! }),
        NON_IDEMPOTENT_MAX_RETRIES,
        isRetryableForNonIdempotentRequest,
      );
    } catch (error) {
      if (isEmailError(error) && error.code === 'not_found') throw notFound();
      throw error;
    } finally {
      this.labelCache = null;
    }
    return toLabel(label) ?? { id: label.id, name: label.name };
  }

  /**
   * Renames a user label in place. Gmail nests labels by name only, so the labels nested under it are renamed
   * too, before the label itself. If Gmail refuses one, the ones already renamed are put back.
   */
  async renameFolder(folder: string, name: string): Promise<RenamedFolder> {
    const requested = folder.trim();
    if (!requested) throw new FolderNameError('The folder name is empty.');
    const leaf = renamedFolderName(name, '/');
    // Another mail app may have changed the labels within the cache lifetime.
    const labels = await this.labels(true);
    const label = findLabel(labels, requested);
    if (!label?.id || !label.name) {
      if (isFolderRoleName(requested) || IMMUTABLE_SYSTEM_LABELS.has(requested.toLowerCase())) {
        throw systemFolderNotRenamable(requested);
      }
      throw new FolderNotFoundError(requested);
    }
    if (label.type === 'system') {
      throw new FolderRenameRefusedError(`"${label.name}" is a Gmail system label and can't be renamed.`);
    }
    return this.renameLabelTree(labels, label, `${label.name.slice(0, label.name.lastIndexOf('/') + 1)}${leaf}`, {
      requested,
      move: false,
    });
  }

  /**
   * Moves a user label under another user label, or to the top level. A label's parent is the start of its name,
   * so this renames the label and the labels nested under it, as renameFolder does.
   */
  async moveFolder(folder: string, parent: string | null): Promise<RenamedFolder> {
    const requested = folder.trim();
    if (!requested) throw new FolderNameError('The folder name is empty.');
    const destination = parent?.trim();
    if (parent !== null && !destination) throw new FolderNameError('The destination folder name is empty.');
    // Another mail app may have changed the labels within the cache lifetime.
    const labels = await this.labels(true);
    const label = findLabel(labels, requested);
    if (!label?.id || !label.name) {
      if (isFolderRoleName(requested) || IMMUTABLE_SYSTEM_LABELS.has(requested.toLowerCase())) {
        throw systemFolderNotMovable(requested);
      }
      throw new FolderNotFoundError(requested);
    }
    if (label.type === 'system') {
      throw new FolderMoveRefusedError(`"${label.name}" is a Gmail system label and can't be moved.`);
    }
    let prefix = '';
    if (destination) {
      const target = findLabel(labels, destination);
      if (!target?.id || !target.name) {
        if (isFolderRoleName(destination) || IMMUTABLE_SYSTEM_LABELS.has(destination.toLowerCase())) {
          throw new FolderMoveRefusedError(
            `"${destination}" is a system folder, and Gmail labels can only be nested under other labels.`,
          );
        }
        throw new FolderNotFoundError(destination);
      }
      if (target.type === 'system') {
        throw new FolderMoveRefusedError(
          `"${target.name}" is a Gmail system label, and labels can only be nested under other labels.`,
        );
      }
      // Gmail nests labels by name and ignores case in label names.
      if (target.id === label.id || target.name.toLowerCase().startsWith(`${label.name.toLowerCase()}/`)) {
        throw folderMovedIntoItself(label.name, target.name);
      }
      prefix = `${target.name}/`;
    }
    const leaf = label.name.slice(label.name.lastIndexOf('/') + 1);
    return this.renameLabelTree(labels, label, `${prefix}${leaf}`, { requested, move: true });
  }

  /**
   * Gives a user label a new full name, and the labels nested under it the matching names. Nested labels go
   * first; if Gmail refuses one, the ones already renamed are put back.
   */
  private async renameLabelTree(
    labels: readonly gmail_v1.Schema$Label[],
    label: gmail_v1.Schema$Label,
    newName: string,
    options: { requested: string; move: boolean },
  ): Promise<RenamedFolder> {
    const { requested, move } = options;
    const Refused = move ? FolderMoveRefusedError : FolderRenameRefusedError;
    const oldName = label.name!;
    const previous: Folder = { id: label.id!, name: oldName };
    if (newName === oldName) return { folder: previous, previous };
    // Searches and moves read a role word as the system folder, as they do for a new folder.
    if (isFolderRoleName(newName) || IMMUTABLE_SYSTEM_LABELS.has(newName.toLowerCase())) {
      throw move
        ? movedFolderTakesRole(newName)
        : new FolderNameError(`"${newName}" is a system folder. Choose another name.`);
    }
    // Gmail nests labels by name and ignores case in label names.
    const oldPrefix = `${oldName.toLowerCase()}/`;
    const nested = labels.filter(
      (candidate) => candidate.id && candidate.id !== label.id && candidate.name?.toLowerCase().startsWith(oldPrefix),
    );
    if (nested.length > MAX_RENAMED_NESTED_LABELS) {
      throw new Refused(
        `"${oldName}" has ${nested.length} nested labels, more than the ${MAX_RENAMED_NESTED_LABELS} Fluxmail ${move ? 'moves' : 'renames'} at once. ${move ? 'Move' : 'Rename'} it in Gmail instead.`,
      );
    }
    const moving = new Set([label.id!, ...nested.map((candidate) => candidate.id!)]);
    const others = labels.filter((candidate) => !candidate.id || !moving.has(candidate.id));
    const renames = [
      ...nested.map((candidate) => ({
        id: candidate.id!,
        from: candidate.name!,
        to: `${newName}${candidate.name!.slice(oldName.length)}`,
      })),
      { id: label.id!, from: oldName, to: newName },
    ];
    for (const rename of renames) {
      const taken = findByFolderName(others, rename.to, (candidate) => candidate.name, true);
      if (taken?.type === 'system') {
        throw new FolderNameError(`"${taken.name}" is a Gmail system label. Choose another name.`);
      }
      if (taken) throw (move ? folderAlreadyThere : folderNameTaken)(taken.name ?? rename.to);
    }
    const patch = (id: string, to: string) =>
      withRetry(() => this.gmail.users.labels.patch({ userId: 'me', id, requestBody: { name: to } }));
    // Whether Gmail has the new name for a label whose patch failed. A patch can be applied and its reply lost,
    // so only an answer from Gmail settles it; undefined means Gmail gave none.
    const applied = async (rename: (typeof renames)[number]): Promise<boolean | undefined> => {
      try {
        const current = await withReadRetry((signal) =>
          this.gmail.users.labels.get({ userId: 'me', id: rename.id }, { signal }),
        );
        return current.data.name === rename.to;
      } catch {
        return undefined;
      }
    };
    const done: typeof renames = [];
    let renamed = newName;
    try {
      for (const rename of renames) {
        try {
          const result = await patch(rename.id, rename.to);
          if (rename.id === label.id) renamed = result.data.name ?? newName;
        } catch (error) {
          // A refusal changed nothing. Any other failure may have been applied.
          const refused =
            isEmailError(error) &&
            (error.code === 'invalid_request' || error.code === 'not_found' || error.failure?.httpStatus === 409);
          const state = refused ? false : await applied(rename);
          if (state !== true) {
            // Put back the labels already renamed, and the failed one when Gmail didn't say which name it has,
            // so the mailbox is as it was.
            let restored = true;
            for (const undo of [...(state === undefined ? [rename] : []), ...done.reverse()]) {
              try {
                await patch(undo.id, undo.from);
              } catch {
                restored = false;
              }
            }
            if (!restored) {
              throw new EmailError(
                isEmailError(error) ? error.code : 'provider_unavailable',
                `Gmail stopped partway through ${move ? 'moving' : 'renaming'} "${oldName}", and Fluxmail could not undo it. Some labels may now start with "${newName}" and the rest still start with "${oldName}". Rename them in Gmail.`,
                undefined,
                isEmailError(error) ? error.failure : undefined,
              );
            }
            if (!isEmailError(error)) throw error;
            if (error.code === 'not_found') {
              // Only the label the caller named is the folder that wasn't found.
              if (rename.id === label.id) throw new FolderNotFoundError(requested);
              throw new Refused(
                `Gmail no longer has the nested label "${rename.from}", so "${oldName}" was not ${move ? 'moved' : 'renamed'}. Try again.`,
                error.failure,
              );
            }
            // Gmail answers 409 when the name is taken, including by a label created since the listing.
            if (error.failure?.httpStatus === 409) {
              throw (move ? folderAlreadyThere : folderNameTaken)(rename.to, error.failure);
            }
            if (error.code === 'invalid_request') {
              throw new FolderNameError(
                `Gmail would not rename the label "${rename.from}" to "${rename.to}". The name may use characters or a length Gmail doesn't allow.`,
                error.failure,
              );
            }
            throw error;
          }
        }
        done.push(rename);
      }
    } finally {
      this.labelCache = null;
    }
    return { folder: { id: label.id!, name: renamed }, previous };
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
      return findLabel(labels, folder)?.id ?? null;
    });
    const pageSize = Math.min(Math.max(page?.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const labelNames = await this.labelNameMap(page?.signal);
    const items: Message[] = [];
    const localFilter = q.hasAttachment !== undefined || q.after !== undefined || q.before !== undefined;
    // Attachment filtering needs the MIME tree, which only the full format returns.
    const fullFormat = q.hasAttachment !== undefined;
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
        const res = await withReadRetry(
          (attemptSignal) => {
            const params = {
              userId: 'me',
              maxResults: batchSize,
              ...(providerToken ? { pageToken: providerToken } : {}),
              ...(gq.q ? { q: gq.q } : {}),
              ...(gq.labelIds ? { labelIds: gq.labelIds } : {}),
              ...(gq.includeSpamTrash ? { includeSpamTrash: true } : {}),
            };
            return this.gmail.users.messages.list(params, { signal: attemptSignal });
          },
          page?.signal,
          SLOW_READ_ATTEMPT_TIMEOUT_MS,
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
            withReadRetry(
              (attemptSignal) => {
                const params = {
                  userId: 'me',
                  id,
                  format: fullFormat ? ('full' as const) : ('metadata' as const),
                  metadataHeaders: METADATA_HEADERS,
                };
                return this.gmail.users.messages.get(params, { signal: attemptSignal });
              },
              page?.signal,
              fullFormat ? SLOW_READ_ATTEMPT_TIMEOUT_MS : READ_ATTEMPT_TIMEOUT_MS,
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
        const response = await withReadRetry(
          (attemptSignal) => this.gmail.users.messages.get(params, { signal: attemptSignal }),
          signal,
          SLOW_READ_ATTEMPT_TIMEOUT_MS,
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
      const response = await withReadRetry(
        (attemptSignal) => this.gmail.users.messages.attachments.get(params, { signal: attemptSignal }),
        signal,
        SLOW_READ_ATTEMPT_TIMEOUT_MS,
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
    return labels.flatMap((label) => (label.type === 'user' ? (toLabel(label) ?? []) : []));
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
    const { draft, from, threading, replyTo, threadId } = await this.composeParts(d, existingThreading);
    const raw = await buildRawMessage(draft, from, threading, replyTo);
    const out: { raw: string; threadId?: string } = { raw: encodeBase64Url(raw) };
    if (threadId) out.threadId = threadId;
    return out;
  }

  private async composeParts(
    d: DraftInput,
    existingThreading?: ThreadingHeaders & { threadId?: string },
  ): Promise<{
    draft: DraftInput;
    from: { email: string; name?: string };
    threading?: ThreadingHeaders;
    replyTo?: { email: string };
    threadId?: string;
  }> {
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
    const { from, replyTo } = await this.resolveFrom(draft.from);
    return { draft, from, threading, replyTo, threadId };
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
    if (this.sendRawMessage) {
      const { draft, from, threading, replyTo, threadId } = await this.composeParts(input);
      const stream = buildRawMessageStream(draft, from, threading, replyTo);
      try {
        return await this.sendRawMessage(stream, threadId);
      } finally {
        stream.destroy();
      }
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
      return forEachLimited(ids, MESSAGE_CONCURRENCY, async (id) => {
        try {
          await withRetry(() => this.gmail.users.messages.delete({ userId: 'me', id }));
        } catch (err) {
          if (!isInsufficientScope(err)) throw err;
          throw new EmailError(
            'unsupported_capability',
            "This Gmail account's OAuth permission does not allow permanent deletion. Move the messages to the trash instead.",
          );
        }
      });
    }

    if (action === 'trash' || action === 'untrash') {
      return forEachLimited(ids, MESSAGE_CONCURRENCY, async (id) => {
        if (action === 'trash') await withRetry(() => this.gmail.users.messages.trash({ userId: 'me', id }));
        else await withRetry(() => this.gmail.users.messages.untrash({ userId: 'me', id }));
      });
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
      const labels = uniqueLabelNames(action.addLabels, await this.labels());
      if (labels.length > 100) {
        throw new EmailError('invalid_request', 'Gmail allows at most 100 labels in one modification');
      }
      addLabelIds = [...new Set(await Promise.all(labels.map((label) => this.resolveLabelId(label, true, false))))];
    } else if ('removeLabels' in action) {
      const labels = uniqueLabelNames(action.removeLabels, await this.labels());
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
      removeLabelIds = [...new Set(resolved.filter((label): label is string => label !== undefined))];
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
    if (this.getAttachmentContent) {
      const content = await this.getAttachmentContent(messageId, attachment.providerAttachmentId, opts.maxBytes);
      assertAttachmentSize(content.length, opts.maxBytes);
      return { meta: attachment.meta, content };
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
