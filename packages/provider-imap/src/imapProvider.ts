import { createHash, randomBytes } from 'node:crypto';
import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type ListResponse,
  type MessageEnvelopeObject,
  type MessageStructureObject,
  type SearchObject,
} from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import PostalMime, { type Address as PostalAddress } from 'postal-mime';
import {
  EmailError,
  findByFolderName,
  FolderDeleteRefusedError,
  folderHasMessages,
  folderHasSubfolders,
  FolderNameError,
  FolderNotFoundError,
  folderPathLevels,
  isFolderRoleName,
  newFolderName,
  systemFolderNotDeletable,
  normalizeEmailQuery,
  replySubject,
  type AttachmentMeta,
  type Capabilities,
  type DraftInput,
  type EmailAddress,
  type EmailProvider,
  type EmailQuery,
  type FailurePhase,
  type Folder,
  type FolderRole,
  type GetAttachmentOpts,
  type GetMessageOpts,
  type Label,
  type Message,
  type ModifyAction,
  type MessageSearchPage,
  type PageOpts,
  type SearchDiagnostic,
  type SendResult,
  type Thread,
  withoutTrailingLineBreaks,
} from '@fluxmail/core';
import {
  changedMidReadError,
  decodePartTransfer,
  downloadBody,
  downloadListBody,
  downloadPart,
  downloadSnippets,
  encodedLimit,
  inspectStructure,
  isChangedMidRead,
  isGone,
  misreportedPartHeader,
} from './body.js';
import { isDroppedConnection, mapImapError, watchConnectionErrors } from './errors.js';
import { findMailboxPath, newFolderRoleConflict, resolveFolders, samePath, type ResolvedFolders } from './folders.js';
import { composeMessage, stripBccHeader, type ThreadingHeaders } from './mime.js';
import { toImapSearches } from './query.js';
import type { FolderWarning, ImapCredentials, ImapMessageLocation, ImapStateStore } from './types.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
export const POSTAL_OPTIONS = { maxNestingDepth: 100, maxHeadersSize: 2 * 1024 * 1024 } as const;

const IMAP_LITERAL_BYTES = 256 * 1024 * 1024;
const IMAP_LINE_BYTES = 64 * 1024 * 1024;
/**
 * Size limits for each IMAP connection. imapflow buffers a whole literal, line or response before
 * the provider sees it, and defaults to 1 GiB per literal and 2 GiB per response, so a broken or
 * hostile server could make the process hold gigabytes. A literal fits a whole message well above
 * what mail servers accept, because sending a draft and reading a message without a body
 * structure fetch the full source. A line fits an unranged SEARCH reply for millions of messages.
 * imapflow counts line bytes toward the response, so the response limit exceeds both.
 */
export const IMAP_PARSER_LIMITS = {
  maxLiteralSize: IMAP_LITERAL_BYTES,
  maxLineLength: IMAP_LINE_BYTES,
  maxResponseSize: Math.max(IMAP_LITERAL_BYTES, IMAP_LINE_BYTES) + 1024 * 1024,
} as const;
const HEADER_NAMES = ['Message-ID', 'References', 'In-Reply-To'];
/** Reads of a message that changes mid-read, such as a draft another mail app keeps saving. */
const CHANGED_MID_READ_ATTEMPTS = 3;
const LIST_FETCH = { envelope: true, flags: true, internalDate: true, bodyStructure: true, headers: HEADER_NAMES };
// Date and attachment filters are applied after the fetch, so a page may need
// many candidates. Fetch them in batches this size.
const FILTERED_FETCH_BATCH = 50;
// With a soft deadline, a page's first fetch takes at most this many candidates.
// The deadline is checked only between fetches, so later fetches are sized to
// finish by it at the pace of the ones before.
const DEADLINE_FIRST_FETCH_BATCH = 20;
// Thread expansion searches each folder for this many message IDs at once. Each
// ID adds three header criteria, which keeps the command under common IMAP line
// limits.
const THREAD_SEARCH_BATCH = 10;

function findStructurePart(
  structure: MessageStructureObject | undefined,
  partId: string,
): MessageStructureObject | undefined {
  if (!structure) return undefined;
  const visit = (node: MessageStructureObject): MessageStructureObject | undefined => {
    const part = node.part ?? (node === structure && !node.childNodes?.length ? '1' : undefined);
    if (part === partId) return node;
    for (const child of node.childNodes ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(structure);
}

function isDecodedBodyStructureSize(node: MessageStructureObject | undefined): boolean {
  const encoding = node?.encoding?.toLowerCase();
  return encoding === '7bit' || encoding === '8bit' || encoding === 'binary';
}

// postal-mime returns the Content-Disposition token as written. Like a part read from the body
// structure, anything other than inline counts as an attachment.
function attachmentDisposition(disposition: string | null | undefined): Pick<AttachmentMeta, 'disposition'> {
  if (!disposition) return {};
  return { disposition: disposition.toLowerCase() === 'inline' ? 'inline' : 'attachment' };
}

function assertAttachmentSize(sizeBytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && sizeBytes > maxBytes) {
    throw new EmailError('invalid_request', 'Attachment is too large to return through MCP.', {
      sizeBytes,
      maxBytes,
    });
  }
}

export const IMAP_CAPABILITIES: Capabilities = {
  labels: false,
  serverThreads: false,
  serverSearch: 'basic',
  search: {
    filters: ['folder', 'text', 'from', 'to', 'subject', 'read', 'starred', 'hasAttachment', 'after', 'before'],
    folderRoles: {
      inbox: 'unknown',
      sent: 'unknown',
      drafts: 'unknown',
      archive: 'unknown',
      spam: 'unknown',
      trash: 'unknown',
      all: 'unknown',
    },
    nativeQuery: { syntax: 'gmail', availability: 'unknown' },
  },
  snippets: false,
  searchContext: true,
};

export interface ImapProviderOptions {
  accountId: string;
  email: string;
  displayName?: string;
  credentials: ImapCredentials;
  store: ImapStateStore;
  imapFactory?: (options: ImapFlowOptions) => ImapFlow;
  smtpFactory?: (credentials: ImapCredentials['smtp']) => Transporter;
  resolveSender?: (email: string) => EmailAddress | undefined;
}

interface ParsedHeaders {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  selected?: Record<string, string>;
}

interface Cursor {
  v: 2 | 3;
  hash: string;
  folder: number;
  upperUid?: number;
  mailbox?: string;
  uidValidity?: string;
}

function parseHeaders(raw: Buffer | undefined, includeSelected = false): ParsedHeaders {
  const unfolded = (raw?.toString('utf8') ?? '').replace(/\r?\n[ \t]+/g, ' ');
  const selected: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (includeSelected) selected[name] = value;
  }
  const get = (name: string) => {
    const match = Object.entries(selected).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match) return match[1];
    const regex = new RegExp(`^${name}:\\s*(.*)$`, 'im');
    return unfolded.match(regex)?.[1]?.trim();
  };
  return {
    ...(get('Message-ID') ? { messageId: get('Message-ID') } : {}),
    ...(get('In-Reply-To') ? { inReplyTo: get('In-Reply-To') } : {}),
    references: get('References')?.match(/<[^>]+>/g) ?? [],
    ...(includeSelected ? { selected } : {}),
  };
}

function threadId(headers: ParsedHeaders, fallback: string): string {
  const root = headers.references[0] ?? headers.inReplyTo ?? headers.messageId ?? fallback;
  return `ith_${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24)}`;
}

function locationId(prefix: 'im' | 'draft', accountId: string, path: string, uidValidity: string, uid: number): string {
  const value = `${accountId}\0${path}\0${uidValidity}\0${uid}`;
  return `${prefix}_${createHash('sha256').update(value).digest('base64url').slice(0, 18)}`;
}

function addresses(values: MessageEnvelopeObject['from']): EmailAddress[] {
  return (values ?? []).flatMap((value) =>
    value.address ? [{ ...(value.name ? { name: value.name } : {}), email: value.address }] : [],
  );
}

function postalAddresses(values: PostalAddress[] | PostalAddress | undefined): EmailAddress[] {
  return (Array.isArray(values) ? values : values ? [values] : []).flatMap((value) => {
    if ('group' in value && value.group) {
      return value.group.map((entry) => ({ ...(entry.name ? { name: entry.name } : {}), email: entry.address }));
    }
    return value.address ? [{ ...(value.name ? { name: value.name } : {}), email: value.address }] : [];
  });
}

function cursorHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** The page token doesn't fit the query or the folders it is used with. */
class PageTokenError extends EmailError {}

function decodeCursor(value: string | undefined, hash: string): Cursor {
  if (!value) return { v: 3, hash, folder: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (
      (parsed.v !== 2 && parsed.v !== 3) ||
      parsed.hash !== hash ||
      !Number.isInteger(parsed.folder) ||
      parsed.folder < 0 ||
      (parsed.upperUid !== undefined && (!Number.isInteger(parsed.upperUid) || parsed.upperUid < 1)) ||
      (parsed.mailbox !== undefined && typeof parsed.mailbox !== 'string') ||
      (parsed.uidValidity !== undefined && typeof parsed.uidValidity !== 'string') ||
      (parsed.v === 3 && parsed.upperUid !== undefined && (!parsed.mailbox || !parsed.uidValidity))
    ) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new PageTokenError('invalid_request', 'Invalid or expired IMAP page token');
  }
}

function recipients(input: DraftInput): string[] {
  return [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])].map((value) => value.email);
}

/** Response codes for a CREATE the server can't do right now, rather than one it won't do with this name. */
const TEMPORARY_CREATE_CODES = new Set([
  'LIMIT',
  'OVERQUOTA',
  'UNAVAILABLE',
  'SERVERBUG',
  'INUSE',
  'CONTACTADMIN',
  'THROTTLED',
]);

/**
 * The error for a server's NO or BAD reply to CREATE. The message leaves out the server's text, so it can reach
 * the caller; the RFC 5530 code, when there is one, is a fixed word. A reply without a code doesn't say whether
 * the name or a server limit is the reason, so the message names both.
 */
function createRefusal(error: unknown, path: string): EmailError {
  const mapped = mapImapError(error, 'folders');
  const code = (error as { serverResponseCode?: string }).serverResponseCode;
  if (code && TEMPORARY_CREATE_CODES.has(code)) return mapped;
  if (code === 'NOPERM') {
    return new EmailError(
      'permission_denied',
      `The mail server does not allow creating the folder "${path}".`,
      undefined,
      mapped.failure,
    );
  }
  const reply = code && /^[A-Z][A-Z0-9-]{0,31}$/.test(code) ? ` (${code})` : '';
  return new FolderNameError(
    `The mail server would not create the folder "${path}"${reply}. The server may not allow the name, or may have reached a folder limit. Try a different name once; if that also fails, the limit is the likely cause.`,
    mapped.failure,
  );
}

/**
 * The error for a failed STATUS or DELETE while deleting a folder. A NO or BAD reply gets a message Fluxmail wrote,
 * without the server's text; temporary response codes, and failures without a reply, keep the usual mapping.
 */
function deleteRefusal(error: unknown, path: string): EmailError {
  // imapflow's STATUS reports a mailbox that no longer exists with its own error, not the server's reply.
  if ((error as { code?: string } | undefined)?.code === 'NotFound') return new FolderNotFoundError(path);
  const mapped = mapImapError(error, 'folders');
  if (!(error as { responseStatus?: string } | undefined)?.responseStatus) return mapped;
  const code = (error as { serverResponseCode?: string }).serverResponseCode;
  if (code && TEMPORARY_CREATE_CODES.has(code)) return mapped;
  if (code === 'NOPERM') {
    return new FolderNameError(
      `The mail server does not allow deleting the folder "${path}".`,
      mapped.failure,
      'permission_denied',
    );
  }
  if (code === 'NONEXISTENT') return new FolderNotFoundError(path);
  if (code === 'HASCHILDREN') return folderHasSubfolders(path);
  const reply = code && /^[A-Z][A-Z0-9-]{0,31}$/.test(code) ? ` (${code})` : '';
  return new FolderDeleteRefusedError(`The mail server would not delete the folder "${path}"${reply}.`, mapped.failure);
}

