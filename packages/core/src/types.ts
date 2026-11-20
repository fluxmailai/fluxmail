export type Provider = 'gmail' | 'outlook' | 'imap';

export type PortableFolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash' | 'all';

export type SearchAvailability = 'available' | 'unavailable' | 'unknown';

export type SearchFilter =
  | 'folder'
  | 'text'
  | 'from'
  | 'to'
  | 'subject'
  | 'read'
  | 'starred'
  | 'hasAttachment'
  | 'after'
  | 'before';

export interface SearchCapabilities {
  filters: SearchFilter[];
  folderRoles: Record<PortableFolderRole, SearchAvailability>;
  nativeQuery: null | {
    syntax: 'gmail' | 'outlook-kql';
    availability: SearchAvailability;
    unavailableReason?: string;
  };
}

export interface Capabilities {
  /** Gmail labels and Outlook categories. */
  labels: boolean;
  /** Gmail/Outlook thread server-side; IMAP threads are synthesized from References headers. */
  serverThreads: boolean;
  /** @deprecated Use search capabilities instead. */
  serverSearch: 'rich' | 'basic';
  /** Search behavior available for this account. */
  search: SearchCapabilities;
  /** Whether list results include snippets without fetching bodies. */
  snippets: boolean;
  /** Whether list and search results can include match-centered body excerpts. */
  searchContext?: boolean;
}

