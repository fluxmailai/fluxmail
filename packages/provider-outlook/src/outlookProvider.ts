import {
  EmailError,
  findByFolderName,
  FolderDeleteRefusedError,
  folderHasMessages,
  folderHasSubfolders,
  folderNameKey,
  FolderNameError,
  FolderMoveRefusedError,
  folderMovedIntoItself,
  FolderNotFoundError,
  FolderRenameRefusedError,
  folderNameTaken,
  renamedFolderName,
  systemFolderNotMovable,
  systemFolderNotRenamable,
  LabelNotFoundError,
  folderPathLevels,
  invalidResponseError,
  isFolderRoleName,
  newFolderName,
  newLabelName,
  systemFolderNotDeletable,
  extractSearchContext,
  normalizeEmailQuery,
  replySubject,
  type AttachmentInput,
  type AttachmentMeta,
  type Capabilities,
  type DraftInput,
  type EmailAddress,
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
  type Thread,
} from '@fluxmail/core';
import { GraphHttpError, isRetryableGraphError, toEmailError } from './errors.js';
import { parseGraphAttachment, parseGraphMessage, toGraphRecipients } from './parse.js';
import { toGraphQuery } from './query.js';
import type { GraphAttachment, GraphCategory, GraphCollection, GraphFolder, GraphMessage } from './types.js';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const FOLDER_CACHE_TTL_MS = 60_000;
const MAX_RETRIES = 3;
/** Exchange Online allows four concurrent requests per mailbox for each app. */
const MESSAGE_CONCURRENCY = 4;
const SMALL_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 12 * 320 * 1024;

const MESSAGE_LIST_FIELDS = [
  'id',
  'conversationId',
  'parentFolderId',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'subject',
  'receivedDateTime',
  'sentDateTime',
  'createdDateTime',
  'bodyPreview',
  'isRead',
  'isDraft',
  'flag',
  'hasAttachments',
  'categories',
].join(',');

const MESSAGE_FULL_FIELDS = `${MESSAGE_LIST_FIELDS},body`;
const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId';
const ATTACHMENT_METADATA_SELECT = 'id,name,contentType,size,isInline';

const WELL_KNOWN_FOLDERS: Array<{ id: string; role: FolderRole; name: string }> = [
  { id: 'inbox', role: 'inbox', name: 'Inbox' },
  { id: 'sentitems', role: 'sent', name: 'Sent Items' },
  { id: 'drafts', role: 'drafts', name: 'Drafts' },
  { id: 'deleteditems', role: 'trash', name: 'Deleted Items' },
  { id: 'junkemail', role: 'spam', name: 'Junk Email' },
  { id: 'archive', role: 'archive', name: 'Archive' },
];

export interface MicrosoftAccessTokenProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

export interface OutlookProviderOptions {
  accountId: string;
  tokenProvider: MicrosoftAccessTokenProvider;
  fetch?: typeof globalThis.fetch;
  resolveSender?: (email: string) => EmailAddress | undefined;
}

export const OUTLOOK_CAPABILITIES: Capabilities = {
  labels: true,
  serverThreads: true,
  serverSearch: 'rich',
  search: {
    filters: ['folder', 'text', 'from', 'to', 'subject', 'read', 'starred', 'hasAttachment', 'after', 'before'],
    folderRoles: {
      inbox: 'available',
      sent: 'available',
      drafts: 'available',
      archive: 'unknown',
      spam: 'available',
      trash: 'available',
      all: 'available',
    },
    nativeQuery: { syntax: 'outlook-kql', availability: 'available' },
  },
  snippets: true,
  searchContext: true,
};

interface FolderSnapshot {
  folders: Folder[];
  byId: Map<string, Folder>;
  byRole: Map<FolderRole, Folder>;
  trashFolderIds: Set<string>;
  allMailExcludedRootFolderIds: Set<string>;
  allMailExcludedFolderIds: Set<string>;
}

interface RequestOptions {
  nonIdempotent?: boolean;
  includeAuth?: boolean;
  signal?: AbortSignal;
  attachmentMaxBytes?: number;
}

interface LocalMessageFilter {
  read?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  after?: string;
  before?: string;
  allMailScope?: true;
}

interface PageTokenPayload {
  url: string;
  localFilter?: LocalMessageFilter;
  offset?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
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

async function readAttachmentContent(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw invalidResponseError('Microsoft Graph returned no attachment data');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sizeBytes += value.byteLength;
      assertAttachmentSize(sizeBytes, maxBytes);
      chunks.push(value);
    }
    return Buffer.concat(chunks, sizeBytes);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function bodyFor(draft: DraftInput): { contentType: 'HTML' | 'Text'; content: string } {
  if (draft.body.html !== undefined) return { contentType: 'HTML', content: draft.body.html };
  return { contentType: 'Text', content: draft.body.text ?? '' };
}

function encodePageToken(url: string, localFilter?: LocalMessageFilter, offset = 0): string {
  const payload: PageTokenPayload = {
    url,
    ...(localFilter ? { localFilter } : {}),
    ...(offset ? { offset } : {}),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodePageToken(token: string): PageTokenPayload {
  try {
    const value = Buffer.from(token, 'base64url').toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Accept tokens issued before local search filters were added.
      parsed = { url: value };
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { url?: unknown }).url !== 'string') {
      throw new Error();
    }
    const payload = parsed as { url: string; localFilter?: unknown; offset?: unknown };
    const url = new URL(payload.url);
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/')) throw new Error();
    const offset = payload.offset;
    if (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 0)) throw new Error();
    let localFilter: LocalMessageFilter | undefined;
    if (payload.localFilter !== undefined) {
      if (!payload.localFilter || typeof payload.localFilter !== 'object' || Array.isArray(payload.localFilter)) {
        throw new Error();
      }
      const entries = Object.entries(payload.localFilter);
      const booleanKeys = new Set(['read', 'starred', 'hasAttachment', 'allMailScope']);
      const dateKeys = new Set(['after', 'before']);
      if (
        entries.some(
          ([key, value]) =>
            (!booleanKeys.has(key) || typeof value !== 'boolean') && (!dateKeys.has(key) || typeof value !== 'string'),
        )
      ) {
        throw new Error();
      }
      localFilter = payload.localFilter as LocalMessageFilter;
    }
    return {
      url: payload.url,
      ...(localFilter ? { localFilter } : {}),
      ...(typeof offset === 'number' && offset > 0 ? { offset } : {}),
    };
  } catch {
    throw new EmailError('invalid_request', 'Invalid Microsoft Graph page token');
  }
}

function localMessageFilter(query: EmailQuery, allMailScope = false): LocalMessageFilter | undefined {
  const filter: LocalMessageFilter = {
    ...(query.read !== undefined ? { read: query.read } : {}),
    ...(query.starred !== undefined ? { starred: query.starred } : {}),
    ...(query.hasAttachment !== undefined ? { hasAttachment: query.hasAttachment } : {}),
    ...(query.after ? { after: query.after } : {}),
    ...(query.before ? { before: query.before } : {}),
    ...(allMailScope ? { allMailScope: true } : {}),
  };
  return Object.keys(filter).length ? filter : undefined;
}

