import type { gmail_v1 } from 'googleapis';
import iconv from 'iconv-lite';
import {
  parseAddressList,
  type AttachmentMeta,
  type Folder,
  type FolderRole,
  type Message,
  type MessageBody,
} from '@fluxmail/core';

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data, 'base64url');
}

export function encodeBase64Url(data: Buffer): string {
  return data.toString('base64url');
}

function headerValue(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string | undefined {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export function decodeTextPart(part: gmail_v1.Schema$MessagePart, encoded = part.body?.data ?? ''): string {
  const data = decodeBase64Url(encoded);
  // Gmail returns text parts as UTF-8 but keeps the sender's charset header, so a part labeled
  // iso-8859-1 can hold UTF-8 bytes. Legacy 8-bit text is almost never valid UTF-8.
  if (data.some((byte) => byte >= 0x80)) {
    try {
      return strictUtf8.decode(data);
    } catch {
      // Not UTF-8; fall back to the declared charset.
    }
  }
  const contentType = headerValue(part, 'Content-Type') ?? '';
  const charset = contentType.match(/charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  const encoding = charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? 'utf-8';
  return iconv.decode(data, iconv.encodingExists(encoding) ? encoding : 'utf-8');
}

type BodyField = 'text' | 'html';

export interface ExternalBodyPart {
  attachmentId: string;
  part: gmail_v1.Schema$MessagePart;
}

export type ExternalBodyParts = Partial<Record<BodyField, ExternalBodyPart>>;

interface WalkedParts {
  body: MessageBody;
  attachments: AttachmentMeta[];
  externalBodyParts: ExternalBodyParts;
}

interface ParsedAttachment {
  meta: AttachmentMeta;
  content?: Buffer;
  /** Gmail's opaque ID from the current message response. */
  providerAttachmentId?: string;
}

function parseAttachment(part: gmail_v1.Schema$MessagePart, path: number[]): ParsedAttachment | undefined {
  const body = part.body;
  const rawContentId = headerValue(part, 'Content-ID')?.trim();
  const contentId = rawContentId?.replace(/^<|>$/g, '');
  const rawDisposition = headerValue(part, 'Content-Disposition')?.split(';', 1)[0]?.trim().toLowerCase();
  const isMessageBody = part.mimeType === 'text/plain' || part.mimeType === 'text/html';
  const hasContent = body?.attachmentId != null || body?.data != null;
  const isAttachment =
    !!part.filename ||
    rawDisposition === 'attachment' ||
    (!isMessageBody &&
      !part.mimeType?.startsWith('multipart/') &&
      (hasContent || !!contentId || rawDisposition === 'inline'));
  if (!isAttachment) return undefined;

  const disposition: AttachmentMeta['disposition'] =
    rawDisposition === 'inline' || rawDisposition === 'attachment' ? rawDisposition : contentId ? 'inline' : undefined;
  const metadata = {
    ...(contentId ? { contentId } : {}),
    ...(disposition ? { disposition } : {}),
  };
  const fallbackId = part.partId ?? path.join('.');
  const filename = part.filename || `${disposition === 'inline' ? 'inline' : 'attachment'}-${fallbackId}`;
  if (body?.attachmentId) {
    return {
      meta: {
        id: `part:${fallbackId}`,
        filename,
        mimeType: part.mimeType ?? '',
        sizeBytes: body.size ?? 0,
        ...metadata,
      },
      providerAttachmentId: body.attachmentId,
    };
  }
  if (body?.data != null) {
    const content = decodeBase64Url(body.data);
    return {
      meta: {
        id: `inline:${part.partId ?? path.join('.')}`,
        filename,
        mimeType: part.mimeType ?? '',
        sizeBytes: body.size ?? content.length,
        ...metadata,
      },
      content,
    };
  }
  return undefined;
}

/** Walk the MIME tree collecting the preferred text/html bodies and attachment metadata. */
export function walkParts(payload: gmail_v1.Schema$MessagePart | undefined): WalkedParts {
  const result: WalkedParts = { body: {}, attachments: [], externalBodyParts: {} };
  if (!payload) return result;

  const visit = (part: gmail_v1.Schema$MessagePart, partPath: number[], inAttachedMessage: boolean) => {
    const mimeType = part.mimeType ?? '';
    const attachment = parseAttachment(part, partPath);
    if (attachment) {
      result.attachments.push(attachment.meta);
      return;
    }
    // Text inside an attached message is not the outer body, but its attachments still belong to this message.
    const nested = inAttachedMessage || mimeType === 'message/rfc822';
    const bodyField: BodyField | undefined =
      mimeType === 'text/plain' ? 'text' : mimeType === 'text/html' ? 'html' : undefined;
    if (
      !nested &&
      bodyField &&
      result.body[bodyField] === undefined &&
      result.externalBodyParts[bodyField] === undefined
    ) {
      if (part.body?.data != null) {
        result.body[bodyField] = decodeTextPart(part);
        return;
      }
      if (part.body?.attachmentId) {
        result.externalBodyParts[bodyField] = { attachmentId: part.body.attachmentId, part };
        return;
      }
    }
    for (const [index, child] of (part.parts ?? []).entries()) visit(child, [...partPath, index], nested);
  };
  visit(payload, [0], false);
  return result;
}

export function findAttachment(
  payload: gmail_v1.Schema$MessagePart | undefined,
  attachmentId: string,
): ParsedAttachment | undefined {
  if (!payload) return undefined;

  const visit = (part: gmail_v1.Schema$MessagePart, partPath: number[]): ParsedAttachment | undefined => {
    const attachment = parseAttachment(part, partPath);
    if (attachment?.meta.id === attachmentId || attachment?.providerAttachmentId === attachmentId) return attachment;
    for (const [index, child] of (part.parts ?? []).entries()) {
      const found = visit(child, [...partPath, index]);
      if (found) return found;
    }
    return undefined;
  };
  return visit(payload, [0]);
}

/** System labels that pin a message's canonical location, most specific first. */
const LOCATION_LABEL_ROLES: Array<[string, FolderRole]> = [
  ['TRASH', 'trash'],
  ['SPAM', 'spam'],
  ['DRAFT', 'drafts'],
  ['INBOX', 'inbox'],
  ['SENT', 'sent'],
];

/** Gmail has no archive label: archived mail is whatever carries no location label. */
function deriveFolder(labelIds: string[], labelNames: Map<string, string>): Folder {
  for (const [labelId, role] of LOCATION_LABEL_ROLES) {
    if (labelIds.includes(labelId)) {
      return { id: labelId, name: labelNames.get(labelId) ?? labelId, role };
    }
  }
  return { id: 'archive', name: 'Archive', role: 'archive' };
}

const INTERESTING_HEADERS = ['message-id', 'in-reply-to', 'references', 'list-unsubscribe'];

export interface ParseContext {
  accountId: string;
  /** Gmail label id -> display name, for translating labelIds. */
  labelNames: Map<string, string>;
  includeBody: boolean;
  /** Set only when the Gmail response includes the MIME payload. */
  includeAttachments?: boolean;
  includeHeaders?: boolean;
}

export function parseGmailMessage(msg: gmail_v1.Schema$Message, ctx: ParseContext): Message {
  return parseGmailMessageWithParts(msg, ctx).message;
}

export function parseGmailMessageWithParts(
  msg: gmail_v1.Schema$Message,
  ctx: ParseContext,
): { message: Message; externalBodyParts: ExternalBodyParts } {
  const payload = msg.payload;
  const labelIds = msg.labelIds ?? [];
  const from = parseAddressList(headerValue(payload, 'From'))[0];
  const dateHeader = headerValue(payload, 'Date');
  const dateMs = msg.internalDate ? Number(msg.internalDate) : dateHeader ? Date.parse(dateHeader) : Date.now();

  const message: Message = {
    id: msg.id ?? '',
    threadId: msg.threadId ?? msg.id ?? '',
    accountId: ctx.accountId,
    folder: deriveFolder(labelIds, ctx.labelNames),
    labels: labelIds.filter((id) => !id.startsWith('CATEGORY_')).map((id) => ctx.labelNames.get(id) ?? id),
    to: parseAddressList(headerValue(payload, 'To')),
    subject: headerValue(payload, 'Subject') ?? '',
    date: new Date(dateMs).toISOString(),
    flags: {
      read: !labelIds.includes('UNREAD'),
      starred: labelIds.includes('STARRED'),
      draft: labelIds.includes('DRAFT'),
    },
  };

  if (from) message.from = from;
  const cc = parseAddressList(headerValue(payload, 'Cc'));
  if (cc.length) message.cc = cc;
  const bcc = parseAddressList(headerValue(payload, 'Bcc'));
  if (bcc.length) message.bcc = bcc;
  const replyTo = parseAddressList(headerValue(payload, 'Reply-To'));
  if (replyTo.length) message.replyTo = replyTo;
  if (msg.snippet) message.snippet = msg.snippet;

  let externalBodyParts: ExternalBodyParts = {};
  if (ctx.includeBody || ctx.includeAttachments) {
    const walked = walkParts(payload);
    if (ctx.includeAttachments) message.attachments = walked.attachments;
    if (ctx.includeBody) message.body = walked.body;
    externalBodyParts = walked.externalBodyParts;
  }

  if (ctx.includeHeaders) {
    const headers: Record<string, string> = {};
    for (const h of payload?.headers ?? []) {
      if (h.name && h.value && INTERESTING_HEADERS.includes(h.name.toLowerCase())) {
        headers[h.name] = h.value;
      }
    }
    message.headers = headers;
  }

  return { message, externalBodyParts };
}
