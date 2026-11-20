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

/** Bytes of a message, or characters of base64, that go to Nodemailer at a time. */
const SLICE_SIZE = 64 * 1024;

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
      for (let offset = 0; offset < compact.length; offset += SLICE_SIZE) {
        yield Buffer.from(compact.slice(offset, offset + SLICE_SIZE), 'base64');
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

/**
 * The header section without Bcc lines, and where the body starts. Headers end at the first blank
 * line, with CRLF or LF line endings. A message without a blank line is all headers.
 */
function headersWithoutBcc(raw: Buffer): { headers: Buffer; bodyStart: number } {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
  const end = useCrlf ? crlf : lf;
  const eol = useCrlf || (end === -1 && raw.includes('\r\n')) ? '\r\n' : '\n';
  const kept: string[] = [];
  let skipping = false;
  for (const line of raw.toString('binary', 0, end === -1 ? raw.length : end).split(eol)) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^bcc:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return end === -1
    ? { headers: Buffer.from(kept.join(eol), 'binary'), bodyStart: raw.length }
    : { headers: Buffer.from(kept.join(eol) + eol + eol, 'binary'), bodyStart: end + eol.length * 2 };
}

/**
 * The message without Bcc headers, for SMTP delivery. The body is read in 64 KiB slices of the
 * original Buffer. Given the whole message as one chunk, Nodemailer copies all of it when a line
 * needs dot-stuffing.
 */
export function deliveryStream(raw: Buffer): Readable {
  const stripped = headersWithoutBcc(raw);
  return Readable.from(
    (function* () {
      if (stripped.headers.length) yield stripped.headers;
      for (let offset = stripped.bodyStart; offset < raw.length; offset += SLICE_SIZE) {
        yield raw.subarray(offset, offset + SLICE_SIZE);
      }
    })(),
    { objectMode: false },
  );
}
