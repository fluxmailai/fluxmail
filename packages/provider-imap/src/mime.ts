import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { EmailError, type DraftInput, type EmailAddress } from '@fluxmail/core';

export interface ThreadingHeaders {
  inReplyTo?: string;
  references?: string;
}

function addresses(values: EmailAddress[] | undefined): Mail.Address[] | undefined {
  return values?.map(({ name, email }) => ({ name: name ?? '', address: email }));
}

const SLICE_CHARS = 64 * 1024;

/**
 * Decodes attachment content. Nodemailer base64-encodes and wraps a Buffer whole but a stream one
 * chunk at a time, so the content goes in as a stream that decodes 64 KiB of base64 at a time. A
 * message/* attachment stays a Buffer, because Nodemailer labels it 7bit only when it can scan a
 * Buffer. So does one without a type, which Nodemailer guesses from the filename.
 */
function attachmentContent(value: string, mimeType: string): Buffer | Readable {
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new EmailError('invalid_request', 'Attachment content must be valid base64');
  }
  if (!mimeType || /^message\//i.test(mimeType)) return Buffer.from(compact, 'base64');
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < compact.length; offset += SLICE_CHARS) {
        yield Buffer.from(compact.slice(offset, offset + SLICE_CHARS), 'base64');
      }
    })(),
    { objectMode: false },
  );
}

export async function composeMessage(
  input: DraftInput,
  from: EmailAddress,
  threading?: ThreadingHeaders,
): Promise<Buffer> {
  const options: Mail.Options = {
    from: { name: from.name ?? '', address: from.email },
    to: addresses(input.to),
    cc: addresses(input.cc),
    bcc: addresses(input.bcc),
    subject: input.subject ?? '',
    text: input.body.text,
    html: input.body.html,
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      content: attachmentContent(attachment.content, attachment.mimeType),
      contentType: attachment.mimeType,
      ...(attachment.contentId ? { cid: attachment.contentId } : {}),
      ...(attachment.disposition ? { contentDisposition: attachment.disposition } : {}),
    })),
    ...(threading?.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
    ...(threading?.references ? { references: threading.references } : {}),
  };
  const compiled = new MailComposer(options).compile();
  compiled.keepBcc = true;
  // IMAP APPEND and SMTP require CRLF. Without this, Nodemailer keeps bare LF from body text.
  compiled.newline = 'windows';
  return new Promise((resolve, reject) => {
    compiled.build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

export function stripBccHeader(raw: Buffer): Buffer {
  const source = raw.toString('binary');
  const split = source.indexOf('\r\n\r\n');
  if (split === -1) return raw;
  const headers = source.slice(0, split).split('\r\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of headers) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^bcc:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return Buffer.from(`${kept.join('\r\n')}\r\n\r\n${source.slice(split + 4)}`, 'binary');
}
