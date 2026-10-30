import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { EmailError, type DraftInput, type EmailAddress } from '@fluxmail/core';

export interface ThreadingHeaders {
  inReplyTo?: string;
  references?: string;
}

function toMailAddresses(addrs: EmailAddress[] | undefined): Mail.Address[] | undefined {
  if (!addrs?.length) return undefined;
  return addrs.map((a) => ({ name: a.name ?? '', address: a.email }));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Canonical unpadded base64 with whitespace removed. Throws when the content is not valid base64. */
function validatedAttachmentContent(rawContent: string): string {
  // RFC 2045 base64 may be wrapped in whitespace (e.g. `base64` CLI output).
  const content = rawContent.replace(/\s+/g, '');
  if (content === '') return '';
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  const unpadded = padding ? content.slice(0, -padding) : content;
  if (/[^A-Za-z0-9+/]/.test(unpadded) || content.length % 4 === 1 || unpadded.length % 4 === 1) {
    throw new EmailError('invalid_request', 'Attachment content must be valid base64');
  }
  // Unused bits in the last character must be zero, so each content has one encoding.
  const remainder = unpadded.length % 4;
  const lastValue = BASE64_ALPHABET.indexOf(unpadded.at(-1) ?? '');
  if ((remainder === 2 && (lastValue & 15) !== 0) || (remainder === 3 && (lastValue & 3) !== 0)) {
    throw new EmailError('invalid_request', 'Attachment content must be valid base64');
  }
  return unpadded;
}

function decodeAttachmentContent(rawContent: string): Buffer {
  return Buffer.from(validatedAttachmentContent(rawContent), 'base64');
}

/** Decodes 64 KiB of base64 at a time, so the decoded attachment is never held whole. */
function attachmentContentStream(rawContent: string): Readable {
  const content = validatedAttachmentContent(rawContent);
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < content.length; offset += 65536) {
        yield Buffer.from(content.slice(offset, offset + 65536), 'base64');
      }
    })(),
    { objectMode: false },
  );
}

function compileMessage(
  draft: DraftInput,
  from: EmailAddress,
  threading: ThreadingHeaders | undefined,
  replyTo: EmailAddress | undefined,
  streaming: boolean,
) {
  const options: Mail.Options = {
    from: { name: from.name ?? '', address: from.email },
    ...(replyTo ? { replyTo: { name: replyTo.name ?? '', address: replyTo.email } } : {}),
    to: toMailAddresses(draft.to),
    cc: toMailAddresses(draft.cc),
    bcc: toMailAddresses(draft.bcc),
    subject: draft.subject ?? '',
    text: draft.body.text,
    html: draft.body.html,
    attachments: draft.attachments?.map((a) => ({
      filename: a.filename,
      content: streaming ? attachmentContentStream(a.content) : decodeAttachmentContent(a.content),
      contentType: a.mimeType,
      ...(a.contentId ? { cid: a.contentId } : {}),
      ...(a.disposition ? { contentDisposition: a.disposition } : {}),
    })),
  };
  if (threading?.inReplyTo) options.inReplyTo = threading.inReplyTo;
  if (threading?.references) options.references = threading.references;

  const composer = new MailComposer(options);
  const compiled = composer.compile();
  // Gmail derives recipients from the raw headers; without this the Bcc header
  // (which MailComposer strips by default) never reaches Gmail and bcc
  // recipients silently get nothing. Gmail removes it before delivery.
  compiled.keepBcc = true;
  return compiled;
}

/** Stream a raw RFC 5322 message from a DraftInput. */
export function buildRawMessageStream(
  draft: DraftInput,
  from: EmailAddress,
  threading?: ThreadingHeaders,
  replyTo?: EmailAddress,
): Readable {
  return compileMessage(draft, from, threading, replyTo, true).createReadStream();
}

/** Build a raw RFC 5322 message from a DraftInput. */
export async function buildRawMessage(
  draft: DraftInput,
  from: EmailAddress,
  threading?: ThreadingHeaders,
  replyTo?: EmailAddress,
): Promise<Buffer> {
  const compiled = compileMessage(draft, from, threading, replyTo, false);
  return new Promise<Buffer>((resolve, reject) => {
    compiled.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}
