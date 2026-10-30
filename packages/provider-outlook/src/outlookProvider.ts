import {
  EmailError,
  invalidResponseError,
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
    // Wait for every lookup before failing, so no request outlives this call.
    const folderResults = await Promise.allSettled(
      WELL_KNOWN_FOLDERS.map(async (known) => {
        try {
          const raw = await this.request<GraphFolder>(`/me/mailFolders/${known.id}?$select=id`, {}, { signal });
          if (raw.id) roleById.set(raw.id, known.role);
        } catch (error) {
          if (!(error instanceof EmailError) || error.code !== 'not_found' || known.role !== 'archive') throw error;
        }
      }),
    );
    const rejectedFolder = folderResults.find((result) => result.status === 'rejected');
    if (rejectedFolder) throw rejectedFolder.reason;

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
      if (!category.id || !category.displayName) return [];
      return [
        {
          id: category.id,
          name: category.displayName,
          ...(category.color ? { color: { preset: category.color } } : {}),
        },
      ];
    });
  }

  private async resolveCategoryNames(values: string[]): Promise<string[]> {
    const categories = await this.listLabels();
    const resolved = values.flatMap((value) => {
      const normalized = value.toLowerCase();
      const category = categories.find(
        (candidate) => candidate.id === value || candidate.name.toLowerCase() === normalized,
      );
      return [category?.name ?? value];
    });
    const seen = new Set<string>();
    return resolved.filter((name) => {
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  private async resolveFolder(value: string, signal?: AbortSignal): Promise<Folder> {
    const normalized = value.toLowerCase();
    const folders = await this.folderSnapshot(false, signal);
    const wellKnownRole = WELL_KNOWN_FOLDERS.find((folder) => folder.id === normalized)?.role;
    const role = folders.byRole.get(wellKnownRole ?? (normalized as FolderRole));
    const match =
      role ?? folders.byId.get(value) ?? folders.folders.find((folder) => folder.name.toLowerCase() === normalized);
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
      const requestedNames = new Set(resolved.map((label) => label.toLowerCase()));
      await forEachLimited(ids, MESSAGE_CONCURRENCY, async (id) => {
        const message = await this.request<GraphMessage>(
          `/me/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: 'categories' })}`,
        );
        const current = message.categories ?? [];
        const categories = adding
          ? [
              ...current,
              ...resolved.filter((label) => !current.some((item) => item.toLowerCase() === label.toLowerCase())),
            ]
          : current.filter((label) => !requestedNames.has(label.toLowerCase()));
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