/** Fails unless STATUS reports that the mailbox at `path` is empty. */
async function requireNoMessages(client: ImapFlow, path: string): Promise<void> {
  let status: Awaited<ReturnType<ImapFlow['status']>> | false;
  try {
    status = await client.status(path, { messages: true });
  } catch (error) {
    throw deleteRefusal(error, path);
  }
  // Without a count, the folder can't be shown to be empty, so it stays. imapflow answers false both for a
  // dropped connection and for a server that refuses STATUS, such as one that lets the user list the folder but
  // not read it.
  if (!status) {
    if (!client.usable) throw connectionClosed();
    throw new FolderDeleteRefusedError(
      `The mail server would not count the messages in "${path}", so the folder was not deleted. This account may not be allowed to read it.`,
    );
  }
  if (typeof status.messages !== 'number') {
    throw new EmailError(
      'provider_unavailable',
      `The mail server did not say how many messages "${path}" has, so the folder was not deleted.`,
      undefined,
      { provider: 'imap', phase: 'folders', reason: 'invalid_response' },
    );
  }
  if (status.messages > 0) throw folderHasMessages(path, status.messages);
}

/** imapflow sends nothing, and reports nothing, on a connection that is no longer signed in. */
function connectionClosed(): EmailError {
  return new EmailError(
    'provider_unavailable',
    'The IMAP connection closed before the folder was deleted.',
    undefined,
    {
      provider: 'imap',
      phase: 'folders',
      reason: 'connection_reset',
    },
  );
}

async function deleteMailbox(client: ImapFlow, path: string): Promise<void> {
  let result: Awaited<ReturnType<ImapFlow['mailboxDelete']>> | undefined;
  try {
    result = await client.mailboxDelete(path);
  } catch (error) {
    throw deleteRefusal(error, path);
  }
  if (!result) throw connectionClosed();
}

/** A name with the namespace prefix the server keeps folders under. INBOX in the prefix matches in any case. */
function withNamespacePrefix(name: string, prefix: string | undefined): string {
  if (!prefix || name.startsWith(prefix)) return name;
  const inbox = /^inbox/i.test(prefix) && name.slice(0, prefix.length).toUpperCase() === prefix.toUpperCase();
  return inbox ? `${prefix}${name.slice(prefix.length)}` : `${prefix}${name}`;
}

/** Whether the server lists a mailbox as one that can't have folders inside it. */
function holdsNoFolders(folders: ResolvedFolders, path: string): boolean {
  const entry = folders.listing.find((candidate) => candidate.path === path);
  return Boolean(entry && [...entry.flags].some((flag) => flag.toLowerCase() === '\\noinferiors'));
}

function noFoldersInside(path: string): FolderNameError {
  return new FolderNameError(`The mail server doesn't allow folders inside "${path}". Choose another parent folder.`);
}

/** Run one IMAP step, recording it as the failure phase if it throws. */
async function imapStep<T>(phase: FailurePhase, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapImapError(error, phase);
  }
}

/**
 * Run a server-side search, resolving undefined if it is still running at the
 * deadline. The caller must close the connection after an abandoned search.
 */
async function searchUntil(client: ImapFlow, search: SearchObject, deadlineAt: number): Promise<number[] | undefined> {
  const pending = client.search(search, { uid: true });
  pending.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending.then((matches) => matches || []),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, deadlineAt - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settle with the promise, or reject with the signal's reason once it aborts.
 * Closing a connecting ImapFlow client doesn't settle its connect().
 */
function untilAborted<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(value);
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** UIDs in a folder's first search range, and the limits on later ranges. */
const SEARCH_WINDOW_UIDS = 2_000;
const SEARCH_WINDOW_MIN_UIDS = 250;
const SEARCH_WINDOW_MAX_UIDS = 32_000;
/**
 * A range grows fourfold after an answer faster than a quarter of this, and
 * halves after one slower than this.
 */
const SEARCH_WINDOW_TARGET_MS = 2_000;
/**
 * How long to wait before connecting again after the server closed a new
 * connection. A server at its connection limit often accepts one once another
 * command finishes.
 */
const RECONNECT_DELAY_MS = 1_000;

const reconnectDelay = () => new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));

/**
 * How long a connection's folder listing serves its later searches and flag
 * changes. Listing folders takes the server two commands, and a search only
 * needs it to turn a folder name or role into a path.
 */
const FOLDER_LISTING_MS = 60_000;
const FOLDER_LISTING = Symbol('fluxmail.folderListing');
type ListingClient = ImapFlow & { [FOLDER_LISTING]?: { listing: ListResponse[]; at: number } };
/**
 * When each account last created or deleted a folder here, so its other
 * connections list their folders again instead of using an older listing.
 */
const folderChanges = new Map<string, number>();

function noteFolderChange(accountId: string): void {
  const now = Date.now();
  for (const [id, at] of folderChanges) if (now - at >= FOLDER_LISTING_MS) folderChanges.delete(id);
  folderChanges.set(accountId, now);
}

/**
 * The errors a folder listing that no longer matches the server can cause: an
 * unknown name, a refused SELECT, or a page token issued for other folders.
 */
function staleListing(error: unknown): boolean {
  if (!(error instanceof EmailError)) return false;
  return (
    error.code === 'not_found' ||
    error instanceof PageTokenError ||
    (error.failure?.phase === 'select' && error.failure.reason === 'server_no')
  );
}

/** close() ended this connection while it was opening. */
class ClosedDuringSetupError extends EmailError {}

/**
 * Search a folder newest first, one UID range at a time, until enough
 * candidates are found, the deadline passes or the folder is done. A server
 * that reads every message for a search then still answers within the
 * deadline. upperUid is the highest UID left unsearched. With raceDeadline,
 * a range still running at the deadline is abandoned, and the caller must
 * close the connection. With openTop, topUid is the folder's highest UID as
 * of when the connection opened it, and the first range also covers mail
 * delivered since.
 */
async function searchWindows(
  client: ImapFlow,
  searches: SearchObject[],
  topUid: number,
  deadlineAt: number,
  wanted: number,
  raceDeadline: boolean,
  openTop: boolean,
  signal?: AbortSignal,
): Promise<{ uids: number[]; upperUid?: number; timedOut?: boolean; abandoned?: boolean }> {
  const uids: number[] = [];
  let span = SEARCH_WINDOW_UIDS;
  let upper = topUid;
  let open = openTop;
  while (upper >= 1) {
    signal?.throwIfAborted();
    const lower = Math.max(1, upper - span + 1);
    const started = Date.now();
    let matches: number[] | undefined;
    for (const search of searches) {
      const ranged = { ...search, uid: `${lower}:${open ? '*' : upper}` };
      const answer = await imapStep('search', async () =>
        raceDeadline ? searchUntil(client, ranged, deadlineAt) : (await client.search(ranged, { uid: true })) || [],
      );
      if (answer === undefined) return { uids, abandoned: true };
      // A range ending in * always includes the folder's last message, even one below the range.
      const range = open ? answer.filter((uid) => uid >= lower) : answer;
      const inRange = new Set(range);
      matches = matches === undefined ? range : matches.filter((uid) => inRange.has(uid));
      if (!matches.length) break;
    }
    // A range can match more UIDs than a spread argument list allows.
    for (const uid of matches ?? []) uids.push(uid);
    upper = lower - 1;
    open = false;
    if (upper < 1) break;
    if (uids.length >= wanted) return { uids, upperUid: upper };
    if (Date.now() >= deadlineAt) return { uids, upperUid: upper, timedOut: true };
    const elapsed = Date.now() - started;
    if (elapsed < SEARCH_WINDOW_TARGET_MS / 4) span = Math.min(SEARCH_WINDOW_MAX_UIDS, span * 4);
    else if (elapsed > SEARCH_WINDOW_TARGET_MS) span = Math.max(SEARCH_WINDOW_MIN_UIDS, Math.floor(span / 2));
  }
  return { uids };
}

