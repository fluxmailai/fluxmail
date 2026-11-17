export interface GraphEmailAddress {
  name?: string | null;
  address?: string | null;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress | null;
}

export interface GraphItemBody {
  contentType?: 'text' | 'html' | string | null;
  content?: string | null;
}

export interface GraphInternetHeader {
  name?: string | null;
  value?: string | null;
}

export interface GraphAttachment {
  '@odata.type'?: string;
  id?: string | null;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
  contentId?: string | null;
  contentBytes?: string | null;
}

export interface GraphMessage {
  id?: string | null;
  conversationId?: string | null;
  parentFolderId?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  bccRecipients?: GraphRecipient[] | null;
  replyTo?: GraphRecipient[] | null;
  subject?: string | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  createdDateTime?: string | null;
  bodyPreview?: string | null;
  body?: GraphItemBody | null;
  isRead?: boolean | null;
  isDraft?: boolean | null;
  flag?: { flagStatus?: string | null } | null;
  hasAttachments?: boolean | null;
  categories?: string[] | null;
  attachments?: GraphAttachment[] | null;
  internetMessageHeaders?: GraphInternetHeader[] | null;
}

export interface GraphCategory {
  id?: string | null;
  displayName?: string | null;
  color?: string | null;
}

export interface GraphFolder {
  id?: string | null;
  displayName?: string | null;
  parentFolderId?: string | null;
  childFolderCount?: number | null;
  totalItemCount?: number | null;
  unreadItemCount?: number | null;
  isHidden?: boolean | null;
}

export interface GraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}