function matchesLocalMessageFilter(
  message: GraphMessage,
  filter: LocalMessageFilter | undefined,
  allMailExcludedFolderIds: ReadonlySet<string>,
): boolean {
  if (!filter) return true;
  if (filter.read !== undefined && message.isRead !== filter.read) return false;
  if (filter.starred !== undefined && (message.flag?.flagStatus === 'flagged') !== filter.starred) return false;
  const receivedAt = message.receivedDateTime ?? message.sentDateTime ?? message.createdDateTime;
  if (filter.after && (!receivedAt || receivedAt < `${filter.after}T00:00:00.000Z`)) return false;
  if (filter.before && (!receivedAt || receivedAt >= `${filter.before}T00:00:00.000Z`)) return false;
  if (filter.allMailScope && message.parentFolderId && allMailExcludedFolderIds.has(message.parentFolderId))
    return false;
  return true;
}

function escapeOData(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * The listed folder a path names. The target can't hold a role. No level can be a view such as Flagged, which
 * has no folder to create inside, or the trash, since messages can't be moved into folders there.
 */
function usableFolder(snapshot: FolderSnapshot, path: string, target: boolean): Folder | undefined {
  const folder = findByFolderName(snapshot.folders, path, (candidate) => candidate.name, true);
  if (folder?.role && (target || folder.role === 'starred' || folder.role === 'all' || folder.role === 'trash')) {
    throw new FolderNameError(`"${folder.name}" is the ${folder.role} folder. Choose another name.`);
  }
  return folder;
}

function graphAttachment(input: AttachmentInput): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: input.filename,
    contentType: input.mimeType,
    contentBytes: input.content,
    ...(input.contentId ? { contentId: input.contentId } : {}),
    isInline: input.disposition === 'inline',
  };
}

/** A category as listLabels lists it, or undefined when Graph left out its ID or name. */
function toLabel(category: GraphCategory): Label | undefined {
  if (!category.id || !category.displayName) return undefined;
  return {
    id: category.id,
    name: category.displayName,
    ...(category.color ? { color: { preset: category.color } } : {}),
  };
}

/** The listed category with an ID, when IDs are allowed, or with a name, ignoring case. */
function findCategory(categories: readonly Label[], value: string, byId: boolean): Label | undefined {
  return (
    (byId ? categories.find((category) => category.id === value) : undefined) ??
    findByFolderName(categories, value, (category) => category.name, true)
  );
}

/** The refusal Graph gives a connection that was granted only MailboxSettings.Read. */
function categoryWriteDenied(error: EmailError): FolderNameError {
  return new FolderNameError(
    "This Outlook connection can't change categories. Reauthorize the account to grant MailboxSettings.ReadWrite.",
    error.failure,
    'permission_denied',
  );
}

export class OutlookProvider implements EmailProvider {
  private readonly accountId: string;
  private readonly tokenProvider: MicrosoftAccessTokenProvider;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly resolveSender: ((email: string) => EmailAddress | undefined) | undefined;
  private folderCache: { fetchedAt: number; snapshot: FolderSnapshot } | undefined;

  constructor(options: OutlookProviderOptions) {
    this.accountId = options.accountId;
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.resolveSender = options.resolveSender;
  }

  get capabilities(): Capabilities {
    const snapshot = this.folderCache?.snapshot;
    return {
      ...OUTLOOK_CAPABILITIES,
      search: {
        ...OUTLOOK_CAPABILITIES.search,
        folderRoles: snapshot
          ? {
              inbox: snapshot.byRole.has('inbox') ? 'available' : 'unavailable',
              sent: snapshot.byRole.has('sent') ? 'available' : 'unavailable',
              drafts: snapshot.byRole.has('drafts') ? 'available' : 'unavailable',
              archive: snapshot.byRole.has('archive') ? 'available' : 'unavailable',
              spam: snapshot.byRole.has('spam') ? 'available' : 'unavailable',
              trash: snapshot.byRole.has('trash') ? 'available' : 'unavailable',
              all: 'available',
            }
          : OUTLOOK_CAPABILITIES.search.folderRoles,
      },
    };
  }