function isoDate(value: Date | string | undefined): string {
  const parsed = new Date(value ?? Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function smtpTransportOptions(config: ImapCredentials['smtp']) {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    auth: { user: config.user, pass: config.password },
    // Nodemailer waits 30 seconds for a greeting by default, as long as the
    // whole setup check. Fail sooner so a security mode mismatch is reported.
    greetingTimeout: 10_000,
  };
}

export class ImapProvider implements EmailProvider {
  private imap?: ImapFlow;
  private connectingImap?: ImapFlow;
  private imapConnection?: Promise<ImapFlow>;
  private smtp?: Transporter;
  private resolved?: ResolvedFolders;
  /** Counts close() calls, so a reconnect that waited doesn't reopen a closed provider. */
  private closes = 0;

  constructor(private readonly options: ImapProviderOptions) {}

  get capabilities(): Capabilities {
    const folders = this.resolved;
    const gmailRaw = this.imap?.capabilities.has('X-GM-EXT-1');
    return {
      ...IMAP_CAPABILITIES,
      search: {
        ...IMAP_CAPABILITIES.search,
        folderRoles: {
          inbox: folders ? (folders.paths.inbox ? 'available' : 'unavailable') : 'unknown',
          sent: folders ? (folders.paths.sent ? 'available' : 'unavailable') : 'unknown',
          drafts: folders ? (folders.paths.drafts ? 'available' : 'unavailable') : 'unknown',
          archive: folders ? (folders.paths.archive ? 'available' : 'unavailable') : 'unknown',
          spam: folders ? (folders.paths.spam ? 'available' : 'unavailable') : 'unknown',
          trash: folders ? (folders.paths.trash ? 'available' : 'unavailable') : 'unknown',
          all: folders ? (this.allMailPaths(folders).length ? 'available' : 'unavailable') : 'unknown',
        },
        nativeQuery: {
          syntax: 'gmail',
          availability: gmailRaw === undefined ? 'unknown' : gmailRaw ? 'available' : 'unavailable',
          ...(!gmailRaw && gmailRaw !== undefined
            ? { unavailableReason: 'The IMAP server does not advertise X-GM-EXT-1.' }
            : {}),
        },
      },
    };
  }

  async close(): Promise<void> {
    const imap = this.imap;
    const connecting = this.connectingImap;
    this.imap = undefined;
    this.connectingImap = undefined;
    this.imapConnection = undefined;
    this.resolved = undefined;
    this.closes += 1;
    if (connecting && connecting !== imap) connecting.close();
    if (imap && imap !== connecting) imap.close();
    this.smtp?.close();
    this.smtp = undefined;
  }

  private imapOptions(): ImapFlowOptions {
    const config = this.options.credentials.imap;
    return {
      host: config.host,
      port: config.port,
      secure: config.security === 'tls',
      ...(config.security === 'starttls' ? { doSTARTTLS: true } : {}),
      auth: { user: config.user, pass: config.password },
      logger: false,
      clientInfo: { name: 'Fluxmail' },
      ...IMAP_PARSER_LIMITS,
    };
  }

  private buildSmtp(): Transporter {
    if (this.options.smtpFactory) return this.options.smtpFactory(this.options.credentials.smtp);
    return nodemailer.createTransport(smtpTransportOptions(this.options.credentials.smtp));
  }

  private async client(): Promise<ImapFlow> {
    if (this.imap?.usable) return this.imap;
    this.imapConnection ??= (async () => {
      const closes = this.closes;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            return await this.connect();
          } catch (error) {
            if (attempt > 0 || error instanceof ClosedDuringSetupError || !isDroppedConnection(error)) throw error;
            await reconnectDelay();
            if (this.closes !== closes) throw error;
          }
        }
      } finally {
        this.imapConnection = undefined;
      }
    })();
    return this.imapConnection;
  }

  private newClient(): ImapFlow {
    const client = this.options.imapFactory?.(this.imapOptions()) ?? new ImapFlow(this.imapOptions());
    watchConnectionErrors(client);
    return client;
  }

  private async connect(): Promise<ImapFlow> {
    const client = this.newClient();
    this.connectingImap = client;
    try {
      await client.connect();
      if (this.connectingImap !== client) {
        client.close();
        throw new ClosedDuringSetupError(
          'provider_unavailable',
          'The IMAP connection was closed during setup.',
          undefined,
          { reason: 'connection_reset' },
        );
      }
      this.imap = client;
      return client;
    } catch (error) {
      client.close();
      throw mapImapError(error, 'connect');
    } finally {
      if (this.connectingImap === client) this.connectingImap = undefined;
    }
  }

  /**
   * Resolve folder roles. Unread counts are only requested by listFolders: a
   * server without LIST-STATUS answers them with one STATUS command per folder,
   * which would spend the search deadline before the search starts.
   */
  private async refreshFolders(clientOverride?: ImapFlow, unreadCounts = false): Promise<ResolvedFolders> {
    const closes = this.closes;
    for (let attempt = 0; ; attempt++) {
      let client: ImapFlow | undefined;
      try {
        client = clientOverride ?? (await this.client());
        const listing = await client.list(unreadCounts ? { statusQuery: { unseen: true } } : {});
        (client as ListingClient)[FOLDER_LISTING] = { listing, at: Date.now() };
        this.resolved = resolveFolders(listing, this.options.credentials.folderOverrides);
        return this.resolved;
      } catch (error) {
        const mapped = mapImapError(error, 'folders');
        // LIST changes nothing, so a connection the server dropped is replaced once.
        // Callers supplying a client own its lifetime.
        if (client && !clientOverride && attempt === 0 && this.closes === closes && isDroppedConnection(mapped)) {
          if (this.imap === client) this.imap = undefined;
          client.close();
          continue;
        }
        throw mapped;
      }
    }
  }

  /**
   * Folder roles from the listing the connection took in the last minute, when
   * it has one. Only for calls that can run again or that name no folder: with
   * reused, a search lists the folders again after staleListing errors.
   */
  private async recentFolders(clientOverride?: ImapFlow): Promise<{ folders: ResolvedFolders; reused: boolean }> {
    const client: ListingClient = clientOverride ?? (await this.client());
    const kept = client[FOLDER_LISTING];
    const changed = folderChanges.get(this.options.accountId) ?? 0;
    if (kept && kept.at > changed && Date.now() - kept.at < FOLDER_LISTING_MS) {
      this.resolved = resolveFolders(kept.listing, this.options.credentials.folderOverrides);
      return { folders: this.resolved, reused: true };
    }
    return { folders: await this.refreshFolders(clientOverride), reused: false };
  }

  async getFolderWarnings(): Promise<FolderWarning[]> {
    return (await this.refreshFolders()).warnings;
  }

  async testConnection(): Promise<void> {
    await this.refreshFolders();
    try {
      this.smtp ??= this.buildSmtp();
      await this.smtp.verify();
    } catch (error) {
      throw mapImapError(error, 'smtp');
    }
  }

  async listFolders(): Promise<Folder[]> {
    return (await this.refreshFolders(undefined, true)).folders;
  }

  /**
   * Creates a mailbox and any missing parents. Levels of the name are split at the server's own hierarchy
   * separator, as folder names list them, and a server that keeps folders under a namespace prefix such as
   * "INBOX." gets that prefix added when the name lacks it. An existing folder is returned unchanged.
   */
  async createFolder(name: string): Promise<Folder> {
    try {
      return await this.createListedFolder(name);
    } finally {
      noteFolderChange(this.options.accountId);
    }
  }

  private async createListedFolder(name: string): Promise<Folder> {
    const requested = newFolderName(name);
    let folders = await this.refreshFolders();
    const existing = this.existingFolder(folders, requested);
    if (existing) return existing;
    if (/[%*]/.test(requested)) {
      throw new FolderNameError('IMAP folder names cannot contain % or *.');
    }
    const client = await this.client();
    const delimiter = folders.delimiter ?? client.namespace?.delimiter ?? undefined;
    folderPathLevels(requested, delimiter);
    // imapflow adds the namespace prefix the same way to every path it sends.
    const prefix = client.namespace?.prefix;
    const levels = folderPathLevels(withNamespacePrefix(requested, prefix), delimiter);
    const target = levels.join(delimiter ?? '');
    if (target !== requested) {
      const listed = this.existingFolder(folders, target);
      if (listed) return listed;
    }
    // Every level that doesn't exist yet is created, parents first. A level under an existing parent uses the
    // parent's listed spelling, so a name typed in another Unicode form doesn't create a second parent.
    const missing: string[] = [];
    let path = '';
    for (let depth = 1; depth <= levels.length; depth++) {
      path = depth === 1 ? levels[0]! : `${path}${delimiter}${levels[depth - 1]}`;
      if (depth < levels.length) {
        // The namespace prefix is where folders live, not a folder to create; imapflow would prefix it again.
        if (prefix && delimiter && prefix.startsWith(`${path}${delimiter}`)) continue;
        const listed = this.listedMailbox(folders, path, true);
        if (listed) {
          if (holdsNoFolders(folders, listed)) throw noFoldersInside(listed);
          path = listed;
          continue;
        }
        if (isFolderRoleName(path)) throw new FolderNameError(`"${path}" is a system folder. Choose another name.`);
      }
      missing.push(path);
    }
    const conflict = newFolderRoleConflict(folders, missing, this.options.credentials.folderOverrides);
    if (conflict) throw new FolderNameError(conflict);
    let created = target;
    for (let index = 0; index < missing.length; index++) {
      const wanted = missing[index]!;
      let actual: string;
      try {
        // A refused level re-lists the folders, which can replace a dropped connection.
        const result = await (await this.client()).mailboxCreate(wanted);
        // imapflow sends nothing, and reports nothing, on a connection that is no longer signed in.
        if (!result) {
          throw new EmailError(
            'provider_unavailable',
            'The IMAP connection closed before the folder was created.',
            undefined,
            { provider: 'imap', phase: 'folders', reason: 'connection_reset' },
          );
        }
        actual = result.path ?? wanted;
      } catch (error) {
        if (error instanceof EmailError) throw error;
        // Only a NO or BAD reply refuses the name; anything else, such as a dropped connection, is mapped as usual.
        if (!(error as { responseStatus?: string } | undefined)?.responseStatus) throw mapImapError(error, 'folders');
        folders = await this.refreshFolders();
        // Many servers refuse an existing name with a plain NO rather than ALREADYEXISTS, and ones that ignore
        // case refuse a name that differs only in case. A reply with another code is about something else.
        const code = (error as { serverResponseCode?: string }).serverResponseCode;
        const listed = this.listedMailbox(folders, wanted, Boolean(code) && code !== 'ALREADYEXISTS');
        if (!listed) {
          const parent = delimiter ? wanted.slice(0, Math.max(wanted.lastIndexOf(delimiter), 0)) : '';
          throw parent && holdsNoFolders(folders, parent) ? noFoldersInside(parent) : createRefusal(error, wanted);
        }
        actual = listed;
      }
      // Later levels go under the spelling the server lists.
      if (actual !== wanted) {
        for (let later = index + 1; later < missing.length; later++) {
          missing[later] = `${actual}${missing[later]!.slice(wanted.length)}`;
        }
      }
      created = actual;
    }
    folders = await this.refreshFolders();
    const listed = this.listedMailbox(folders, created);
    // A folder that a configured override names now holds its role, and is still the folder that was asked for.
    const folder = folders.folders.find((candidate) => candidate.id === listed);
    if (folder) return folder;
    throw new EmailError(
      'provider_unavailable',
      `The mail server accepted the folder "${created}" but does not list it.`,
      undefined,
      { provider: 'imap', phase: 'folders', reason: 'invalid_response' },
    );
  }

  /**
   * The folder a name already refers to. A mailbox that can't hold messages is rejected, and so is a role folder,
   * unless a configured override gave it the role: that folder is an ordinary one the user chose by name.
   */
  private existingFolder(folders: ResolvedFolders, name: string): Folder | undefined {
    const path = findMailboxPath(folders.selectablePaths, name);
    if (path) {
      const folder = folders.folders.find((candidate) => candidate.id === path)!;
      if (folder.role && folder.roleSource !== 'user') {
        throw new FolderNameError(`"${path}" is the ${folder.role} folder. Choose another name.`);
      }
      return folder;
    }
    const listed = findMailboxPath(folders.listedPaths, name);
    if (listed) throw new FolderNameError(`A folder named "${listed}" exists but can't hold messages.`);
    return undefined;
  }

  /**
   * The listed path for a mailbox, ignoring case only when no exact spelling exists. With `exact`, only the
   * spelling counts, except for INBOX, whose name never depends on case.
   */
  private listedMailbox(folders: ResolvedFolders, path: string, exact = false): string | undefined {
    const listed = findMailboxPath(folders.listedPaths, path);
    if (listed || (exact && path.toUpperCase() !== 'INBOX')) return listed;
    return findByFolderName(folders.listedPaths, path, (item) => item, true);
  }

  /**
   * Deletes an empty mailbox. IMAP DELETE also destroys the messages in a mailbox, so the folders are listed
   * again, the mailbox's messages are counted with STATUS, and DELETE follows. IMAP has no command that deletes
   * a mailbox only if it is empty, so a message another mail app or a server filter files there between STATUS
   * and DELETE is lost with the mailbox.
   */
  async deleteFolder(folder: string): Promise<Folder> {
    try {
      return await this.deleteListedFolder(folder);
    } finally {
      noteFolderChange(this.options.accountId);
    }
  }

  private async deleteListedFolder(folder: string): Promise<Folder> {
    const requested = folder.trim();
    if (!requested) throw new FolderNameError('The folder name is empty.');
    const folders = await this.refreshFolders();
    const client = await this.client();
    const prefix = client.namespace?.prefix;
    // A folder is named by its path, which is also its ID, or, like move_emails, by a role word. A \Noselect
    // parent is listed too, and a name without the namespace prefix finds the folder create_folder made for it.
    // A listed path wins over a role word, so a leftover "Spam" folder beside a flagged Junk folder can be named.
    const listedPath = (name: string) =>
      findMailboxPath(folders.selectablePaths, name) ?? findMailboxPath(folders.listedPaths, name);
    const path =
      listedPath(requested) ??
      listedPath(withNamespacePrefix(requested, prefix)) ??
      (isFolderRoleName(requested) ? this.rolePath(requested.toLowerCase() as FolderRole, folders) : undefined);
    if (path === undefined && isFolderRoleName(requested)) throw systemFolderNotDeletable(requested);
    const entry = path === undefined ? undefined : folders.listing.find((candidate) => candidate.path === path);
    if (path === undefined || !entry) throw new FolderNotFoundError(requested);
    const listed = folders.folders.find((candidate) => candidate.id === path);
    // resolveFolders applies an override only when it matches a selectable folder, so the setting is read too.
    const overrides = this.options.credentials.folderOverrides ?? {};
    const overrideRole =
      (Object.keys(overrides) as Array<keyof typeof overrides>).find((role) => {
        const target = overrides[role];
        return target !== undefined && samePath(target, path);
      }) ?? (listed?.roleSource === 'user' ? listed.role : undefined);
    if (overrideRole) {
      throw new FolderDeleteRefusedError(
        `"${path}" is set as this account's ${overrideRole} folder, so deleting it would break that setting. Choose another ${overrideRole} folder for the account first.`,
      );
    }
    // A special-use flag, reported or guessed from a localized name, marks a folder mail apps use for a role.
    if (/^inbox$/i.test(path) || listed?.role || entry.specialUse) throw systemFolderNotDeletable(path);
    const delimiter = entry.delimiter || folders.delimiter;
    const hasChildren =
      [...entry.flags].some((flag) => flag.toLowerCase() === '\\haschildren') ||
      (Boolean(delimiter) &&
        folders.listedPaths.some((candidate) => candidate !== path && candidate.startsWith(`${path}${delimiter}`)));
    if (hasChildren) throw folderHasSubfolders(path);
    // imapflow adds the namespace prefix to every path it sends, so a folder outside the personal namespace, such
    // as a shared one, would be counted and deleted under another name.
    if (prefix && !path.startsWith(prefix)) {
      throw new FolderDeleteRefusedError(
        `"${path}" is outside this account's own folders, so Fluxmail can't delete it.`,
      );
    }

    // A \Noselect mailbox holds no messages, and servers refuse STATUS on one.
    if (!entry.flags.has('\\Noselect')) await requireNoMessages(client, path);
    try {
      await deleteMailbox(client, path);
    } finally {
      // The listing no longer matches the server whether or not the delete went through. Listing again keeps
      // folder roles available to reads running at the same time.
      try {
        await this.refreshFolders();
      } catch {
        this.resolved = undefined;
      }
    }
    // imapflow subscribes to the mailboxes it creates, and DELETE leaves the subscription, which some mail apps
    // show as a folder that can't be opened. The folder is already gone, so a refusal here changes nothing.
    try {
      await client.mailboxUnsubscribe(path);
    } catch {
      // Ignored: the subscription only decides which folders mail apps show.
    }
    return listed ?? { id: path, name: path };
  }

  async listLabels(): Promise<Label[]> {
    throw new EmailError('unsupported_capability', 'IMAP accounts do not support labels');
  }

  private rolePath(role: FolderRole, folders: ResolvedFolders): string | undefined {
    // A requested name such as "constructor" must not read an inherited property as a role path.
    return Object.hasOwn(folders.paths, role) ? folders.paths[role] : undefined;
  }

  private allMailPaths(folders: ResolvedFolders): string[] {
    if (folders.paths.all) return [folders.paths.all];
    return folders.allMailPaths;
  }

  private requireRole(role: 'drafts' | 'sent' | 'trash' | 'archive'): string {
    const path = this.resolved?.paths[role];
    if (path) return path;
    throw new EmailError(
      'unsupported_capability',
      `This account has no resolved ${role} folder. Run "fluxmail accounts configure ${this.options.accountId} --${role}-folder <path>".`,
    );
  }

  /**
   * Opens a folder to act on stored UIDs. When the connection already had it
   * open, a NOOP first collects what other sessions changed since, such as a
   * draft another mail app deleted, because the server reports those changes
   * only between commands.
   */
  private withCurrentMailbox<T>(path: string, fn: (client: ImapFlow, uidValidity: string) => Promise<T>): Promise<T> {
    return this.withMailbox(path, fn, undefined, true);
  }

  private async withMailbox<T>(
    path: string,
    fn: (client: ImapFlow, uidValidity: string) => Promise<T>,
    clientOverride?: ImapFlow,
    refresh = false,
  ): Promise<T> {
    const closes = this.closes;
    for (let attempt = 0; ; attempt++) {
      const client = clientOverride ?? (await this.client());
      let lock;
      let selected = false;
      try {
        const opened = client.mailbox;
        lock = await imapStep('select', () => client.getMailboxLock(path));
        // imapflow skips SELECT for the folder that is already open.
        if (refresh && opened && client.mailbox === opened) await imapStep('select', () => client.noop());
        const uidValidity = client.mailbox && client.mailbox.uidValidity?.toString();
        if (!uidValidity) {
          throw new EmailError('provider_unavailable', `Mailbox ${path} has no UIDVALIDITY`, undefined, {
            phase: 'select',
            reason: 'invalid_response',
          });
        }
        selected = true;
        await this.options.store.invalidateMailbox(path, uidValidity);
        return await fn(client, uidValidity);
      } catch (error) {
        const mapped = mapImapError(error);
        // The failure may come from a folder that changed since the connection listed them.
        delete (client as ListingClient)[FOLDER_LISTING];
        // Reconnect only before any mailbox work runs. Callers supplying a
        // client own its lifetime and may still need it after this lock.
        if (
          !selected &&
          !clientOverride &&
          attempt === 0 &&
          // close() discarded this provider, so it must not open a connection.
          this.closes === closes &&
          mapped.code === 'provider_unavailable' &&
          mapped.failure?.phase === 'select' &&
          (mapped.failure.reason === 'invalid_response' || mapped.failure.reason === 'connection_reset')
        ) {
          if (this.imap === client) this.imap = undefined;
          client.close();
          continue;
        }
        throw mapped;
      } finally {
        lock?.release();
      }
    }
  }

  private async toMessage(
    client: ImapFlow,
    path: string,
    uidValidity: string,
    fetched: FetchMessageObject,
    options: {
      body?: boolean;
      snippet?: boolean;
      snippetDiagnostics?: SearchDiagnostic[];
      searchContextText?: string;
      searchContextDiagnostics?: SearchDiagnostic[];
      signal?: AbortSignal;
      includeHeaders?: boolean;
      draftId?: string;
      threadId?: string;
      /** The stored location, already looked up. null means none is stored. */
      existing?: ImapMessageLocation | null;
      /** Collects the location for a later batched save instead of saving it now. */
      pendingSaves?: ImapMessageLocation[];
    } = {},
  ): Promise<Message> {
    const envelope = fetched.envelope ?? {};
    const parsed = parseHeaders(fetched.headers, options.includeHeaders);
    const existing =
      options.existing === undefined
        ? await this.options.store.findByLocation(path, uidValidity, fetched.uid)
        : (options.existing ?? undefined);
    const role = this.resolved?.folders.find((folder) => folder.id === path)?.role;
    const resolvedDraftId =
      options.draftId ??
      existing?.draftId ??
      (role === 'drafts' ? locationId('draft', this.options.accountId, path, uidValidity, fetched.uid) : undefined);
    const fallback = `${path}:${uidValidity}:${fetched.uid}`;
    const location: ImapMessageLocation = {
      id: existing?.id ?? locationId('im', this.options.accountId, path, uidValidity, fetched.uid),
      accountId: this.options.accountId,
      mailboxPath: path,
      uidValidity,
      uid: fetched.uid,
      ...((parsed.messageId ?? envelope.messageId) ? { messageId: parsed.messageId ?? envelope.messageId } : {}),
      ...((parsed.inReplyTo ?? envelope.inReplyTo) ? { inReplyTo: parsed.inReplyTo ?? envelope.inReplyTo } : {}),
      ...(parsed.references.length ? { references: parsed.references } : {}),
      threadId: options.threadId ?? threadId(parsed, fallback),
      ...(resolvedDraftId ? { draftId: resolvedDraftId } : {}),
      subject: envelope.subject ?? '',
      date: isoDate(envelope.date ?? fetched.internalDate),
    };
    if (options.pendingSaves) options.pendingSaves.push(location);
    else await this.options.store.save(location);
    const flags = fetched.flags ?? new Set<string>();
    const parts = inspectStructure(fetched.bodyStructure);
    const message: Message = {
      id: location.id,
      threadId: location.threadId,
      accountId: this.options.accountId,
      ...(location.draftId ? { draftId: location.draftId } : {}),
      folder: { id: path, name: path, ...(role ? { role } : {}) },
      ...(addresses(envelope.from)[0] ? { from: addresses(envelope.from)[0] } : {}),
      to: addresses(envelope.to),
      ...(addresses(envelope.cc).length ? { cc: addresses(envelope.cc) } : {}),
      ...(addresses(envelope.bcc).length ? { bcc: addresses(envelope.bcc) } : {}),
      ...(addresses(envelope.replyTo).length ? { replyTo: addresses(envelope.replyTo) } : {}),
      subject: envelope.subject ?? '',
      date: location.date ?? new Date().toISOString(),
      flags: { read: flags.has('\\Seen'), starred: flags.has('\\Flagged'), draft: flags.has('\\Draft') },
      ...(fetched.bodyStructure ? { attachments: parts.attachments } : {}),
      ...(options.includeHeaders && parsed.selected ? { headers: parsed.selected } : {}),
    };
    if ((options.snippet || options.searchContextText) && fetched.bodyStructure) {
      try {
        const enrichment = await downloadListBody(client, fetched.uid, parts, {
          snippet: options.snippet ?? false,
          structure: fetched.bodyStructure,
          ...(options.searchContextText ? { searchContextText: options.searchContextText } : {}),
        });
        if (enrichment.snippet !== undefined) message.snippet = enrichment.snippet;
        if (enrichment.searchContext !== undefined) message.searchContext = enrichment.searchContext;
      } catch {
        options.signal?.throwIfAborted();
        if (options.snippet) {
          options.snippetDiagnostics?.push({
            code: 'snippet_unavailable',
            severity: 'warning',
            message: 'A message preview could not be loaded. Message metadata is still available.',
          });
        }
        if (options.searchContextText) {
          message.searchContext = { status: 'unavailable' };
          options.searchContextDiagnostics?.push({
            code: 'search_context_unavailable',
            severity: 'warning',
            message: 'Search context could not be loaded for a message. Message metadata is still available.',
          });
        }
      }
    }
    if (options.searchContextText && !fetched.bodyStructure) {
      message.searchContext = { status: 'unavailable' };
    }
    if (options.body) {
      if (fetched.bodyStructure) {
        message.body = await downloadBody(client, fetched.uid, parts, fetched.bodyStructure);
      } else if (fetched.source) {
        const parsedSource = await PostalMime.parse(fetched.source, POSTAL_OPTIONS);
        message.body = {
          ...(parsedSource.text !== undefined ? { text: withoutTrailingLineBreaks(parsedSource.text) } : {}),
          ...(parsedSource.html !== undefined ? { html: parsedSource.html } : {}),
        };
        message.attachments = parsedSource.attachments.map((attachment, index) => ({
          id: `raw-${index}`,
          filename: attachment.filename ?? 'attachment',
          mimeType: attachment.mimeType,
          sizeBytes:
            typeof attachment.content === 'string'
              ? Buffer.byteLength(attachment.content)
              : attachment.content.byteLength,
          ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, '') } : {}),
          ...attachmentDisposition(attachment.disposition),
        }));
      } else {
        message.body = {};
      }
    }
    return message;
  }

  async listMessages(query: EmailQuery, page?: PageOpts): Promise<MessageSearchPage> {
    if (!page?.signal) return this.listMessagesWithClient(query, page);
    const signal = page.signal;
    for (let attempt = 0; ; attempt++) {
      const client = this.newClient();
      const close = () => client.close();
      signal.addEventListener('abort', close, { once: true });
      let connected = false;
      try {
        signal.throwIfAborted();
        await imapStep('connect', () => untilAborted(client.connect(), signal));
        connected = true;
        signal.throwIfAborted();
        return await this.listMessagesWithClient(query, page, client);
      } catch (error) {
        signal.throwIfAborted();
        const mapped = mapImapError(error);
        // The search runs on its own connection. When the server drops it
        // while it opens, such as at its connection limit, connect once more.
        if (attempt > 0 || connected || !isDroppedConnection(mapped)) throw mapped;
      } finally {
        signal.removeEventListener('abort', close);
        client.close();
      }
      await untilAborted(reconnectDelay(), signal);
    }
  }

  private async listMessagesWithClient(
    query: EmailQuery,
    page?: PageOpts,
    searchClient?: ImapFlow,
  ): Promise<MessageSearchPage> {
    const normalized = normalizeEmailQuery(query);
    if (!normalized.success) {
      throw new EmailError('invalid_request', normalized.diagnostics.map((item) => item.message).join(' '), {
        diagnostics: normalized.diagnostics,
      });
    }
    query = normalized.query;
    if (page?.includeSearchContext && !query.text) {
      throw new EmailError('invalid_request', 'includeSearchContext requires a portable text query.');
    }
    const recent = await this.recentFolders(searchClient);
    try {
      return await this.listMessagesIn(recent.folders, query, page, searchClient);
    } catch (error) {
      // A search changes nothing, so it can run again with the folders as they are now.
      if (!recent.reused || !staleListing(error)) throw error;
      return this.listMessagesIn(await this.refreshFolders(searchClient), query, page, searchClient);
    }
  }

  private async listMessagesIn(
    folders: ResolvedFolders,
    query: EmailQuery,
    page: PageOpts | undefined,
    searchClient: ImapFlow | undefined,
  ): Promise<MessageSearchPage> {
    const explicit = query.folder;
    let paths: string[];
    if (explicit) {
      const rolePath = this.rolePath(explicit as FolderRole, folders);
      const listedPath = findMailboxPath(folders.selectablePaths, explicit);
      if (!rolePath && !listedPath && (explicit === 'starred' || explicit === 'all'))
        paths = this.allMailPaths(folders);
      else if (!rolePath && !listedPath) throw new EmailError('not_found', `No folder named "${explicit}"`);
      else paths = [rolePath ?? listedPath!];
    } else {
      paths = this.allMailPaths(folders);
    }
    const normalizedQuery = { ...query, ...(explicit === 'starred' ? { starred: true } : {}), folder: undefined };
    // Hash the resolved paths rather than the folder as typed, so either Unicode spelling of a name
    // continues the same pages.
    const hash = cursorHash({ query: normalizedQuery, paths });
    const cursor = decodeCursor(page?.pageToken, hash);
    const pageSize = Math.min(Math.max(page?.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const items: Message[] = [];
    let folderIndex = cursor.folder;
    let upperUid = cursor.upperUid;
    let nextCursor: Cursor | undefined;
    let inspectedCandidates = 0;
    let foldersScanned = 0;
    let incompleteReason: 'scan_limit' | 'time_limit' | undefined;
    const diagnostics: SearchDiagnostic[] = [];
    const localFilter = query.hasAttachment !== undefined || query.after !== undefined || query.before !== undefined;

    searchFolders: for (; folderIndex < paths.length; folderIndex++, upperUid = undefined) {
      page?.signal?.throwIfAborted();
      if (page?.softDeadlineAt !== undefined && Date.now() >= page.softDeadlineAt) {
        nextCursor = folderIndex === cursor.folder ? cursor : { v: 3, hash, folder: folderIndex };
        incompleteReason = 'time_limit';
        break;
      }
      if (foldersScanned >= 10) {
        nextCursor = { v: 3, hash, folder: folderIndex };
        incompleteReason = 'scan_limit';
        break;
      }
      const path = paths[folderIndex]!;
      await this.withMailbox(
        path,
        async (client, uidValidity) => {
          if (
            folderIndex === cursor.folder &&
            ((cursor.mailbox && cursor.mailbox !== path) || (cursor.uidValidity && cursor.uidValidity !== uidValidity))
          ) {
            throw new EmailError('invalid_request', 'The mailbox changed after this IMAP page token was issued.');
          }
          let found: number[] | undefined;
          let unsearched: { upperUid: number; reason?: 'scan_limit' | 'time_limit' } | undefined;
          const gmailRaw = client.capabilities.has('X-GM-EXT-1');
          const searches = toImapSearches(normalizedQuery, gmailRaw);
          const mailbox = client.mailbox || undefined;
          // A slow server-side search can outlast the caller's hard deadline. Once
          // this page has finished a folder, stop at the soft deadline and return
          // what it has. The dedicated search connection is closed afterwards.
          const searchDeadlineAt = searchClient && foldersScanned > 0 ? page?.softDeadlineAt : undefined;
          // Gmail indexes its search. Other servers may read every message, so a
          // large folder is searched in UID ranges that each finish quickly.
          if (
            page?.softDeadlineAt !== undefined &&
            !gmailRaw &&
            typeof mailbox?.uidNext === 'number' &&
            mailbox.exists > SEARCH_WINDOW_UIDS
          ) {
            const windows = await searchWindows(
              client,
              searches,
              upperUid ?? mailbox.uidNext - 1,
              page.softDeadlineAt,
              localFilter ? 1_000 - inspectedCandidates : pageSize - items.length + 1,
              searchDeadlineAt !== undefined,
              // An open connection learns of new mail but not of its UIDs.
              upperUid === undefined,
              page.signal,
            );
            if (windows.abandoned) {
              nextCursor = { v: 3, hash, folder: folderIndex };
              incompleteReason = 'time_limit';
              return;
            }
            found = windows.uids;
            if (windows.upperUid !== undefined) {
              unsearched = {
                upperUid: windows.upperUid,
                reason: windows.timedOut ? 'time_limit' : localFilter ? 'scan_limit' : undefined,
              };
            }
          }
          for (const search of found === undefined ? searches : []) {
            page?.signal?.throwIfAborted();
            const matches = await imapStep('search', async () =>
              searchDeadlineAt === undefined
                ? (await client.search(search, { uid: true })) || []
                : searchUntil(client, search, searchDeadlineAt),
            );
            if (matches === undefined) {
              nextCursor = { v: 3, hash, folder: folderIndex };
              incompleteReason = 'time_limit';
              return;
            }
            if (found === undefined) {
              found = matches;
            } else {
              const matchingUids = new Set(matches);
              found = found.filter((uid) => matchingUids.has(uid));
            }
            if (!found.length) break;
          }
          const uids = (found ?? []).sort((a, b) => b - a).filter((uid) => upperUid === undefined || uid <= upperUid);
          // Fetch candidates in batches with one UID FETCH each, and look up and save
          // their stored locations once per batch, instead of a round trip per message.
          let batch = new Map<number, FetchMessageObject>();
          let stored: Map<number, ImapMessageLocation | null> | undefined;
          let batchEnd = 0;
          let msPerCandidate: number | undefined;
          const pendingSaves: ImapMessageLocation[] = [];
          // Search context reads each message, so check the deadline per message for it.
          // Otherwise only a new batch costs a round trip. Previews alone are read for
          // the whole page at the end.
          const perMessageReads = Boolean(page?.includeSearchContext && query.text);
          const previews: { message: Message; fetched: FetchMessageObject }[] = [];
          candidates: for (let index = 0; index < uids.length; index++) {
            const uid = uids[index]!;
            page?.signal?.throwIfAborted();
            // A page reads at least one candidate, so a search that used up the
            // soft deadline still moves the next page forward.
            if (
              (index >= batchEnd || perMessageReads) &&
              (index > 0 || items.length > 0) &&
              page?.softDeadlineAt !== undefined &&
              Date.now() >= page.softDeadlineAt
            ) {
              nextCursor = { v: 3, hash, folder: folderIndex, upperUid: uid, mailbox: path, uidValidity };
              incompleteReason = 'time_limit';
              break candidates;
            }
            if (inspectedCandidates >= 1_000) {
              nextCursor = { v: 3, hash, folder: folderIndex, upperUid: uid, mailbox: path, uidValidity };
              incompleteReason = 'scan_limit';
              break candidates;
            }
            if (index >= batchEnd) {
              // Without local filters every fetched message joins the page, so fetch
              // what the page still needs plus one to tell whether more remain. Past
              // the soft deadline, the one candidate this page must read is enough.
              const left = page?.softDeadlineAt === undefined ? Infinity : page.softDeadlineAt - Date.now();
              const fitsInTime =
                left === Infinity
                  ? Infinity
                  : msPerCandidate === undefined
                    ? DEADLINE_FIRST_FETCH_BATCH
                    : Math.max(1, Math.floor(left / msPerCandidate));
              const needed = localFilter ? FILTERED_FETCH_BATCH : pageSize - items.length + 1;
              const wanted = left <= 0 ? 1 : Math.min(needed, fitsInTime);
              batchEnd = index + Math.min(wanted, 1_000 - inspectedCandidates, uids.length - index);
              const batchUids = uids.slice(index, batchEnd);
              const fetchStarted = Date.now();
              batch = await this.fetchBatch(client, batchUids);
              msPerCandidate = Math.max(0, Date.now() - fetchStarted) / batchUids.length;
              stored = await this.findStoredLocations(path, uidValidity, [...batch.keys()]);
            }
            inspectedCandidates += 1;
            const fetched = batch.get(uid);
            if (!fetched) continue;
            const hasAttachment = inspectStructure(fetched.bodyStructure).attachments.some(
              (attachment) => attachment.disposition !== 'inline',
            );
            if (query.hasAttachment !== undefined && hasAttachment !== query.hasAttachment) continue;
            const receivedAt = isoDate(fetched.internalDate ?? fetched.envelope?.date);
            if (query.after && receivedAt < `${query.after}T00:00:00.000Z`) continue;
            if (query.before && receivedAt >= `${query.before}T00:00:00.000Z`) continue;
            if (items.length === pageSize) {
              nextCursor = { v: 3, hash, folder: folderIndex, upperUid: uid, mailbox: path, uidValidity };
              break candidates;
            }
            const message = await this.toMessage(client, path, uidValidity, fetched, {
              snippet: page?.includeSnippet === true && perMessageReads,
              snippetDiagnostics: diagnostics,
              ...(page?.includeSearchContext && query.text
                ? { searchContextText: query.text, searchContextDiagnostics: diagnostics }
                : {}),
              signal: page?.signal,
              ...(stored ? { existing: stored.get(uid) ?? null } : {}),
              pendingSaves,
            });
            items.push(message);
            if (page?.includeSnippet === true && !perMessageReads) previews.push({ message, fetched });
          }
          if (!nextCursor && unsearched) {
            nextCursor = { v: 3, hash, folder: folderIndex, upperUid: unsearched.upperUid, mailbox: path, uidValidity };
            incompleteReason = unsearched.reason;
          }
          await this.addSnippets(client, previews, diagnostics, page?.signal, page?.softDeadlineAt);
          await this.saveLocations(pendingSaves);
        },
        searchClient,
      );
      foldersScanned += 1;
      if (nextCursor) break searchFolders;
    }

    const out: MessageSearchPage = {
      items,
      exhausted: !nextCursor && folderIndex >= paths.length,
      ...(diagnostics.length ? { diagnostics } : {}),
      ...(localFilter ? { inspectedCandidates } : {}),
    };
    if (nextCursor) out.nextPageToken = encodeCursor(nextCursor);
    if (nextCursor && incompleteReason) {
      out.incomplete = true;
      out.incompleteReason = incompleteReason;
    }
    return out;
  }

  /**
   * Adds previews to a page's messages with one fetch per text part and encoding.
   * Past the soft deadline it stops between fetches, so the page keeps its
   * metadata and the remaining previews are reported unavailable.
   */
  private async addSnippets(
    client: ImapFlow,
    previews: { message: Message; fetched: FetchMessageObject }[],
    diagnostics: SearchDiagnostic[],
    signal: AbortSignal | undefined,
    deadlineAt: number | undefined,
  ): Promise<void> {
    const entries = previews.flatMap(({ fetched }) =>
      fetched.bodyStructure
        ? [{ uid: fetched.uid, structure: fetched.bodyStructure, parts: inspectStructure(fetched.bodyStructure) }]
        : [],
    );
    if (!entries.length) return;
    const snippets = await downloadSnippets(client, entries, deadlineAt);
    signal?.throwIfAborted();
    for (const { message, fetched } of previews) {
      if (!fetched.bodyStructure) continue;
      if (!snippets.has(fetched.uid)) {
        diagnostics.push({
          code: 'snippet_unavailable',
          severity: 'warning',
          message: 'A message preview could not be loaded. Message metadata is still available.',
        });
        continue;
      }
      const snippet = snippets.get(fetched.uid);
      if (snippet !== undefined) message.snippet = snippet;
    }
  }

  /** Fetches list metadata for several UIDs with one UID FETCH. Expunged UIDs are absent. */
  private async fetchBatch(client: ImapFlow, uids: number[]): Promise<Map<number, FetchMessageObject>> {
    const fetched = new Map<number, FetchMessageObject>();
    if (!uids.length) return fetched;
    await imapStep('fetch', async () => {
      for await (const message of client.fetch(uids.join(','), LIST_FETCH, { uid: true })) {
        fetched.set(message.uid, message);
      }
    });
    return fetched;
  }

  /** Looks up stored locations for a batch, or returns undefined when the store can only look up one at a time. */
  private async findStoredLocations(
    path: string,
    uidValidity: string,
    uids: number[],
  ): Promise<Map<number, ImapMessageLocation | null> | undefined> {
    if (!this.options.store.findByLocations) return undefined;
    const stored = new Map<number, ImapMessageLocation | null>(uids.map((uid) => [uid, null]));
    if (!uids.length) return stored;
    for (const location of await this.options.store.findByLocations(path, uidValidity, uids)) {
      if (stored.has(location.uid)) stored.set(location.uid, location);
    }
    return stored;
  }

  private async saveLocations(locations: ImapMessageLocation[]): Promise<void> {
    if (!locations.length) return;
    if (this.options.store.saveMany) {
      await this.options.store.saveMany(locations);
      return;
    }
    for (const location of locations) await this.options.store.save(location);
  }

  /**
   * Fetches a stored message in a folder opened with withCurrentMailbox.
   * Another mail app may have replaced it under a new UID, as Apple Mail does
   * when it autosaves a draft, or the folder's UIDVALIDITY may have changed.
   * The copy with the same Message-ID then keeps the stored ID and draft ID,
   * which the caller saves unless it saves the location itself. A message that
   * is gone loses its stored location, and the result is undefined. Every ID
   * whose location this removes is added to removed. With changed, the stored
   * UID just failed a read, and a copy at another UID is preferred: a copy
   * marked \Deleted may still answer a FETCH until it is expunged.
   */
  private async fetchCurrent<T>(
    client: ImapFlow,
    location: ImapMessageLocation,
    uidValidity: string,
    fetch: (uid: number) => Promise<T | false | undefined>,
    { save = true, removed, changed = false }: { save?: boolean; removed?: Set<string>; changed?: boolean } = {},
  ): Promise<{ location: ImapMessageLocation; fetched: T } | undefined> {
    const sameValidity = uidValidity === location.uidValidity;
    if (sameValidity && !changed) {
      const fetched = await imapStep('fetch', () => fetch(location.uid));
      if (fetched) return { location, fetched };
    }
    const uid =
      (await this.replacementUid(client, location, uidValidity, changed ? location.uid : undefined)) ??
      (changed && sameValidity ? location.uid : undefined);
    const fetched = uid === undefined ? undefined : await imapStep('fetch', () => fetch(uid));
    if (uid === undefined || !fetched) {
      await this.options.store.remove(location.id);
      removed?.add(location.id);
      return undefined;
    }
    const occupant = await this.options.store.findByLocation(location.mailboxPath, uidValidity, uid);
    if (occupant && occupant.id !== location.id) {
      await this.options.store.remove(occupant.id);
      removed?.add(occupant.id);
    }
    const current = { ...location, uidValidity, uid };
    if (save) await this.options.store.save(current);
    return { location: current, fetched };
  }

  /**
   * The UID of the copy with the stored message's Message-ID, preferring one
   * no other stored location names. Only a draft takes over a copy stored
   * under another ID: a draft another mail app saved again may already have
   * been listed, while elsewhere that copy is more likely a second, separate
   * copy of the message. A copy at avoid is used only when no other copy is free.
   */
  private async replacementUid(
    client: ImapFlow,
    location: ImapMessageLocation,
    uidValidity: string,
    avoid?: number,
  ): Promise<number | undefined> {
    const messageId = location.messageId;
    if (!messageId) return undefined;
    const found = await imapStep('search', () => client.search({ header: { 'Message-ID': messageId } }, { uid: true }));
    if (!found || !found.length) return undefined;
    const newest = [...found].sort((a, b) => b - a);
    const stored = this.options.store.findByLocations
      ? await this.options.store.findByLocations(location.mailboxPath, uidValidity, newest)
      : (
          await Promise.all(
            newest.map((uid) => this.options.store.findByLocation(location.mailboxPath, uidValidity, uid)),
          )
        ).filter((row): row is ImapMessageLocation => row !== undefined);
    const taken = new Set(stored.filter((row) => row.id !== location.id).map((row) => row.uid));
    const free = newest.filter((uid) => !taken.has(uid));
    return free.find((uid) => uid !== avoid) ?? free[0] ?? (location.draftId ? newest[0] : undefined);
  }

  /** Where a stored message is in the open folder now, or undefined once it is gone. */
  private async currentLocation(
    client: ImapFlow,
    location: ImapMessageLocation,
    uidValidity: string,
  ): Promise<ImapMessageLocation | undefined> {
    const current = await this.fetchCurrent(client, location, uidValidity, (uid) =>
      client.fetchOne(uid, { uid: true }, { uid: true }),
    );
    return current?.location;
  }

  /** Stored messages as they are in the open folder now, leaving out ones that are gone. */
  private async currentLocations(
    client: ImapFlow,
    locations: ImapMessageLocation[],
    uidValidity: string,
  ): Promise<ImapMessageLocation[]> {
    const listed = locations.filter((location) => location.uidValidity === uidValidity);
    const present = new Set(
      listed.length
        ? (await imapStep('search', () =>
            client.search({ uid: listed.map((location) => location.uid).join(',') }, { uid: true }),
          )) || []
        : [],
    );
    const current: ImapMessageLocation[] = [];
    for (const location of locations) {
      if (location.uidValidity === uidValidity && present.has(location.uid)) {
        current.push(location);
        continue;
      }
      const moved = await this.currentLocation(client, location, uidValidity);
      if (moved) current.push(moved);
    }
    return current;
  }

  private async fetchLocation(
    location: ImapMessageLocation,
    body: boolean,
    includeHeaders = false,
    removed?: Set<string>,
  ): Promise<Message> {
    return this.withCurrentMailbox(location.mailboxPath, async (client, uidValidity) => {
      const message = await this.readCurrent(
        client,
        location,
        uidValidity,
        (uid) =>
          client.fetchOne(
            uid,
            {
              envelope: true,
              flags: true,
              internalDate: true,
              bodyStructure: true,
              headers: includeHeaders ? true : HEADER_NAMES,
            },
            { uid: true },
          ),
        async ({ location: current, fetched }) => {
          // A reply with only flags, as for a message being expunged, is not the message.
          if (!fetched.envelope) throw changedMidReadError();
          if (body && !fetched.bodyStructure) {
            const source = await client.fetchOne(current.uid, { source: true }, { uid: true });
            if (source && source.source) fetched.source = source.source;
            else if (await isGone(client, current.uid)) throw changedMidReadError();
          }
          return this.toMessage(client, current.mailboxPath, uidValidity, fetched, {
            body,
            includeHeaders,
            existing: current,
            threadId: current.threadId,
            ...(current.draftId ? { draftId: current.draftId } : {}),
          });
        },
        // toMessage saves the location.
        { save: false, removed },
      );
      if (!message) throw new EmailError('not_found', `No message with id "${location.id}"`);
      return message;
    });
  }

  /**
   * Fetches a stored message with fetchCurrent, then reads it with read.
   * Another mail app may replace the message after it was fetched, as Apple
   * Mail does when it autosaves an open draft, and the read then fails with
   * changedMidReadError. Each retry reads the copy that replaced it. The result
   * is undefined once the message is gone.
   */
  private async readCurrent<T, R>(
    client: ImapFlow,
    location: ImapMessageLocation,
    uidValidity: string,
    fetch: (uid: number) => Promise<T | false | undefined>,
    read: (current: { location: ImapMessageLocation; fetched: T }) => Promise<R>,
    options?: { save?: boolean; removed?: Set<string> },
  ): Promise<R | undefined> {
    let stored = location;
    for (let attempt = 1; ; attempt++) {
      const current = await this.fetchCurrent(client, stored, uidValidity, fetch, {
        ...options,
        changed: attempt > 1,
      });
      if (!current) return undefined;
      try {
        return await read(current);
      } catch (error) {
        if (!isChangedMidRead(error) || attempt >= CHANGED_MID_READ_ATTEMPTS) throw error;
        stored = current.location;
      }
    }
  }

  async getMessage(id: string, options?: GetMessageOpts): Promise<Message> {
    return this.fetchMessage(id, true, options?.includeHeaders ?? false);
  }

  private async fetchMessage(id: string, body: boolean, includeHeaders: boolean): Promise<Message> {
    const location = await this.options.store.findById(id);
    if (!location) throw new EmailError('not_found', `No message with id "${id}"`);
    return this.fetchLocation(location, body, includeHeaders);
  }

  async getThread(id: string): Promise<Thread> {
    const stored = await this.options.store.listByThreadId(id);
    if (!stored.length) throw new EmailError('not_found', `No thread with id "${id}"`);
    const byId = new Map<string, Message>();
    // A draft another mail app saved again takes over the location of its new
    // copy if Drafts was listed first, which removes that copy's stored ID.
    const removed = new Set<string>();
    // One at a time, as the mailbox lock would run them anyway.
    const fetchAll = async (locations: ImapMessageLocation[]) => {
      for (const location of locations) {
        if (byId.has(location.id) || removed.has(location.id)) continue;
        try {
          const message = await this.fetchLocation(location, true, false, removed);
          byId.set(message.id, message);
        } catch (error) {
          // A message another mail app deleted is left out.
          if (!(error instanceof EmailError) || error.code !== 'not_found') throw error;
        }
      }
    };
    // Fetching the stored messages first moves one another mail app saved
    // again to its new UID, so the search below finds it stored instead of
    // storing it again under a new ID.
    await fetchAll(stored);
    let locations = await this.options.store.listByThreadId(id);
    const folders = await this.refreshFolders();
    const searched = new Set<string>();
    while (true) {
      const identifiers = new Set(
        locations
          .flatMap((location) => [location.messageId, location.inReplyTo, ...(location.references ?? [])])
          .filter(Boolean) as string[],
      );
      const pending = [...identifiers].filter((identifier) => !searched.has(identifier));
      if (!pending.length) break;
      pending.forEach((identifier) => searched.add(identifier));
      for (const path of folders.selectablePaths.filter((value) => value !== folders.paths.all)) {
        await this.withMailbox(path, async (client, uidValidity) => {
          const uids = new Set<number>();
          for (let start = 0; start < pending.length; start += THREAD_SEARCH_BATCH) {
            const found = await client.search(
              {
                or: pending
                  .slice(start, start + THREAD_SEARCH_BATCH)
                  .flatMap((identifier) => HEADER_NAMES.map((name) => ({ header: { [name]: identifier } }))),
              },
              { uid: true },
            );
            for (const uid of found || []) uids.add(uid);
          }
          for (const uid of uids) {
            const existing = await this.options.store.findByLocation(path, uidValidity, uid);
            if (existing) {
              if (existing.threadId !== id) await this.options.store.save({ ...existing, threadId: id });
              continue;
            }
            const fetched = await client.fetchOne(
              uid,
              { envelope: true, flags: true, internalDate: true, bodyStructure: true, headers: HEADER_NAMES },
              { uid: true },
            );
            if (fetched) await this.toMessage(client, path, uidValidity, fetched, { threadId: id });
          }
        });
      }
      // The search can replace stale locations as well as add new ones, so
      // the next pass starts from what is stored now.
      locations = await this.options.store.listByThreadId(id);
    }
    await fetchAll(locations);
    const messages = [...byId.values()].filter((message) => !removed.has(message.id));
    if (!messages.length) throw new EmailError('not_found', `No thread with id "${id}"`);
    messages.sort((a, b) => a.date.localeCompare(b.date));
    return { id, subject: messages[0]?.subject ?? '', messages };
  }

  private async threadingFor(input: DraftInput): Promise<{ input: DraftInput; headers?: ThreadingHeaders }> {
    if (!input.replyToMessageId) return { input };
    const original = await this.fetchMessage(input.replyToMessageId, false, true);
    const header = (name: string) =>
      Object.entries(original.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const messageId = header('Message-ID');
    const oldReferences = header('References');
    const references = [oldReferences, messageId].filter(Boolean).join(' ');
    return {
      input: { ...input, subject: input.subject ?? replySubject(original.subject), replyToMessageId: undefined },
      headers: {
        ...(messageId ? { inReplyTo: messageId } : {}),
        ...(references ? { references } : {}),
      },
    };
  }

  private async compose(input: DraftInput, existingThreading?: ThreadingHeaders): Promise<Buffer> {
    const resolved = input.replyToMessageId ? await this.threadingFor(input) : { input, headers: existingThreading };
    return composeMessage(resolved.input, this.sender(resolved.input.from), resolved.headers);
  }

  /** The From address and name a message from this sender carries. */
  private sender(from?: string): EmailAddress {
    return from
      ? (this.options.resolveSender?.(from) ?? { email: from })
      : { ...(this.options.displayName ? { name: this.options.displayName } : {}), email: this.options.email };
  }

  async senderName(from?: string): Promise<string | undefined> {
    return this.sender(from).name;
  }

  private async appendedLocation(
    path: string,
    result: false | { uid?: number; uidValidity?: bigint },
    messageId: string | undefined,
    kind: string,
  ): Promise<{ uid: number; uidValidity: string }> {
    if (result && result.uid && result.uidValidity) {
      return { uid: result.uid, uidValidity: result.uidValidity.toString() };
    }
    if (messageId) {
      const found = await this.withMailbox(path, async (client, uidValidity) => {
        const matches = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
        const uid = Math.max(...(matches || []));
        return Number.isFinite(uid) ? { uid, uidValidity } : undefined;
      });
      if (found) return found;
    }
    throw new EmailError('provider_unavailable', `The IMAP server did not return or expose an ID for the ${kind}`);
  }

  /** Saves a draft to the Drafts folder and stores its location. */
  private async appendDraft(raw: Buffer, draftId: string, existingId?: string): Promise<ImapMessageLocation> {
    await this.refreshFolders();
    const path = this.requireRole('drafts');
    const parsed = await PostalMime.parse(raw, POSTAL_OPTIONS);
    const client = await this.client();
    let result: Awaited<ReturnType<ImapFlow['append']>>;
    try {
      result = await client.append(path, raw, ['\\Draft']);
    } catch (error) {
      throw mapImapError(error);
    }
    const appended = await this.appendedLocation(path, result, parsed.messageId, 'saved draft');
    const location: ImapMessageLocation = {
      id: existingId ?? locationId('im', this.options.accountId, path, appended.uidValidity, appended.uid),
      accountId: this.options.accountId,
      mailboxPath: path,
      uidValidity: appended.uidValidity,
      uid: appended.uid,
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      ...(parsed.references ? { references: parsed.references.match(/<[^>]+>/g) ?? [] } : {}),
      threadId: threadId(
        {
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references?.match(/<[^>]+>/g) ?? [],
        },
        draftId,
      ),
      draftId,
      subject: parsed.subject ?? '',
      date: parsed.date ?? new Date().toISOString(),
    };
    await this.options.store.save(location);
    return location;
  }

  async createDraft(input: DraftInput): Promise<Message> {
    const location = await this.appendDraft(await this.compose(input), `draft_${randomBytes(9).toString('base64url')}`);
    return this.fetchLocation(location, true);
  }

  async getDraft(draftId: string): Promise<Message> {
    const location = await this.options.store.findByDraftId(draftId);
    if (!location) throw new EmailError('not_found', `No draft with id "${draftId}"`);
    return this.fetchLocation(location, true);
  }

  async updateDraft(draftId: string, input: DraftInput): Promise<Message> {
    const location = await this.options.store.findByDraftId(draftId);
    if (!location) throw new EmailError('not_found', `No draft with id "${draftId}"`);
    const current = input.from === undefined ? await this.fetchLocation(location, true) : undefined;
    // Delete the copy that is there now, which another mail app may have replaced.
    const currentUid = current
      ? (await this.options.store.findById(location.id))?.uid
      : await this.withCurrentMailbox(
          location.mailboxPath,
          async (client, uidValidity) => (await this.currentLocation(client, location, uidValidity))?.uid,
        );
    if (currentUid === undefined) throw new EmailError('not_found', `No draft with id "${draftId}"`);
    const replacementInput =
      input.from === undefined && current?.from?.email ? { ...input, from: current.from.email } : input;
    const replacement = await this.appendDraft(
      await this.compose(replacementInput, {
        ...(location.inReplyTo ? { inReplyTo: location.inReplyTo } : {}),
        ...(location.references?.length ? { references: location.references.join(' ') } : {}),
      }),
      draftId,
      location.id,
    );
    // Delete the old copy before reading the new one, so a failed read leaves
    // one draft. Another mail app may have saved the old copy again since it
    // was read, and those copies share its Message-ID.
    const messageId = location.messageId;
    await this.withMailbox(location.mailboxPath, async (client) => {
      const stale = new Set([currentUid]);
      if (messageId) {
        const copies = await imapStep('search', () =>
          client.search({ header: { 'Message-ID': messageId } }, { uid: true }),
        );
        for (const uid of copies || []) stale.add(uid);
      }
      stale.delete(replacement.uid);
      await client.messageDelete([...stale].join(','), { uid: true });
    });
    return this.fetchLocation(replacement, true);
  }

  async deleteDraft(draftId: string): Promise<void> {
    const location = await this.options.store.findByDraftId(draftId);
    if (!location) throw new EmailError('not_found', `No draft with id "${draftId}"`);
    const deleted = await this.withCurrentMailbox(location.mailboxPath, async (client, uidValidity) => {
      const current = await this.currentLocation(client, location, uidValidity);
      // Nothing is left to delete when another mail app already deleted it,
      // and fetchCurrent has already forgotten it.
      if (current) await client.messageDelete(current.uid, { uid: true });
      return current !== undefined;
    });
    if (deleted) await this.options.store.remove(location.id);
  }

  private async deliver(raw: Buffer, envelopeRecipients: string[], envelopeFrom: string): Promise<string> {
    if (!envelopeRecipients.length) throw new EmailError('invalid_request', 'Cannot send a message with no recipients');
    try {
      this.smtp ??= this.buildSmtp();
      const info = await this.smtp.sendMail({
        envelope: { from: envelopeFrom, to: envelopeRecipients },
        raw: stripBccHeader(raw),
      });
      return info.messageId || `smtp_${randomBytes(9).toString('base64url')}`;
    } catch (error) {
      throw mapImapError(error, 'smtp');
    }
  }

  private async appendSent(raw: Buffer): Promise<ImapMessageLocation | undefined> {
    if (!this.options.credentials.saveSent) return undefined;
    await this.refreshFolders();
    const path = this.resolved?.paths.sent;
    if (!path) return undefined;
    const parsed = await PostalMime.parse(raw, POSTAL_OPTIONS);
    const result = await (await this.client()).append(path, raw, ['\\Seen']);
    const appended = await this.appendedLocation(path, result, parsed.messageId, 'Sent copy');
    const headers: ParsedHeaders = {
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      references: parsed.references?.match(/<[^>]+>/g) ?? [],
    };
    const location: ImapMessageLocation = {
      id: locationId('im', this.options.accountId, path, appended.uidValidity, appended.uid),
      accountId: this.options.accountId,
      mailboxPath: path,
      uidValidity: appended.uidValidity,
      uid: appended.uid,
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      ...(headers.references.length ? { references: headers.references } : {}),
      threadId: threadId(headers, parsed.messageId ?? String(appended.uid)),
      subject: parsed.subject ?? '',
      date: parsed.date ?? new Date().toISOString(),
    };
    await this.options.store.save(location);
    return location;
  }

  private async moveDraftToSent(location: ImapMessageLocation): Promise<ImapMessageLocation | undefined> {
    await this.refreshFolders();
    const destination = this.resolved?.paths.sent;
    if (!destination) return undefined;
    const moved = await this.withMailbox(location.mailboxPath, (client) =>
      client.messageMove(location.uid, destination, { uid: true }),
    );
    const mappedUid = moved && moved.uidMap?.get(location.uid);
    const target =
      moved && mappedUid && moved.uidValidity
        ? { uid: mappedUid, uidValidity: moved.uidValidity.toString() }
        : await this.appendedLocation(destination, false, location.messageId, 'moved Sent copy');
    await this.withMailbox(destination, async (client, uidValidity) => {
      if (uidValidity !== target.uidValidity) {
        throw new EmailError('provider_unavailable', 'The Sent folder changed while the draft was being moved');
      }
      await client.messageFlagsRemove(target.uid, ['\\Draft'], { uid: true });
      await client.messageFlagsAdd(target.uid, ['\\Seen'], { uid: true });
    });
    const { draftId: _draftId, ...withoutDraft } = location;
    const sent = {
      ...withoutDraft,
      mailboxPath: destination,
      uidValidity: target.uidValidity,
      uid: target.uid,
    };
    await this.options.store.save(sent);
    return sent;
  }

  async send(input: DraftInput | { draftId: string }): Promise<SendResult> {
    let raw: Buffer;
    let draftLocation: ImapMessageLocation | undefined;
    let envelopeRecipients: string[];
    let envelopeFrom: string;
    if ('draftId' in input) {
      const stored = await this.options.store.findByDraftId(input.draftId);
      if (!stored) throw new EmailError('not_found', `No draft with id "${input.draftId}"`);
      const current = await this.withCurrentMailbox(stored.mailboxPath, (client, uidValidity) =>
        this.fetchCurrent(client, stored, uidValidity, (uid) => client.fetchOne(uid, { source: true }, { uid: true })),
      );
      if (!current?.fetched.source) throw new EmailError('not_found', `No draft with id "${input.draftId}"`);
      draftLocation = current.location;
      raw = current.fetched.source;
      const parsed = await PostalMime.parse(raw, POSTAL_OPTIONS);
      envelopeRecipients = [
        ...postalAddresses(parsed.to),
        ...postalAddresses(parsed.cc),
        ...postalAddresses(parsed.bcc),
      ].map((value) => value.email);
      envelopeFrom = postalAddresses(parsed.from)[0]?.email ?? this.options.email;
    } else {
      raw = await this.compose(input);
      envelopeRecipients = recipients(input);
      envelopeFrom = input.from ?? this.options.email;
    }

    const deliveryId = await this.deliver(raw, envelopeRecipients, envelopeFrom);
    const warnings: string[] = [];
    let sent: ImapMessageLocation | undefined;
    if (draftLocation && this.options.credentials.saveSent) {
      try {
        sent = await this.moveDraftToSent(draftLocation);
        if (!sent) {
          warnings.push('Message delivered, but no Sent folder is configured, so Fluxmail could not save a copy.');
          await this.withMailbox(draftLocation.mailboxPath, async (client) => {
            await client.messageDelete(draftLocation!.uid, { uid: true });
          });
          await this.options.store.remove(draftLocation.id);
        }
      } catch (error) {
        warnings.push(
          `Message delivered, but Fluxmail could not move the draft to Sent: ${mapImapError(error).message}`,
        );
      }
    } else {
      try {
        sent = await this.appendSent(raw);
        if (this.options.credentials.saveSent && !sent) {
          warnings.push('Message delivered, but no Sent folder is configured, so Fluxmail could not save a copy.');
        }
      } catch (error) {
        warnings.push(`Message delivered, but Fluxmail could not save the Sent copy: ${mapImapError(error).message}`);
      }
      if (draftLocation) {
        try {
          await this.withMailbox(draftLocation.mailboxPath, async (client) => {
            await client.messageDelete(draftLocation!.uid, { uid: true });
          });
          await this.options.store.remove(draftLocation.id);
        } catch (error) {
          warnings.push(`Message delivered, but Fluxmail could not remove the draft: ${mapImapError(error).message}`);
        }
      }
    }
    return {
      id: sent?.id ?? deliveryId,
      threadId: sent?.threadId ?? `ith_${createHash('sha256').update(deliveryId).digest('hex').slice(0, 24)}`,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  async findRepliedMessage(draftId: string): Promise<string | undefined> {
    const draft = await this.options.store.findByDraftId(draftId);
    if (!draft?.inReplyTo) return undefined;
    await this.refreshFolders();
    const own = new Set([this.resolved?.paths.sent, this.resolved?.paths.drafts]);
    // The original is stored under the thread its own headers start, which is usually the draft's too.
    for (const threadId of new Set([draft.threadId, draft.references?.[0], draft.inReplyTo])) {
      if (!threadId) continue;
      const copies = (await this.options.store.listByThreadId(threadId)).filter(
        (location) => !location.draftId && location.messageId === draft.inReplyTo,
      );
      // A message the user sent to themselves has a Sent copy too; the received copy is the one replied to.
      const original = copies.find((location) => !own.has(location.mailboxPath)) ?? copies[0];
      if (original) return original.id;
    }
    return undefined;
  }

  async markReplied(messageId: string, action: 'reply' | 'forward'): Promise<void> {
    const location = await this.options.store.findById(messageId);
    if (!location) return;
    await this.withCurrentMailbox(location.mailboxPath, async (client, uidValidity) => {
      const current = await this.currentLocation(client, location, uidValidity);
      if (current)
        await client.messageFlagsAdd(current.uid, [action === 'reply' ? '\\Answered' : '$Forwarded'], { uid: true });
    });
  }

  async modify(ids: string[], action: ModifyAction): Promise<void> {
    if (typeof action === 'object' && ('addLabels' in action || 'removeLabels' in action)) {
      throw new EmailError('unsupported_capability', 'IMAP accounts do not support labels');
    }
    const locations = await Promise.all(ids.map((id) => this.options.store.findById(id)));
    if (locations.some((location) => !location))
      throw new EmailError('not_found', 'One or more messages no longer exist');
    const flagChange = ['markRead', 'markUnread', 'star', 'unstar'].includes(action as string);
    // A flag change names no folder, so the connection's recent listing will do.
    // A move, archive or trash acts on the listing, so it is taken now.
    if (flagChange) await this.recentFolders();
    else await this.refreshFolders();
    const groups = new Map<string, ImapMessageLocation[]>();
    for (const location of locations as ImapMessageLocation[]) {
      const group = groups.get(location.mailboxPath) ?? [];
      group.push(location);
      groups.set(location.mailboxPath, group);
    }
    const trashPath = this.resolved?.paths.trash;
    if (action === 'untrash') {
      if (!trashPath) this.requireRole('trash');
      if ([...groups.keys()].some((path) => path !== trashPath)) {
        throw new EmailError('invalid_request', 'The untrash action only accepts messages that are in Trash');
      }
    }
    if (action === 'archive' && trashPath && groups.has(trashPath)) {
      throw new EmailError('invalid_request', 'Use the untrash action before archiving a message from Trash');
    }
    let requestedMoveDestination: string | undefined;
    if (typeof action === 'object' && 'move' in action) {
      const roleDestination = this.resolved ? this.rolePath(action.move as FolderRole, this.resolved) : undefined;
      requestedMoveDestination = roleDestination ?? findMailboxPath(this.resolved?.selectablePaths ?? [], action.move);
      if (!requestedMoveDestination) throw new EmailError('not_found', `No folder named "${action.move}"`);
      const sourceIsTrash = trashPath !== undefined && groups.has(trashPath);
      const destinationIsProtected =
        requestedMoveDestination === this.resolved?.paths.archive || requestedMoveDestination === trashPath;
      if (sourceIsTrash || destinationIsProtected) {
        throw new EmailError(
          'invalid_request',
          'Use the archive, trash, or untrash action when moving messages through a protected folder',
        );
      }
    }
    // Resolve the destination before opening any folder, so a missing one fails without changes.
    let destination: string | undefined;
    if (action === 'archive') destination = this.requireRole('archive');
    else if (action === 'trash') destination = this.requireRole('trash');
    else if (action === 'untrash') {
      this.requireRole('trash');
      destination = this.resolved?.paths.inbox ?? 'INBOX';
    } else if (typeof action === 'object' && 'move' in action) destination = requestedMoveDestination!;
    else if (!flagChange && action !== 'delete')
      throw new EmailError('invalid_request', `Unsupported IMAP modify action: ${String(action)}`);
    for (const [path, stored] of groups) {
      await this.withCurrentMailbox(path, async (client, uidValidity) => {
        const group = await this.currentLocations(client, stored, uidValidity);
        // Nothing is left to change for messages another mail app deleted.
        if (!group.length) return;
        const uids = group.map((location) => location.uid);
        if (action === 'markRead') await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        else if (action === 'markUnread') await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
        else if (action === 'star') await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
        else if (action === 'unstar') await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
        else if (action === 'delete') {
          await client.messageDelete(uids, { uid: true });
          await Promise.all(group.map((location) => this.options.store.remove(location.id)));
        } else if (destination !== undefined) {
          if (destination === path) return;
          const moved = await client.messageMove(uids, destination, { uid: true });
          if (moved && moved.uidMap && moved.uidValidity) {
            const uidValidity = moved.uidValidity.toString();
            await this.saveLocations(
              group.flatMap((location) => {
                const uid = moved.uidMap!.get(location.uid);
                return uid ? [{ ...location, mailboxPath: destination, uidValidity, uid }] : [];
              }),
            );
          } else {
            await Promise.all(group.map((location) => this.options.store.remove(location.id)));
          }
        }
      });
    }
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    opts: GetAttachmentOpts = {},
  ): Promise<{ meta: AttachmentMeta; content: Buffer }> {
    const location = await this.options.store.findById(messageId);
    if (!location) throw new EmailError('not_found', `No message with id "${messageId}"`);
    return this.withCurrentMailbox(location.mailboxPath, async (client, uidValidity) => {
      const result = await this.readCurrent(
        client,
        location,
        uidValidity,
        (uid) => client.fetchOne(uid, { bodyStructure: true }, { uid: true }),
        (current) => this.readAttachment(client, current.location.uid, current.fetched, attachmentId, opts),
      );
      if (!result) throw new EmailError('not_found', `No message with id "${messageId}"`);
      return result;
    });
  }

  private async readAttachment(
    client: ImapFlow,
    uid: number,
    fetched: FetchMessageObject,
    attachmentId: string,
    opts: GetAttachmentOpts,
  ): Promise<{ meta: AttachmentMeta; content: Buffer }> {
    const canonicalAttachmentId = attachmentId.startsWith('part:') ? attachmentId : `part:${attachmentId}`;
    const mimePart = canonicalAttachmentId.slice('part:'.length);
    const meta = inspectStructure(fetched.bodyStructure).attachments.find((item) => item.id === canonicalAttachmentId);
    const structurePart = findStructurePart(fetched.bodyStructure, mimePart);
    if (meta && isDecodedBodyStructureSize(structurePart)) {
      assertAttachmentSize(meta.sizeBytes, opts.maxBytes);
    }
    if (!meta && attachmentId.startsWith('raw-')) {
      const index = Number(attachmentId.slice(4));
      const raw = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!raw || !raw.source) throw new EmailError('not_found', `No attachment with id "${attachmentId}"`);
      const parsed = await PostalMime.parse(raw.source, POSTAL_OPTIONS);
      const attachment = parsed.attachments[index];
      if (!attachment) throw new EmailError('not_found', `No attachment with id "${attachmentId}"`);
      const content =
        typeof attachment.content === 'string'
          ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
          : attachment.content instanceof ArrayBuffer
            ? Buffer.from(attachment.content)
            : Buffer.from(attachment.content.buffer, attachment.content.byteOffset, attachment.content.byteLength);
      assertAttachmentSize(content.length, opts.maxBytes);
      return {
        meta: {
          id: attachmentId,
          filename: attachment.filename ?? 'attachment',
          mimeType: attachment.mimeType,
          sizeBytes: content.length,
          ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, '') } : {}),
          ...attachmentDisposition(attachment.disposition),
        },
        content,
      };
    }
    if (!meta) throw new EmailError('not_found', `No attachment with id "${attachmentId}"`);
    const downloaded = await downloadPart(client, uid, mimePart, { uid: true });
    // Fluxmail decodes the part itself when the server returned the wrong MIME
    // header for it, so the limit then applies to the decoded bytes.
    const encoded = structurePart && misreportedPartHeader(downloaded.meta, structurePart) ? structurePart : undefined;
    const limit = opts.maxBytes;
    const maxBytes = limit !== undefined && encoded ? encodedLimit(encoded.encoding?.toLowerCase(), limit) : limit;
    const decode = (raw: Buffer, complete: boolean) => (encoded ? decodePartTransfer(raw, encoded, complete) : raw);
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    for await (const chunk of downloaded.content) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.length;
      chunks.push(bytes);
      if (limit !== undefined && maxBytes !== undefined && sizeBytes > maxBytes) {
        downloaded.content.destroy();
        // Past the encoded limit the decoded part is over the limit too. Report
        // the decoded bytes read so far.
        const decoded = decode(Buffer.concat(chunks, sizeBytes), false).length;
        assertAttachmentSize(Math.max(decoded, limit + 1), limit);
      }
    }
    const content = decode(Buffer.concat(chunks, sizeBytes), true);
    assertAttachmentSize(content.length, limit);
    return { meta, content };
  }
}