export interface Account {
  id: string;
  provider: Provider;
  email: string;
  displayName?: string;
  status: 'active' | 'auth_error' | 'disabled';
  capabilities: Capabilities;
  /** Owning member on the instance. */
  ownerMemberId: string;
  /** Whether every active member on this instance can access the mailbox. */
  sharedWithAll: boolean;
  /** Explicit grants used when the mailbox is not shared with all members. */
  grantedMemberIds: string[];
}

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface SendAsIdentity {
  email: string;
  name?: string;
  replyTo?: string;
  isPrimary: boolean;
  source: 'provider' | 'configured';
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'starred' | 'all';

export interface Folder {
  id: string;
  /** Display path, e.g. "Projects/2026". */
  name: string;
  role?: FolderRole;
  /** How an IMAP folder role was resolved. */
  roleSource?: 'user' | 'extension' | 'name';
  unreadCount?: number;
}

/** What renameFolder and moveFolder return. On IMAP a folder's ID is its path, so the ID changes with it. */
export interface RenamedFolder {
  /** The folder as it is listed now. */
  folder: Folder;
  /** The folder as it was listed before the rename. */
  previous: Folder;
}

export interface Label {
  id: string;
  name: string;
  color?: {
    /** Gmail label background color. */
    background?: string;
    /** Gmail label text color. */
    text?: string;
    /** Outlook category preset color name. */
    preset?: string;
  };
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** RFC Content-ID without angle brackets, used by HTML cid: references. */
  contentId?: string;
  disposition?: 'inline' | 'attachment';
}

export interface MessageBody {
  text?: string;
  html?: string;
}

export interface MessageFlags {
  read: boolean;
  starred: boolean;
  draft: boolean;
}

export interface Message {
  id: string;
  threadId: string;
  accountId: string;
  /** Present when this message is a draft; use with updateDraft/deleteDraft/send. */
  draftId?: string;
  /** Canonical location. Gmail: derived from labels; Outlook/IMAP: the containing folder. */
  folder?: Folder;
  /** Gmail label or Outlook category names when capabilities.labels is true. */
  labels?: string[];
  from?: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  /** ISO 8601. */
  date: string;
  snippet?: string;
  searchContext?:
    | { status: 'matched'; excerpt: string }
    | { status: 'no_literal_match' | 'scan_limit' | 'unavailable' };
  /** Populated on getMessage/getThread, not on list. */
  body?: MessageBody;
  /** Populated on getMessage/getThread; omitted when a list response has no MIME metadata. */
  attachments?: AttachmentMeta[];
  flags: MessageFlags;
  /** Selected RFC 5322 headers (Message-ID, References, In-Reply-To, ...) when requested. */
  headers?: Record<string, string>;
}

export interface Thread {
  id: string;
  subject: string;
  messages: Message[];
  /** The search for the thread's messages stopped at its time limit, so some may be missing. */
  incomplete?: true;
}

export interface ThreadOpts {
  /**
   * When the search for messages in other folders should stop. Messages found by then are returned,
   * and the thread is marked incomplete. Providers that load a thread in one request ignore it.
   */
  searchDeadlineAt?: number;
  /**
   * Load only the messages already found for the thread, without searching other folders. A later page of a
   * thread uses it, so its offsets count the same messages as the first page.
   */
  storedOnly?: boolean;
}

export interface AttachmentInput {
  filename: string;
  mimeType: string;
  /** Base64-encoded content. */
  content: string;
  /** Preserve embedded HTML images when forwarding. */
  contentId?: string;
  disposition?: 'inline' | 'attachment';
}

/**
 * An attachment already in the mailbox, named in place of content: the message that has it and its attachment ID
 * from that message's metadata. Fluxmail copies it into the new message with its filename and type.
 */
export interface AttachmentReference {
  messageId: string;
  attachmentId: string;
}

/** An attachment a caller supplies for a new message: its content, or a reference to one in the mailbox. */
export type AttachmentSource = AttachmentInput | AttachmentReference;

export function isAttachmentReference(attachment: AttachmentSource): attachment is AttachmentReference {
  return !('content' in attachment) && 'messageId' in attachment;
}

/**
 * Why an attachment item from a tool call can't be used, or undefined when it can. An item carries content with a
 * filename and type, or messageId and attachmentId; contentId and disposition apply only to content.
 */
export function attachmentItemError(item: {
  filename?: unknown;
  mimeType?: unknown;
  content?: unknown;
  contentId?: unknown;
  disposition?: unknown;
  messageId?: unknown;
  attachmentId?: unknown;
}): string | undefined {
  const reference = item.messageId !== undefined || item.attachmentId !== undefined;
  if (reference) {
    if (item.content !== undefined)
      return 'Give each attachment either content or messageId and attachmentId, not both.';
    if (item.messageId === undefined || item.attachmentId === undefined)
      return 'An attachment from the mailbox needs both messageId and attachmentId.';
    if ([item.filename, item.mimeType, item.contentId, item.disposition].some((value) => value !== undefined))
      return 'An attachment from the mailbox keeps its own filename and type, so give only messageId and attachmentId.';
    return undefined;
  }
  if (item.content === undefined) return 'Give each attachment content, or messageId and attachmentId.';
  if (item.filename === undefined || item.mimeType === undefined)
    return 'An attachment with content needs a filename and mimeType.';
  return undefined;
}

export interface DraftInput {
  /** Sender address. The service validates it against the account's known identities. */
  from?: string;
  /** Optional when derived from a reply (replyToMessageId). */
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  /** Defaults to "Re: ..." when replying. */
  subject?: string;
  body: MessageBody;
  attachments?: AttachmentInput[];
  /**
   * Reply threading: the adapter resolves this message's Message-ID/References
   * (and provider thread id) so the sent message threads correctly everywhere.
   */
  replyToMessageId?: string;
}

export interface SendResult {
  id: string;
  threadId: string;
  /** Non-fatal provider outcomes, such as a delivered message whose Sent copy could not be saved. */
  warnings?: string[];
}

export type ModifyAction =
  | 'markRead'
  | 'markUnread'
  | 'star'
  | 'unstar'
  | 'archive'
  | 'trash'
  | 'untrash'
  | 'delete'
  | { move: string }
  | { addLabels: string[] }
  | { removeLabels: string[] };

export interface EmailQuery {
  /** Folder id or role. An omitted folder uses All Mail, excluding Spam and Trash. */
  folder?: string;
  /** Literal full-text search. Provider operators are escaped. */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  read?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  /** YYYY-MM-DD received/internal date (inclusive, UTC). */
  after?: string;
  /** YYYY-MM-DD received/internal date (exclusive, UTC). */
  before?: string;
  /** Escape hatch: passed to the provider verbatim (e.g. Gmail q=). */
  rawProviderQuery?: string;
}

export interface PortableEmailQuery extends Omit<EmailQuery, 'folder' | 'rawProviderQuery'> {
  folder?: PortableFolderRole;
}

export interface PageOpts {
  pageSize?: number;
  pageToken?: string;
  /** Include or suppress message snippets. Omission preserves the provider default. */
  includeSnippet?: boolean;
  /** Include a match-centered body excerpt for the portable text query. */
  includeSearchContext?: boolean;
  /** Internal cancellation signal used to stop provider work at the request deadline. */
  signal?: AbortSignal;
  /** Internal soft deadline. Providers return a resumable page at the next safe boundary. */
  softDeadlineAt?: number;
}

export type SearchDiagnosticSeverity = 'error' | 'warning';

export interface SearchDiagnostic {
  code: string;
  severity: SearchDiagnosticSeverity;
  message: string;
  start?: number;
  end?: number;
  suggestion?: string;
}

export interface Page<T> {
  items: T[];
  nextPageToken?: string;
  diagnostics?: SearchDiagnostic[];
  incomplete?: true;
  incompleteReason?: 'scan_limit' | 'provider_limit' | 'time_limit';
  inspectedCandidates?: number;
}

export interface MessageSearchPage extends Page<Message> {
  /** True only when the complete requested search scope has been examined. */
  exhausted: boolean;
}
