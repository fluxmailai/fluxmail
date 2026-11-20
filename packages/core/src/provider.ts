import type {
  AttachmentMeta,
  Capabilities,
  DraftInput,
  EmailQuery,
  Folder,
  RenamedFolder,
  Label,
  Message,
  MessageSearchPage,
  ModifyAction,
  PageOpts,
  SendResult,
  SendAsIdentity,
  Thread,
  ThreadOpts,
} from './types.js';

export interface GetMessageOpts {
  /** Include selected RFC 5322 headers (Message-ID, References, ...). */
  includeHeaders?: boolean;
}

export interface GetAttachmentOpts {
  /** Reject content larger than this many decoded bytes. */
  maxBytes?: number;
}

export interface GetAttachmentStreamOpts extends GetAttachmentOpts {
  /** Stops the download, including a stream a caller is still reading. */
  signal?: AbortSignal;
}

/** An attachment's metadata with its decoded content as a stream. */
export interface AttachmentStream {
  meta: AttachmentMeta;
  /**
   * The exact number of bytes the stream yields, when the provider reports it before the content. The stream fails
   * if the content turns out to differ.
   */
  byteLength?: number;
  /**
   * The decoded content. Read it to the end or cancel it: the adapter holds its connection, and for IMAP the
   * folder, until then. It fails with the same size error as getAttachment once it passes maxBytes.
   */
  content: ReadableStream<Uint8Array>;
}

/** A file added to a saved draft from a stream. */
export interface DraftAttachmentUpload {
  filename: string;
  mimeType: string;
  /** Read once, from start to end. A caller that limits the file's size does so in this stream. */
  content: ReadableStream<Uint8Array>;
  /** The file's size in bytes. Outlook needs it to start an upload. */
  byteLength: number;
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

  /**
   * The display name a new message will carry in its From header when sent from this address, or from
   * the account's default sender when omitted. It uses the same logic as send, so a preview shows the name
   * the message gets. Resolves undefined when the message carries no name, or when the provider can't tell
   * which name will apply: the mail service sets it, or a lookup failed and a later send may find another.
   * It may reject; callers show no name then. A saved draft keeps the name it was stored with instead.
   */
  senderName?(from?: string): Promise<string | undefined>;

  /** Metadata-level listing (no bodies). */
  listMessages(q: EmailQuery, page?: PageOpts): Promise<MessageSearchPage>;
  /** Full message including body and attachment metadata. */
  getMessage(id: string, opts?: GetMessageOpts): Promise<Message>;
  getThread(threadId: string, opts?: ThreadOpts): Promise<Thread>;
  listFolders(): Promise<Folder[]>;
  /**
   * Create a folder, or a subfolder when the name is a path written the way listFolders writes it, and any
   * missing parent folders. Returns the existing folder when one already has the name. Rejects names a provider
   * can't represent, and names of system folders, with invalid_request. Optional for custom providers; callers
   * report unsupported_capability when it is missing.
   */
  createFolder?(name: string): Promise<Folder>;
  /**
   * Delete an empty folder, given its ID from listFolders or its name, and return the folder as it was listed.
   * Refuses, with a FolderNameError and without changing anything, a folder that holds messages or subfolders,
   * a system folder, and a folder a setting relies on. A folder that doesn't exist is not_found. Optional for
   * custom providers; callers report unsupported_capability when it is missing.
   */
  deleteFolder?(folder: string): Promise<Folder>;
  /**
   * Rename a folder, given its ID from listFolders or its name, and return it as it is listed now with the folder
   * as it was listed before. The new name is the folder's own name, without its parent path: the folder stays
   * under the same parent, and its subfolders and messages stay in it. Refuses, with a FolderNameError and without
   * changing anything, a system folder, a folder a setting relies on, and a name another folder has. A folder that
   * doesn't exist is not_found. Optional for custom providers; callers report unsupported_capability when it is
   * missing.
   */
  renameFolder?(folder: string, name: string): Promise<RenamedFolder>;
  /**
   * Move a folder, given its ID from listFolders or its name, under another folder, or to the top level when
   * `parent` is null, and return it as it is listed now with the folder as it was listed before. The folder keeps
   * its own name, its subfolders and its messages. Refuses, with a FolderNameError and without changing anything,
   * a system folder, a folder a setting relies on, a destination inside the folder itself or in the trash, and a
   * destination that already has a folder with the same name. A folder or destination that doesn't exist is
   * not_found. Optional for custom providers; callers report unsupported_capability when it is missing.
   */
  moveFolder?(folder: string, parent: string | null): Promise<RenamedFolder>;
  /** Many-to-many tags: Gmail user labels or Outlook categories. */
  listLabels(): Promise<Label[]>;
  /**
   * Create a label, such as a Gmail label or an Outlook category, and return it as listLabels lists it. Returns
   * the existing label when one already has the name. Rejects names the provider can't use with a FolderNameError.
   * Optional for custom providers and mailboxes without labels; callers report unsupported_capability when it is
   * missing.
   */
  createLabel?(name: string): Promise<Label>;
  /**
   * Delete a label, given its ID from listLabels or its name, and return it as it was listed. A label that doesn't
   * exist is a LabelNotFoundError. Refuses a system label, and a Gmail label with nested labels, with a
   * FolderNameError. Optional like createLabel.
   */
  deleteLabel?(label: string): Promise<Label>;

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

  /** The id of the message a draft replies to, when the provider can tell, so sending it can mark that message. */
  findRepliedMessage?(draftId: string): Promise<string | undefined>;

  getAttachment(
    messageId: string,
    attachmentId: string,
    opts?: GetAttachmentOpts,
  ): Promise<{ meta: AttachmentMeta; content: Buffer }>;

  /**
   * Like getAttachment, but returns the content as a stream so a caller can pass it on without holding it. Rejects
   * before the stream starts when the metadata already shows the attachment is over maxBytes. Optional for custom
   * providers; callers use getAttachment when it is missing.
   */
  getAttachmentStream?(
    messageId: string,
    attachmentId: string,
    opts?: GetAttachmentStreamOpts,
  ): Promise<AttachmentStream>;

  /**
   * Add one attachment to a saved draft and return the draft. The draft keeps its ID, recipients, body, threading
   * and other attachments. Optional for custom providers; callers report unsupported_capability when it is missing.
   */
  addDraftAttachment?(draftId: string, attachment: DraftAttachmentUpload): Promise<Message>;
}