  private url(pathOrUrl: string): string {
    if (!/^https?:/i.test(pathOrUrl)) return `${GRAPH_ROOT}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    const url = new URL(pathOrUrl);
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/')) {
      throw new EmailError('invalid_request', 'Microsoft Graph returned an invalid continuation URL');
    }
    return pathOrUrl;
  }

  private async request<T = void>(pathOrUrl: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const url = this.url(pathOrUrl);
    let forceRefresh = false;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const headers = new Headers(init.headers);
        headers.set('accept', options.attachmentMaxBytes === undefined ? 'application/json' : '*/*');
        headers.set(
          'prefer',
          [headers.get('prefer'), 'IdType="ImmutableId"'].filter((value): value is string => Boolean(value)).join(', '),
        );
        if (options.includeAuth !== false) {
          const token = await this.tokenProvider.getAccessToken(forceRefresh).catch((error: unknown) => {
            throw toEmailError(error, 'token_refresh');
          });
          headers.set('authorization', `Bearer ${token}`);
        }
        if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
        options.signal?.throwIfAborted();
        const response = await this.fetchImpl(url, { ...init, headers, signal: options.signal });
        if (response.ok) {
          if (options.attachmentMaxBytes !== undefined) {
            return (await readAttachmentContent(response, options.attachmentMaxBytes)) as T;
          }
          if (response.status === 202 || response.status === 204) {
            await response.body?.cancel().catch(() => undefined);
            return undefined as T;
          }
          const text = await response.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
        let payload: { error?: { code?: string; message?: string } } = {};
        try {
          payload = (await response.json()) as typeof payload;
        } catch {
          // Some Exchange gateways return an HTML or empty error response.
        }
        const retryAfter = response.headers.get('retry-after');
        const parsedRetryAfterMs = retryAfter ? Number(retryAfter) * 1_000 : undefined;
        const retryAfterMs =
          parsedRetryAfterMs !== undefined && Number.isFinite(parsedRetryAfterMs) && parsedRetryAfterMs >= 0
            ? parsedRetryAfterMs
            : undefined;
        const error = new GraphHttpError(
          response.status,
          payload.error?.code,
          payload.error?.message ?? response.statusText ?? 'Microsoft Graph request failed',
          retryAfterMs,
        );
        if (response.status === 401 && !forceRefresh) {
          forceRefresh = true;
          lastError = error;
          continue;
        }
        throw error;
      } catch (error) {
        lastError = error;
        const retryable =
          isRetryableGraphError(error) && (!options.nonIdempotent || (error as GraphHttpError).status === 429);
        if (!retryable || attempt === MAX_RETRIES) break;
        const retryAfterMs = (error as GraphHttpError).retryAfterMs;
        await sleep(retryAfterMs ?? 250 * 2 ** attempt, options.signal);
      }
    }
    throw toEmailError(lastError);
  }

  async testConnection(): Promise<void> {
    await this.request('/me/mailFolders/inbox?$select=id');
  }

  private async collection<T>(pathOrUrl: string, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = pathOrUrl;
    while (next) {
      const page: GraphCollection<T> = await this.request(next, {}, { signal });
      items.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
    }
    return items;
  }

  private async folderSnapshot(forceRefresh = false, signal?: AbortSignal): Promise<FolderSnapshot> {
    if (!forceRefresh && this.folderCache && Date.now() - this.folderCache.fetchedAt < FOLDER_CACHE_TTL_MS) {
      return this.folderCache.snapshot;
    }

    const roleById = new Map<string, FolderRole>();
    // Exchange throttles more concurrent requests per mailbox than this. Every
    // lookup settles before a failure is thrown, so no request outlives this call.
    await forEachLimited(WELL_KNOWN_FOLDERS, MESSAGE_CONCURRENCY, async (known) => {
      try {
        const raw = await this.request<GraphFolder>(`/me/mailFolders/${known.id}?$select=id`, {}, { signal });
        if (raw.id) roleById.set(raw.id, known.role);
      } catch (error) {
        if (!(error instanceof EmailError) || error.code !== 'not_found' || known.role !== 'archive') throw error;
      }
    });

    const trashFolderId = [...roleById].find(([, role]) => role === 'trash')?.[0];
    const spamFolderId = [...roleById].find(([, role]) => role === 'spam')?.[0];
    const trashFolderIds = new Set(trashFolderId ? [trashFolderId] : []);
    const allMailExcludedRootFolderIds = new Set(
      [trashFolderId, spamFolderId].filter((id): id is string => Boolean(id)),
    );
    const allMailExcludedFolderIds = new Set(allMailExcludedRootFolderIds);
    const rawFolders: Array<{ raw: GraphFolder; parentPath: string }> = [];
    const visited = new Set<string>();
    const walk = async (
      path: string,
      parentPath: string,
      visibleBranch = true,
      insideTrash = false,
      insideAllMailExcluded = false,
    ): Promise<void> => {
      const children = await this.collection<GraphFolder>(path, signal);
      for (const raw of children) {
        if (!raw.id || !raw.displayName || visited.has(raw.id)) continue;
        visited.add(raw.id);
        const folderIsVisible = visibleBranch && !raw.isHidden;
        const folderIsInTrash = insideTrash || raw.id === trashFolderId;
        const folderIsAllMailExcluded = insideAllMailExcluded || raw.id === trashFolderId || raw.id === spamFolderId;
        if (folderIsVisible) rawFolders.push({ raw, parentPath });
        if (folderIsInTrash) trashFolderIds.add(raw.id);
        if (folderIsAllMailExcluded) allMailExcludedFolderIds.add(raw.id);
        if ((raw.childFolderCount ?? 0) > 0 && (folderIsVisible || folderIsInTrash || folderIsAllMailExcluded)) {
          const childPath = `${parentPath ? `${parentPath}/` : ''}${raw.displayName}`;
          await walk(
            `/me/mailFolders/${encodeURIComponent(raw.id)}/childFolders?includeHiddenFolders=true&$top=100`,
            childPath,
            folderIsVisible,
            folderIsInTrash,
            folderIsAllMailExcluded,
          );
        }
      }
    };
    await walk('/me/mailFolders?includeHiddenFolders=true&$top=100', '');

    const folders: Folder[] = rawFolders.map(({ raw, parentPath }) => ({
      id: raw.id!,
      name: parentPath ? `${parentPath}/${raw.displayName}` : raw.displayName!,
      ...(roleById.get(raw.id!) ? { role: roleById.get(raw.id!) } : {}),
      ...(typeof raw.unreadItemCount === 'number' ? { unreadCount: raw.unreadItemCount } : {}),
    }));
    folders.push({ id: 'starred', name: 'Flagged', role: 'starred' }, { id: 'all', name: 'All mail', role: 'all' });
    const snapshot: FolderSnapshot = {
      folders,
      byId: new Map(folders.map((folder) => [folder.id, folder])),
      byRole: new Map(folders.filter((folder) => folder.role).map((folder) => [folder.role!, folder])),
      trashFolderIds,
      allMailExcludedRootFolderIds,
      allMailExcludedFolderIds,
    };
    this.folderCache = { fetchedAt: Date.now(), snapshot };
    return snapshot;
  }

  async listFolders(): Promise<Folder[]> {
    return (await this.folderSnapshot(true)).folders;
  }

  /**
   * Creates a mail folder, with any missing parent folders. Levels are separated with "/", as folder names
   * list them, and names ignore case. An existing folder is returned unchanged.
   */
  async createFolder(name: string): Promise<Folder> {
    const requested = newFolderName(name);
    if (WELL_KNOWN_FOLDERS.some((folder) => folder.id === requested.toLowerCase())) {
      throw new FolderNameError(`"${requested}" is a system folder. Choose another name.`);
    }
    const levels = folderPathLevels(requested, '/');
    // Another mail app may have changed the folders within the cache lifetime.
    let snapshot = await this.folderSnapshot(true);
    // The deepest level that already exists. Looking from the full path down keeps a folder whose own name
    // contains "/" from being read as a missing parent with a child.
    let folder: Folder | undefined;
    let existingDepth = 0;
    for (let depth = levels.length; depth >= 1 && !folder; depth--) {
      folder = usableFolder(snapshot, levels.slice(0, depth).join('/'), depth === levels.length);
      if (folder) existingDepth = depth;
    }
    if (folder && snapshot.trashFolderIds.has(folder.id)) {
      throw new FolderNameError(`"${folder.name}" is in the trash. Choose another name.`);
    }
    for (let depth = existingDepth + 1; depth <= levels.length; depth++) {
      const level = levels[depth - 1]!;
      const parent = folder;
      const path = parent ? `${parent.name}/${level}` : level;
      // A missing parent such as "SentItems" in "SentItems/2025" would be read as a system folder.
      if (isFolderRoleName(path) || WELL_KNOWN_FOLDERS.some((known) => known.id === path.toLowerCase())) {
        throw new FolderNameError(`"${path}" is a system folder. Choose another name.`);
      }
      try {
        const created = await this.request<GraphFolder>(
          parent ? `/me/mailFolders/${encodeURIComponent(parent.id)}/childFolders` : '/me/mailFolders',
          { method: 'POST', body: JSON.stringify({ displayName: level }) },
          { nonIdempotent: true },
        );
        this.folderCache = undefined;
        if (!created?.id) throw invalidResponseError('Microsoft Graph did not return a folder id');
        const displayName = created.displayName ?? level;
        folder = {
          id: created.id,
          name: parent ? `${parent.name}/${displayName}` : displayName,
          ...(typeof created.unreadItemCount === 'number' ? { unreadCount: created.unreadItemCount } : {}),
        };
      } catch (error) {
        // Graph refuses a name that is already taken, including by a folder created since the listing.
        if (!(error instanceof EmailError) || error.code !== 'invalid_request') throw error;
        snapshot = await this.folderSnapshot(true);
        folder = usableFolder(snapshot, path, depth === levels.length);
        if (!folder) {
          throw new FolderNameError(
            error.failure?.httpStatus === 409
              ? `A folder named "${path}" already exists but is hidden from folder lists. Choose another name.`
              : `Outlook would not create the folder "${path}". The name may use characters or a length Outlook doesn't allow.`,
            error.failure,
          );
        }
      }
    }
    return folder!;
  }

  /**
   * Deletes an empty mail folder. A folder in Deleted Items is refused, because removing it would empty the trash.
   * The counts come from Graph right before the delete, not from the cached folder list.
   */
  async deleteFolder(folder: string): Promise<Folder> {
    const requested = folder.trim();
    if (!requested) throw new FolderNameError('The folder name is empty.');
    // Another mail app may have changed the folders within the cache lifetime.
    const snapshot = await this.folderSnapshot(true);
    // A listed folder wins over a role word, so a user folder named Spam, beside Junk Email, can go.
    const match =
      snapshot.byId.get(requested) ??
      findByFolderName(snapshot.folders, requested, (candidate) => candidate.name, true);
    if (!match) {
      if (isFolderRoleName(requested) || WELL_KNOWN_FOLDERS.some((known) => known.id === requested.toLowerCase())) {
        throw systemFolderNotDeletable(requested);
      }
      throw new FolderNotFoundError(requested);
    }
    if (match.role) throw systemFolderNotDeletable(match.name);
    if (snapshot.trashFolderIds.has(match.id)) {
      throw new FolderDeleteRefusedError(`"${match.name}" is already in Deleted Items.`);
    }
    const path = `/me/mailFolders/${encodeURIComponent(match.id)}`;
    let current: GraphFolder;
    try {
      current = await this.request<GraphFolder>(`${path}?$select=id,totalItemCount,childFolderCount`);
    } catch (error) {
      if (error instanceof EmailError && error.code === 'not_found') throw new FolderNotFoundError(requested);
      throw error;
    }
    // Without both counts, the folder can't be shown to be empty, so it stays.
    if (typeof current.totalItemCount !== 'number' || typeof current.childFolderCount !== 'number') {
      throw invalidResponseError(`Microsoft Graph did not say what the folder "${match.name}" holds`);
    }
    if (current.childFolderCount > 0) {
      // Graph counts hidden child folders too, which folder lists leave out, so the caller can't delete them here.
      const prefix = `${match.name}/`;
      const listedChildren = snapshot.folders.filter(
        (candidate) => candidate.name.startsWith(prefix) && !candidate.name.slice(prefix.length).includes('/'),
      );
      if (listedChildren.length < current.childFolderCount) {
        throw new FolderDeleteRefusedError(
          `"${match.name}" has subfolders that Outlook hides from folder lists. Delete them in Outlook first.`,
        );
      }
      throw folderHasSubfolders(match.name);
    }
    if (current.totalItemCount > 0) throw folderHasMessages(match.name, current.totalItemCount);
    try {
      await this.request(path, { method: 'DELETE' }, { nonIdempotent: true });
    } catch (error) {
      if (!(error instanceof EmailError)) throw error;
      if (error.code === 'not_found') throw new FolderNotFoundError(requested);
      if (error.failure?.httpStatus === 409) {
        throw new FolderNameError(
          `Outlook would not delete the folder "${match.name}". Delete it in Outlook instead.`,
          error.failure,
        );
      }
      // Graph refuses folders Outlook keeps for itself, such as Outbox, which have no role here.
      if (error.code === 'invalid_request' || error.code === 'permission_denied') {
        const reason =
          error.code === 'permission_denied'
            ? 'It may be a folder Outlook keeps for its own use, or this connection may not allow changing folders.'
            : 'It may be a folder Outlook keeps for its own use, such as Outbox or Conversation History.';
        throw new FolderNameError(
          `Outlook would not delete the folder "${match.name}". ${reason}`,
          error.failure,
          error.code,
        );
      }
      throw error;
    } finally {
      this.folderCache = undefined;
    }
    return match;
  }

  /**
   * Renames a mail folder in place. Its subfolders follow, since Graph nests folders by ID. A folder in Deleted
   * Items is refused, as it is for a new folder.
   */
  async renameFolder(folder: string, name: string): Promise<RenamedFolder> {
    const requested = folder.trim();
    if (!requested) throw new FolderNameError('The folder name is empty.');
    const leaf = renamedFolderName(name, '/');
    // Another mail app may have changed the folders within the cache lifetime.
    const snapshot = await this.folderSnapshot(true);
    const match =
      snapshot.byId.get(requested) ??
      findByFolderName(snapshot.folders, requested, (candidate) => candidate.name, true);
    if (!match) {
      if (isFolderRoleName(requested) || WELL_KNOWN_FOLDERS.some((known) => known.id === requested.toLowerCase())) {
        throw systemFolderNotRenamable(requested);
      }
      throw new FolderNotFoundError(requested);
    }
    if (match.role) throw systemFolderNotRenamable(match.name);
    if (snapshot.trashFolderIds.has(match.id)) {
      throw new FolderRenameRefusedError(`"${match.name}" is in Deleted Items, so it can't be renamed.`);
    }
    const path = `/me/mailFolders/${encodeURIComponent(match.id)}`;
    let current: GraphFolder;
    try {
      current = await this.request<GraphFolder>(`${path}?$select=id,displayName`);
    } catch (error) {
      if (error instanceof EmailError && error.code === 'not_found') throw new FolderNotFoundError(requested);
      throw error;
    }
    if (!current.displayName) {
      throw invalidResponseError(`Microsoft Graph did not return the name of the folder "${match.name}"`);
    }
    // The listed name is the path, and a folder's own name can contain "/", so the parent path is what is left
    // once the folder's own name is taken off the end.
    const parentPath =
      match.name === current.displayName
        ? ''
        : match.name.endsWith(`/${current.displayName}`)
          ? match.name.slice(0, -current.displayName.length)
          : match.name.slice(0, match.name.lastIndexOf('/') + 1);
    if (leaf === current.displayName) return { folder: match, previous: match };
    const newName = `${parentPath}${leaf}`;
    if (isFolderRoleName(newName) || WELL_KNOWN_FOLDERS.some((known) => known.id === newName.toLowerCase())) {
      throw new FolderNameError(`"${newName}" is a system folder. Choose another name.`);
    }
    const taken = findByFolderName(
      snapshot.folders.filter((candidate) => candidate.id !== match.id),
      newName,
      (candidate) => candidate.name,
      true,
    );
    if (taken) throw folderNameTaken(taken.name);
    let updated: GraphFolder | undefined;
    try {
      updated = await this.request<GraphFolder>(path, {
        method: 'PATCH',
        body: JSON.stringify({ displayName: leaf }),
      });
    } catch (error) {
      if (!(error instanceof EmailError)) throw error;
      if (error.code === 'not_found') throw new FolderNotFoundError(requested);
      // Graph refuses a name that is already taken, including by a folder it hides from folder lists.
      if (error.failure?.httpStatus === 409) throw folderNameTaken(newName, error.failure);
      // Graph also refuses folders Outlook keeps for itself, such as Outbox, which have no role here.
      if (error.code === 'invalid_request' || error.code === 'permission_denied') {
        const reason =
          error.code === 'permission_denied'
            ? 'It may be a folder Outlook keeps for its own use, or this connection may not allow changing folders.'
            : "The name may use characters or a length Outlook doesn't allow, or the folder may be one Outlook keeps for its own use.";
        throw new FolderNameError(
          `Outlook would not rename the folder "${match.name}" to "${newName}". ${reason}`,
          error.failure,
          error.code,
        );
      }
      throw error;
    } finally {
      this.folderCache = undefined;
    }
    return { folder: { ...match, name: `${parentPath}${updated?.displayName ?? leaf}` }, previous: match };
  }

  /**
   * Moves a mail folder under another folder, or to the top level. Its subfolders follow, since Graph nests
   * folders by ID. A folder in Deleted Items is refused, and so is a destination there.
   */
  async moveFolder(folder: string, parent: string | null): Promise<RenamedFolder> {
    const requested = folder.trim();
    if (!requested) throw new FolderNameError('The folder name is empty.');
    const destination = parent?.trim();
    if (parent !== null && !destination) throw new FolderNameError('The destination folder name is empty.');
    // Another mail app may have changed the folders within the cache lifetime.
    const snapshot = await this.folderSnapshot(true);
    const find = (value: string) =>
      snapshot.byId.get(value) ?? findByFolderName(snapshot.folders, value, (candidate) => candidate.name, true);
    const isSystemName = (value: string) =>
      isFolderRoleName(value) || WELL_KNOWN_FOLDERS.some((known) => known.id === value.toLowerCase());
    const match = find(requested);
    if (!match) {
      if (isSystemName(requested)) throw systemFolderNotMovable(requested);
      throw new FolderNotFoundError(requested);
    }
    if (match.role) throw systemFolderNotMovable(match.name);
    if (snapshot.trashFolderIds.has(match.id)) {
      throw new FolderMoveRefusedError(`"${match.name}" is in Deleted Items, so it can't be moved.`);
    }
    let target: Folder | undefined;
    if (destination) {
      target = find(destination);
      if (!target) throw new FolderNotFoundError(destination);
      // Starred and All mail are views, not folders that hold other folders.
      if (target.role === 'starred' || target.role === 'all') {
        throw new FolderMoveRefusedError(`"${target.name}" is a view, not a folder, so nothing can be moved into it.`);
      }
      if (snapshot.trashFolderIds.has(target.id)) {
        throw new FolderMoveRefusedError(`"${target.name}" is in Deleted Items, so a folder can't be moved into it.`);
      }
      if (target.id === match.id || target.name.startsWith(`${match.name}/`)) {
        throw folderMovedIntoItself(match.name, target.name);
      }
    }
    const path = `/me/mailFolders/${encodeURIComponent(match.id)}`;
    let current: GraphFolder;
    try {
      current = await this.request<GraphFolder>(`${path}?$select=id,displayName`);
    } catch (error) {
      if (error instanceof EmailError && error.code === 'not_found') throw new FolderNotFoundError(requested);
      throw error;
    }
    if (!current.displayName) {
      throw invalidResponseError(`Microsoft Graph did not return the name of the folder "${match.name}"`);
    }
    // The listed name is the path, and a folder's own name can contain "/".
    const currentParent =
      match.name === current.displayName
        ? ''
        : match.name.endsWith(`/${current.displayName}`)
          ? match.name.slice(0, -current.displayName.length - 1)
          : match.name.slice(0, Math.max(match.name.lastIndexOf('/'), 0));
    if (currentParent === (target?.name ?? '')) return { folder: match, previous: match };
    const newName = target ? `${target.name}/${current.displayName}` : current.displayName;
    if (isSystemName(newName)) {
      throw new FolderNameError(`"${newName}" is a system folder. Rename the folder before moving it.`);
    }
    const taken = findByFolderName(
      snapshot.folders.filter((candidate) => candidate.id !== match.id),
      newName,
      (candidate) => candidate.name,
      true,
    );
    if (taken) throw folderNameTaken(taken.name);
    let moved: GraphFolder | undefined;
    try {
      moved = await this.request<GraphFolder>(
        `${path}/move`,
        { method: 'POST', body: JSON.stringify({ destinationId: target?.id ?? 'msgfolderroot' }) },
        { nonIdempotent: true },
      );
    } catch (error) {
      if (!(error instanceof EmailError)) throw error;
      if (error.code === 'not_found') throw new FolderNotFoundError(requested);
      // Graph refuses a name that is already taken, including by a folder it hides from folder lists.
      if (error.failure?.httpStatus === 409) throw folderNameTaken(newName, error.failure);
      // Graph also refuses folders Outlook keeps for itself, such as Outbox, which have no role here.
      if (error.code === 'invalid_request' || error.code === 'permission_denied') {
        const reason =
          error.code === 'permission_denied'
            ? 'It may be a folder Outlook keeps for its own use, or this connection may not allow changing folders.'
            : 'One of the two may be a folder Outlook keeps for its own use.';
        throw new FolderNameError(
          `Outlook would not move the folder "${match.name}" to "${newName}". ${reason}`,
          error.failure,
          error.code,
        );
      }
      throw error;
    } finally {
      this.folderCache = undefined;
    }
    // Graph can give a moved folder a new ID.
    return { folder: { ...match, id: moved?.id ?? match.id, name: newName }, previous: match };
  }

  async listLabels(): Promise<Label[]> {
    let categories: GraphCategory[];
    try {
      categories = await this.collection<GraphCategory>('/me/outlook/masterCategories?$top=100');
    } catch (error) {
      if (error instanceof EmailError && error.code === 'permission_denied') {
        throw new EmailError(
          'permission_denied',
          'This Outlook connection cannot read categories. Reauthorize the account to grant MailboxSettings.Read.',
        );
      }
      throw error;
    }
    return categories.flatMap((category) => {
      const label = toLabel(category);
      return label ? [label] : [];
    });
  }

  /**
   * Adds a category to the mailbox's category list and returns it. Outlook category names ignore case, and an
   * existing category is returned unchanged. Changing the list needs MailboxSettings.ReadWrite, which accounts
   * connected before category changes may not have granted.
   */
  async createLabel(name: string): Promise<Label> {
    const requested = newLabelName(name, 'category');
    const existing = findCategory(await this.categoriesToChange(), requested, false);
    if (existing) return existing;
    try {
      const created = await this.request<GraphCategory>(
        '/me/outlook/masterCategories',
        // Graph doesn't document a default color, so the category is created with none.
        { method: 'POST', body: JSON.stringify({ displayName: requested, color: 'none' }) },
        { nonIdempotent: true },
      );
      const label = created && toLabel(created);
      if (!label) throw invalidResponseError('Microsoft Graph did not return the new category');
      return label;
    } catch (error) {
      if (!(error instanceof EmailError)) throw error;
      if (error.code === 'permission_denied') throw categoryWriteDenied(error);
      if (error.code !== 'invalid_request') throw error;
      // Graph refuses a name that is already taken, including by a category created since the listing.
      const created = findCategory(await this.categoriesToChange(), requested, false);
      if (created) return created;
      throw new FolderNameError(
        `Outlook would not create the category "${requested}". The name may use characters or a length Outlook doesn't allow.`,
        error.failure,
      );
    }
  }

  /** The category list, read before a change. A connection that can't read it can't change it either. */
  private async categoriesToChange(): Promise<Label[]> {
    try {
      return await this.listLabels();
    } catch (error) {
      if (error instanceof EmailError && error.code === 'permission_denied') throw categoryWriteDenied(error);
      throw error;
    }
  }

  /** Removes a category from the mailbox's category list, given its ID or name, and returns it as it was listed. */
  async deleteLabel(label: string): Promise<Label> {
    const requested = label.trim();
    if (!requested) throw new FolderNameError('The category name is empty.');
    const match = findCategory(await this.categoriesToChange(), requested, true);
    if (!match) throw new LabelNotFoundError(requested, 'category');
    try {
      await this.request(
        `/me/outlook/masterCategories/${encodeURIComponent(match.id)}`,
        { method: 'DELETE' },
        { nonIdempotent: true },
      );
    } catch (error) {
      if (!(error instanceof EmailError)) throw error;
      if (error.code === 'not_found') throw new LabelNotFoundError(requested, 'category');
      if (error.code === 'permission_denied') throw categoryWriteDenied(error);
      throw error;
    }
    return match;
  }

  private async resolveCategoryNames(values: string[]): Promise<string[]> {
    const categories = await this.listLabels();
    const resolved = values.map((value) => {
      return findCategory(categories, value, true)?.name ?? value;
    });
    const seen = new Set<string>();
    return resolved.filter((name) => {
      const key = folderNameKey(name, true);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async resolveFolder(value: string, signal?: AbortSignal): Promise<Folder> {
    const normalized = value.toLowerCase();
    const folders = await this.folderSnapshot(false, signal);
    const wellKnownRole = WELL_KNOWN_FOLDERS.find((folder) => folder.id === normalized)?.role;
    const role = folders.byRole.get(wellKnownRole ?? (normalized as FolderRole));
    const match =
      role ?? folders.byId.get(value) ?? findByFolderName(folders.folders, value, (folder) => folder.name, true);
    if (!match) throw new EmailError('not_found', `No Outlook folder named "${value}"`);
    return match;
  }

  async listMessages(input: EmailQuery, page: PageOpts = {}): Promise<MessageSearchPage> {
    page.signal?.throwIfAborted();
    const normalized = normalizeEmailQuery(input);
    if (!normalized.success) {
      throw new EmailError('invalid_request', normalized.diagnostics.map((item) => item.message).join(' '), {
        diagnostics: normalized.diagnostics,
      });
    }
    const query = normalized.query;
    if (page.includeSearchContext && !query.text) {
      throw new EmailError('invalid_request', 'includeSearchContext requires a portable text query.');
    }
    const resolvedFolder = query.folder ? await this.resolveFolder(query.folder, page.signal) : undefined;
    const starredFolder = resolvedFolder?.role === 'starred';
    const folder = resolvedFolder?.role === 'all' || starredFolder ? undefined : resolvedFolder;
    const normalizedQuery = { ...query, ...(starredFolder ? { starred: true } : {}), folder: undefined };
    const graphQuery = toGraphQuery(normalizedQuery);
    const folders = await this.folderSnapshot(false, page.signal);
    const allMailScope = !folder;
    const excludedRootFolderIds = allMailScope ? [...folders.allMailExcludedRootFolderIds] : [];
    const allMailFilter = excludedRootFolderIds.map((id) => `parentFolderId ne '${escapeOData(id)}'`).join(' and ');
    let requestUrl: string;
    let localFilter: LocalMessageFilter | undefined;
    let candidateOffset = 0;
    if (page.pageToken) {
      const decoded = decodePageToken(page.pageToken);
      requestUrl = decoded.url;
      localFilter = decoded.localFilter;
      candidateOffset = decoded.offset ?? 0;
    } else {
      const base = folder ? `/me/mailFolders/${encodeURIComponent(folder.id)}/messages` : '/me/messages';
      const params = new URLSearchParams({
        $top: String(Math.min(Math.max(page.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)),
        $select: MESSAGE_LIST_FIELDS,
      });
      if (graphQuery.search) params.set('$search', graphQuery.search);
      if (!graphQuery.search) {
        const filter = [graphQuery.filter, allMailFilter].filter(Boolean).join(' and ');
        if (filter) params.set('$filter', filter);
      }
      localFilter = localMessageFilter(normalizedQuery, allMailScope);
      requestUrl = `${base}?${params}`;
    }
    const pageSize = Math.min(Math.max(page.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const items: Message[] = [];
    let inspectedCandidates = 0;
    let nextPageToken: string | undefined;
    let timeLimited = false;
    const diagnostics: NonNullable<MessageSearchPage['diagnostics']> = [];
    do {
      const response = await this.request<GraphCollection<GraphMessage>>(requestUrl, {}, { signal: page.signal });
      const candidates = response.value ?? [];
      if (candidateOffset > candidates.length) {
        throw new EmailError('invalid_request', 'Invalid Microsoft Graph page token');
      }
      let processedCandidates = 0;
      for (const raw of candidates.slice(candidateOffset)) {
        page.signal?.throwIfAborted();
        if (page.softDeadlineAt !== undefined && Date.now() >= page.softDeadlineAt) {
          timeLimited = true;
          break;
        }
        if (inspectedCandidates >= 1_000) break;
        inspectedCandidates += 1;
        processedCandidates += 1;
        if (!matchesLocalMessageFilter(raw, localFilter, folders.allMailExcludedFolderIds)) continue;
        if (localFilter?.hasAttachment !== undefined) {
          if (!raw.id) continue;
          const attachments = await this.collection<GraphAttachment>(
            `/me/messages/${encodeURIComponent(raw.id)}/attachments?$select=${ATTACHMENT_METADATA_SELECT}`,
            page.signal,
          );
          const hasAttachment = attachments.some((attachment) => attachment.isInline !== true);
          if (hasAttachment !== localFilter.hasAttachment) continue;
        }
        const message = parseGraphMessage(raw, {
          accountId: this.accountId,
          ...(raw.parentFolderId && folders.byId.get(raw.parentFolderId)
            ? { folder: folders.byId.get(raw.parentFolderId) }
            : {}),
        });
        if (page.includeSnippet === false) delete message.snippet;
        if (page.includeSearchContext && query.text) {
          try {
            const body = await this.request<GraphMessage>(
              `/me/messages/${encodeURIComponent(message.id)}?$select=body`,
              { headers: { prefer: 'outlook.body-content-type="text"' } },
              { signal: page.signal },
            );
            message.searchContext =
              body.body?.content == null
                ? { status: 'unavailable' }
                : extractSearchContext({ text: body.body.content }, query.text);
          } catch {
            page.signal?.throwIfAborted();
            message.searchContext = { status: 'unavailable' };
            diagnostics.push({
              code: 'search_context_unavailable',
              severity: 'warning',
              message: 'Search context could not be loaded for a message. Message metadata is still available.',
            });
          }
        }
        items.push(message);
        if (items.length === pageSize) break;
      }
      const next = response['@odata.nextLink'];
      const consumedOffset = candidateOffset + processedCandidates;
      if (timeLimited || items.length === pageSize || inspectedCandidates >= 1_000) {
        nextPageToken =
          consumedOffset < candidates.length
            ? encodePageToken(this.url(requestUrl), localFilter, consumedOffset)
            : next
              ? encodePageToken(next, localFilter)
              : undefined;
        break;
      }
      if (!next) break;
      requestUrl = next;
      candidateOffset = 0;
    } while (inspectedCandidates < 1_000);

    const providerLimited =
      Boolean(graphQuery.search) && items.length < pageSize && inspectedCandidates >= 1_000 && !nextPageToken;
    return {
      items,
      exhausted: !nextPageToken && !providerLimited,
      ...(nextPageToken ? { nextPageToken } : {}),
      ...(localFilter ? { inspectedCandidates } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
      ...(items.length < pageSize && inspectedCandidates >= 1_000 && nextPageToken
        ? { incomplete: true as const, incompleteReason: 'scan_limit' as const }
        : providerLimited
          ? { incomplete: true as const, incompleteReason: 'provider_limit' as const }
          : timeLimited && nextPageToken
            ? { incomplete: true as const, incompleteReason: 'time_limit' as const }
            : {}),
    };
  }

  private async rawMessage(id: string, includeHeaders = false): Promise<GraphMessage> {
    const params = new URLSearchParams({
      $select: `${MESSAGE_FULL_FIELDS}${includeHeaders ? ',internetMessageHeaders' : ''}`,
      $expand: `attachments($select=${ATTACHMENT_SELECT})`,
    });
    return this.request(`/me/messages/${encodeURIComponent(id)}?${params}`);
  }

  async getMessage(id: string, options: GetMessageOpts = {}): Promise<Message> {
    const raw = await this.rawMessage(id, options.includeHeaders ?? false);
    const folders = await this.folderSnapshot();
    return parseGraphMessage(raw, {
      accountId: this.accountId,
      ...(raw.parentFolderId && folders.byId.get(raw.parentFolderId)
        ? { folder: folders.byId.get(raw.parentFolderId) }
        : {}),
      includeBody: true,
      includeAttachments: true,
      includeHeaders: options.includeHeaders,
    });
  }

  async getThread(threadId: string): Promise<Thread> {
    const params = new URLSearchParams({
      $filter: `conversationId eq '${escapeOData(threadId)}'`,
      $select: 'id',
      $top: '100',
    });
    const raw = await this.collection<GraphMessage>(`/me/messages?${params}`);
    const messageIds = raw.flatMap((message) => (message.id ? [message.id] : []));
    if (!messageIds.length) throw new EmailError('not_found', `No Outlook thread with id "${threadId}"`);
    const messages = await Promise.all(messageIds.map((id) => this.getMessage(id)));
    messages.sort((a, b) => a.date.localeCompare(b.date));
    return { id: threadId, subject: messages[0]?.subject ?? '', messages };
  }

  /**
   * Outlook reports no sender name. Fluxmail sets none for the default sender, and for an explicit sender
   * the mail service may replace the configured name with the mailbox's own, so neither is known here.
   */
  async senderName(): Promise<string | undefined> {
    return undefined;
  }

  private draftPayload(draft: DraftInput, newMessage: boolean): Record<string, unknown> {
    const sender = draft.from ? (this.resolveSender?.(draft.from) ?? { email: draft.from }) : undefined;
    return {
      ...(newMessage || draft.subject !== undefined ? { subject: draft.subject ?? '' } : {}),
      body: bodyFor(draft),
      ...(newMessage || draft.to !== undefined ? { toRecipients: toGraphRecipients(draft.to) } : {}),
      ...(newMessage || draft.cc !== undefined ? { ccRecipients: toGraphRecipients(draft.cc) } : {}),
      ...(newMessage || draft.bcc !== undefined ? { bccRecipients: toGraphRecipients(draft.bcc) } : {}),
      ...(sender
        ? {
            from: {
              emailAddress: {
                address: sender.email,
                ...(sender.name ? { name: sender.name } : {}),
              },
            },
          }
        : {}),
    };
  }

  private decodedAttachment(input: AttachmentInput): Buffer {
    const content = Buffer.from(input.content, 'base64');
    const normalized = input.content.replace(/\s/g, '').replace(/=+$/, '');
    let encodedOffset = 0;
    // Re-encode in chunks so a large attachment isn't held twice as base64. Multiples of three
    // keep padding confined to the final chunk.
    for (let offset = 0; offset < content.length; offset += 49152) {
      const encoded = content
        .subarray(offset, offset + 49152)
        .toString('base64')
        .replace(/=+$/, '');
      if (normalized.slice(encodedOffset, encodedOffset + encoded.length) !== encoded) {
        throw new EmailError('invalid_request', `Attachment "${input.filename}" is not valid base64`);
      }
      encodedOffset += encoded.length;
    }
    if (encodedOffset !== normalized.length) {
      throw new EmailError('invalid_request', `Attachment "${input.filename}" is not valid base64`);
    }
    return content;
  }

  private async addAttachment(messageId: string, input: AttachmentInput): Promise<void> {
    const content = this.decodedAttachment(input);
    if (content.length < SMALL_ATTACHMENT_LIMIT) {
      await this.request(
        `/me/messages/${encodeURIComponent(messageId)}/attachments`,
        { method: 'POST', body: JSON.stringify(graphAttachment(input)) },
        { nonIdempotent: true },
      );
      return;
    }
    const session = await this.request<{ uploadUrl?: string }>(
      `/me/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
      {
        method: 'POST',
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: 'file',
            name: input.filename,
            size: content.length,
            contentType: input.mimeType,
            isInline: input.disposition === 'inline',
            ...(input.contentId ? { contentId: input.contentId } : {}),
          },
        }),
      },
      { nonIdempotent: true },
    );
    if (!session.uploadUrl) throw invalidResponseError('Microsoft Graph returned no attachment upload URL');
    for (let start = 0; start < content.length; start += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(start + UPLOAD_CHUNK_BYTES, content.length) - 1;
      const response = await this.fetchImpl(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${content.length}`,
          'content-type': 'application/octet-stream',
        },
        body: content.subarray(start, end + 1),
      });
      try {
        if (!response.ok) {
          throw new EmailError(
            'provider_unavailable',
            `Microsoft Graph attachment upload failed (${response.status})`,
            undefined,
            {
              reason: 'http_error',
              httpStatus: response.status,
            },
          );
        }
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    }
  }

  private async replaceAttachments(messageId: string, attachments: AttachmentInput[] = []): Promise<void> {
    const current = await this.collection<GraphAttachment>(
      `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id`,
    );
    await Promise.all(
      current
        .filter((attachment) => attachment.id)
        .map((attachment) =>
          this.request(
            `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id!)}`,
            {
              method: 'DELETE',
            },
          ),
        ),
    );
    for (const attachment of attachments) await this.addAttachment(messageId, attachment);
  }

  async createDraft(draft: DraftInput): Promise<Message> {
    let created: GraphMessage;
    if (draft.replyToMessageId) {
      created = await this.request(
        `/me/messages/${encodeURIComponent(draft.replyToMessageId)}/createReply`,
        { method: 'POST' },
        { nonIdempotent: true },
      );
      if (!created.id) throw invalidResponseError('Microsoft Graph returned a reply draft without an id');
      await this.request(`/me/messages/${encodeURIComponent(created.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(this.draftPayload(draft, false)),
      });
    } else {
      created = await this.request(
        '/me/messages',
        { method: 'POST', body: JSON.stringify(this.draftPayload(draft, true)) },
        { nonIdempotent: true },
      );
    }
    if (!created.id) throw invalidResponseError('Microsoft Graph returned a draft without an id');
    for (const attachment of draft.attachments ?? []) await this.addAttachment(created.id, attachment);
    return this.getDraft(created.id);
  }

  async getDraft(draftId: string): Promise<Message> {
    const message = await this.getMessage(draftId);
    if (!message.flags.draft) throw new EmailError('not_found', `Message ${draftId} is not an Outlook draft`);
    message.draftId = draftId;
    return message;
  }

  async updateDraft(draftId: string, draft: DraftInput): Promise<Message> {
    const existing = await this.getDraft(draftId);
    let replacement = draft;
    if (draft.replyToMessageId) {
      const replyTarget = await this.getMessage(draft.replyToMessageId);
      if (existing.threadId !== replyTarget.threadId) {
        throw new EmailError('unsupported_capability', 'Outlook cannot move an existing draft to another conversation');
      }
      if (draft.subject === undefined) {
        replacement = { ...draft, subject: replySubject(replyTarget.subject) };
      }
    }
    await this.request(`/me/messages/${encodeURIComponent(draftId)}`, {
      method: 'PATCH',
      body: JSON.stringify(this.draftPayload(replacement, true)),
    });
    await this.replaceAttachments(draftId, draft.attachments);
    return this.getDraft(draftId);
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.getDraft(draftId);
    await this.request(
      `/me/messages/${encodeURIComponent(draftId)}/permanentDelete`,
      { method: 'POST' },
      { nonIdempotent: true },
    );
  }

  async send(input: DraftInput | { draftId: string }): Promise<SendResult> {
    if (
      !('draftId' in input) &&
      !input.replyToMessageId &&
      !input.to?.length &&
      !input.cc?.length &&
      !input.bcc?.length
    ) {
      throw new EmailError('invalid_request', 'Cannot send a message with no recipients');
    }
    const draft = 'draftId' in input ? await this.getDraft(input.draftId) : await this.createDraft(input);
    if (!draft.to.length && !draft.cc?.length && !draft.bcc?.length) {
      throw new EmailError('invalid_request', 'Cannot send a message with no recipients');
    }
    await this.request(
      `/me/messages/${encodeURIComponent(draft.draftId ?? draft.id)}/send`,
      { method: 'POST' },
      { nonIdempotent: true },
    );
    return { id: draft.id, threadId: draft.threadId };
  }

  private async move(ids: string[], destinationId: string): Promise<void> {
    await forEachLimited(ids, MESSAGE_CONCURRENCY, async (id) => {
      await this.request(
        `/me/messages/${encodeURIComponent(id)}/move`,
        {
          method: 'POST',
          body: JSON.stringify({ destinationId }),
        },
        { nonIdempotent: true },
      );
    });
  }

  private async assertMessagesOutsideTrash(ids: string[]): Promise<void> {
    const folders = await this.folderSnapshot();
    await forEachLimited(ids, MESSAGE_CONCURRENCY, async (id) => {
      const message = await this.request<GraphMessage>(
        `/me/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: 'parentFolderId' })}`,
      );
      if (!message.parentFolderId) {
        throw invalidResponseError(`Microsoft Graph returned no parent folder for message "${id}"`);
      }
      if (folders.trashFolderIds.has(message.parentFolderId)) {
        throw new EmailError('invalid_request', 'Use the untrash action before moving a message from Trash');
      }
    });
  }

  async modify(ids: string[], action: ModifyAction): Promise<void> {
    if (!ids.length) return;
    if (typeof action === 'object' && ('addLabels' in action || 'removeLabels' in action)) {
      const adding = 'addLabels' in action;
      const requested = [...new Set(adding ? action.addLabels : action.removeLabels)];
      const resolved = await this.resolveCategoryNames(requested);
      if (!resolved.length) return;
      const requestedNames = new Set(resolved.map((label) => folderNameKey(label, true)));
      await forEachLimited(ids, MESSAGE_CONCURRENCY, async (id) => {
        const message = await this.request<GraphMessage>(
          `/me/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: 'categories' })}`,
        );
        const current = message.categories ?? [];
        const currentNames = new Set(current.map((label) => folderNameKey(label, true)));
        const categories = adding
          ? [...current, ...resolved.filter((label) => !currentNames.has(folderNameKey(label, true)))]
          : current.filter((label) => !requestedNames.has(folderNameKey(label, true)));
        if (categories.length === current.length && categories.every((label, index) => label === current[index]))
          return;
        await this.request(`/me/messages/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ categories }),
        });
      });
      return;
    }
    if (action === 'archive') {
      const archive = await this.resolveFolder('archive');
      if (!archive) throw new EmailError('not_found', 'This Outlook mailbox has no archive folder');
      await this.assertMessagesOutsideTrash(ids);
      return this.move(ids, archive.id);
    }
    if (action === 'trash') return this.move(ids, 'deleteditems');
    if (action === 'untrash') return this.move(ids, 'inbox');
    if (typeof action === 'object' && 'move' in action) {
      const target = await this.resolveFolder(action.move);
      const targetIsInTrash = (await this.folderSnapshot()).trashFolderIds.has(target.id);
      if (
        !target ||
        target.role === 'all' ||
        target.role === 'starred' ||
        target.role === 'archive' ||
        target.role === 'trash' ||
        targetIsInTrash
      ) {
        throw new EmailError('invalid_request', `Cannot move messages to "${action.move}"`);
      }
      await this.assertMessagesOutsideTrash(ids);
      return this.move(ids, target.id);
    }
    if (action === 'delete') {
      return forEachLimited(ids, MESSAGE_CONCURRENCY, async (id) => {
        await this.request(
          `/me/messages/${encodeURIComponent(id)}/permanentDelete`,
          {
            method: 'POST',
          },
          { nonIdempotent: true },
        );
      });
    }

    let patch: Record<string, unknown>;
    if (action === 'markRead') patch = { isRead: true };
    else if (action === 'markUnread') patch = { isRead: false };
    else if (action === 'star') patch = { flag: { flagStatus: 'flagged' } };
    else if (action === 'unstar') patch = { flag: { flagStatus: 'notFlagged' } };
    else throw new EmailError('unsupported_capability', 'Outlook does not support this message action');
    await forEachLimited(ids, MESSAGE_CONCURRENCY, (id) =>
      this.request(`/me/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    );
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    options: GetAttachmentOpts = {},
  ): Promise<{ meta: AttachmentMeta; content: Buffer }> {
    const path = `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
    const metadata = await this.request<GraphAttachment>(
      options.maxBytes === undefined ? path : `${path}?$select=${ATTACHMENT_METADATA_SELECT}`,
    );
    const meta = parseGraphAttachment(metadata);
    if (!meta) throw new EmailError('not_found', `Attachment ${attachmentId} not found on message ${messageId}`);
    if (metadata['@odata.type'] && metadata['@odata.type'] !== '#microsoft.graph.fileAttachment') {
      throw new EmailError('unsupported_capability', 'Only Outlook file attachments can be downloaded');
    }
    let content: Buffer;
    if (options.maxBytes === undefined) {
      if (metadata.contentBytes == null) throw invalidResponseError('Microsoft Graph returned no attachment data');
      content = Buffer.from(metadata.contentBytes, 'base64');
    } else {
      content = await this.request<Buffer>(`${path}/$value`, {}, { attachmentMaxBytes: options.maxBytes });
    }
    assertAttachmentSize(content.length, options.maxBytes);
    meta.sizeBytes = content.length;
    return { meta, content };
  }
}
