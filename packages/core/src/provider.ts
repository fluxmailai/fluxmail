import type {
  AttachmentMeta,
  Capabilities,
  DraftInput,
  EmailQuery,
  Folder,
  Label,
  Message,
  MessageSearchPage,
  ModifyAction,
  PageOpts,
  SendResult,
  SendAsIdentity,
  Thread,
} from './types.js';

export interface GetMessageOpts {
  /** Include selected RFC 5322 headers (Message-ID, References, ...). */
  includeHeaders?: boolean;
}

export interface GetAttachmentOpts {
  /** Reject content larger than this many decoded bytes. */
  maxBytes?: number;
}

/**
 * The unified provider contract. Every provider package (gmail, outlook, imap)
 * implements exactly this; nothing above this layer knows which provider it
 * is talking to.
 */
export interface EmailProvider {
  readonly capabilities: Capabilities;

  /** Cheap connectivity + auth check. Throws EmailError('auth_expired') on bad credentials. */
  testConnection(): Promise<void>;

  /** Discover provider-managed sender identities. Optional for custom providers. */
  listSendAs?(): Promise<SendAsIdentity[]>;

  /** Metadata-level listing (no bodies). */
  listMessages(q: EmailQuery, page?: PageOpts): Promise<MessageSearchPage>;
  /** Full message including body and attachment metadata. */
  getMessage(id: string, opts?: GetMessageOpts): Promise<Message>;
  getThread(threadId: string): Promise<Thread>;
  listFolders(): Promise<Folder[]>;
  /** Many-to-many tags: Gmail user labels or Outlook categories. */
  listLabels(): Promise<Label[]>;

  createDraft(d: DraftInput): Promise<Message>;
  /** Fetch a draft by draft id (message with draftId populated). */
  getDraft(draftId: string): Promise<Message>;
  updateDraft(draftId: string, d: DraftInput): Promise<Message>;
  deleteDraft(draftId: string): Promise<void>;
  send(input: DraftInput | { draftId: string }): Promise<SendResult>;

  modify(ids: string[], action: ModifyAction): Promise<void>;

  /**
   * Mark a message answered after a reply, or forwarded after a forward, so mail apps show it. Only
   * providers with these flags, such as IMAP, implement it.
   */
  markReplied?(messageId: string, action: 'reply' | 'forward'): Promise<void>;

  getAttachment(
    messageId: string,
    attachmentId: string,
    opts?: GetAttachmentOpts,
  ): Promise<{ meta: AttachmentMeta; content: Buffer }>;
}
