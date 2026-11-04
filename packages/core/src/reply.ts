import { sanitizeQuotedHtml } from './quotedHtml.js';
import { htmlToReadableText } from './searchContext.js';
import type { AttachmentInput, AttachmentMeta, EmailAddress, Message, MessageBody, SendAsIdentity } from './types.js';

export interface ReplyRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
}

function sameAddress(a: EmailAddress, b: EmailAddress): boolean {
  return a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
}

function dedupe(addrs: EmailAddress[]): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const a of addrs) {
    if (!a.email) continue;
    if (!out.some((b) => sameAddress(a, b))) out.push(a);
  }
  return out;
}

/**
 * Compute reply / reply-all recipients from the original message. Provider-agnostic:
 * reply targets Reply-To (falling back to From); reply-all additionally includes the
 * original To/Cc, minus the replying account's own address.
 */
export function computeReplyRecipients(
  original: Message,
  ownAddresses: string | string[],
  replyAll: boolean,
): ReplyRecipients {
  const owned = (Array.isArray(ownAddresses) ? ownAddresses : [ownAddresses]).map((email) => ({ email }));
  const self = owned[0]!;
  const isOwned = (address: EmailAddress) => owned.some((candidate) => sameAddress(address, candidate));
  const replyTarget = original.replyTo?.length ? original.replyTo : original.from ? [original.from] : [];

  if (!replyAll) {
    const to = dedupe(replyTarget).filter((a) => !isOwned(a));
    // Replying to yourself (e.g. a note in Sent): fall back to the original To.
    return { to: to.length ? to : dedupe(original.to), cc: [] };
  }

  const to = dedupe([...replyTarget, ...original.to]).filter((a) => !isOwned(a));
  const cc = dedupe(original.cc ?? []).filter((a) => !isOwned(a) && !to.some((b) => sameAddress(a, b)));
  return { to: to.length ? to : [self], cc };
}

/** "Re: subject" without stacking prefixes. */
export function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** "Fwd: subject" without stacking prefixes. */
export function forwardSubject(subject: string): string {
  return /^\s*fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function formatAddressList(addrs: EmailAddress[] | undefined): string {
  return (addrs ?? []).map(formatAddress).join(', ');
}

/**
 * The sender for a reply with no explicit `from`: the identity the original came from or was
 * addressed to, falling back to the primary identity.
 */
export function selectReplySender(original: Message, identities: SendAsIdentity[]): SendAsIdentity {
  const byEmail = new Map(identities.map((identity) => [identity.email.toLowerCase(), identity]));
  const originalSender = original.from ? byEmail.get(original.from.email.toLowerCase()) : undefined;
  if (originalSender) return originalSender;
  for (const recipient of [...original.to, ...(original.cc ?? [])]) {
    const match = byEmail.get(recipient.email.toLowerCase());
    if (match) return match;
  }
  return identities.find((identity) => identity.isPrimary) ?? identities[0]!;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An address as Gmail writes it in a forwarded message's header: "Ann <ann@example.com>" or "<ann@example.com>". */
function headerAddress(address: EmailAddress): string {
  return address.name ? `${address.name} <${address.email}>` : `<${address.email}>`;
}

export interface ForwardBodyOptions {
  /** IANA time zone for the forwarded message's date. Defaults to UTC. */
  timeZone?: string;
}

/**
 * The body of a forward, as Gmail writes one: an optional comment, a "Forwarded message" header
 * with the original's sender, date, subject and recipients, then the original's text and sanitized
 * HTML.
 */
export function buildForwardBody(
  original: Message,
  comment?: string,
  options: ForwardBodyOptions = {},
): { text?: string; html?: string } {
  const list = (addresses: EmailAddress[]) => addresses.map(headerAddress).join(', ');
  const from = original.from;
  const fields: [string, string][] = [
    ['From', from ? headerAddress(from) : '(unknown sender)'],
    ['Date', replyDate(original, options.timeZone)],
    ['Subject', original.subject],
    ['To', list(original.to)],
    ...(original.cc?.length ? [['Cc', list(original.cc)] as [string, string]] : []),
  ];
  const divider = '---------- Forwarded message ---------';

  const body: { text?: string; html?: string } = {};
  const originalText = original.body?.text;
  const originalHtml = original.body?.html;
  if (originalText !== undefined || originalHtml === undefined) {
    const header = [divider, ...fields.map(([name, value]) => `${name}: ${value}`)].join('\n');
    body.text = [comment, header, originalText ?? '']
      .filter((part) => part !== undefined)
      .join('\n\n')
      .trimEnd();
  }
  if (originalHtml !== undefined) {
    // Gmail shows the sender's name in bold.
    const htmlValue = (name: string, value: string) =>
      name === 'From' && from?.name
        ? `<strong>${escapeHtml(from.name)}</strong> ${escapeHtml(`<${from.email}>`)}`
        : escapeHtml(value);
    const header = [divider, ...fields.map(([name, value]) => `${name}: ${htmlValue(name, value)}`)].join('<br>');
    body.html =
      (comment ? `<p>${escapeHtml(comment)}</p>` : '') +
      `<div class="fluxmail_forward"><div>${header}</div><br>${sanitizeQuotedHtml(originalHtml) ?? textAsHtml(originalText ?? readableText(originalHtml))}</div>`;
  }
  return body;
}

/** Whether `timeZone` is an IANA time zone name the runtime can format dates in. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Zones that are UTC under another name. The line says "UTC" for them, as it does when no zone is set.
const UTC_ZONES = /^(?:Etc\/)?(?:UTC|UCT|Universal|Zulu|Greenwich|GMT(?:[+-]?0)?)$/i;

/**
 * "Tue, Nov 3, 2026 at 10:26 PM" in the reader's time zone, as Gmail writes it. In UTC, or without a
 * usable time zone, the time is in UTC and says so.
 */
function replyDate(original: Message, timeZone: string | undefined): string {
  const date = new Date(original.date);
  if (Number.isNaN(date.getTime())) return original.date;
  const zone = timeZone && isValidTimeZone(timeZone) && !UTC_ZONES.test(timeZone) ? timeZone : undefined;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone ?? 'UTC',
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return (
    `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year} at ` +
    `${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}${zone ? '' : ' UTC'}`
  );
}

function senderLabel(original: Message): string {
  return original.from ? formatAddress(original.from) : '(unknown sender)';
}

function quoteText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function readableText(html: string): string {
  return htmlToReadableText(html)
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n');
}

function textAsHtml(text: string): string {
  return escapeHtml(text.replace(/\r\n?/g, '\n').trim()).replace(/\n/g, '<br>');
}

/** The first `length` characters of `text`, without splitting a surrogate pair, marked as cut. */
function truncated(text: string, length: number): string {
  const end = /[\ud800-\udbff]/.test(text.charAt(length - 1)) ? length - 1 : length;
  return `${text.slice(0, end).trimEnd()}\n…`;
}

// Marks the quote Fluxmail adds, so a later update replaces it instead of adding another.
const QUOTE_CLASS = 'fluxmail_quote';
const QUOTE_START = new RegExp(`<div class="${QUOTE_CLASS}"`, 'i');

/** Where the quote element that opens at `start` ends, counting nested divs, or -1 if it never closes. */
function quoteEnd(html: string, start: number): number {
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return tags.lastIndex;
  }
  return -1;
}

interface EarlierQuote {
  /** The reply with the earlier quote taken out. */
  reply: MessageBody;
  /** Where the earlier quote was in each part, so the new one takes its place. */
  htmlAt?: number;
  textAt?: number;
}

/**
 * The reply without the quotes of this original that Fluxmail added earlier, for example to a draft
 * being edited. Anything the user wrote after a quote stays.
 */
function withoutEarlierQuote(original: Message, body: MessageBody): EarlierQuote {
  const result: EarlierQuote = { reply: { ...body } };
  let html = body.html;
  for (
    let start = html?.search(QUOTE_START) ?? -1;
    html !== undefined && start !== -1;
    start = html.search(QUOTE_START)
  ) {
    const end = quoteEnd(html, start);
    // An edit that broke the quote's markup leaves no way to tell where it ends, so the rest goes with it.
    const after = end === -1 ? (/<\/body\s*>[\s\S]*$/i.exec(html.slice(start))?.[0] ?? '') : html.slice(end);
    const before = html.slice(0, start).replace(/(?:<br\s*\/?>\s*)+$/i, '');
    html = before + after;
    result.htmlAt ??= before.length;
  }
  if (html !== undefined) result.reply.html = html;

  if (body.text !== undefined) {
    const lines = body.text.split(/\r?\n/);
    const ending = ` ${senderLabel(original)} wrote:`;
    let removedAt: number | undefined;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.startsWith('On ') || !line.endsWith(ending) || !lines[index + 1]?.startsWith('>')) continue;
      let end = index + 1;
      while (lines[end]?.startsWith('>')) end++;
      const start = lines[index - 1] === '' ? index - 1 : index;
      lines.splice(start, end - start);
      removedAt ??= start;
      index = start - 1;
    }
    if (removedAt !== undefined) {
      const before = lines.slice(0, removedAt).join('\n').trimEnd();
      const after = lines.slice(removedAt);
      result.reply.text = after.length ? `${before}\n${after.join('\n')}` : before;
      result.textAt = before.length;
    }
  }
  return result;
}

/** `html` with `addition` at `at`, or at the end of the document's body. */
function insertHtml(html: string, addition: string, at?: number): string {
  const lastClose = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  const position = at ?? (lastClose === -1 ? html.length : lastClose);
  const content = html.slice(0, position);
  // A closing paragraph already ends with a blank line's margin, as in Gmail's replies.
  const gap = /<\/(?:p|ul|ol|h[1-6]|pre|blockquote)>\s*$/i.test(content) ? '' : '<br>';
  return `${content}${gap}${addition}${html.slice(position)}`;
}

export interface ReplyBodyOptions {
  /** Whether a quoted body is within the caller's size limits. */
  fits?: (body: MessageBody) => boolean;
  /** IANA time zone for the date in the "wrote:" line. Defaults to UTC. */
  timeZone?: string;
}

/**
 * The body of a reply: the new content, then an "On <date> <sender> wrote:" line, as Gmail writes it,
 * and the quoted original. Only the parts the reply has are quoted, and a quote of the same original
 * that Fluxmail added earlier is replaced. The original's HTML is sanitized first. If the quote is
 * too large, the HTML part quotes the original's text instead, then the text is shortened; if even a
 * short quote doesn't fit, the body is returned unquoted.
 */
export function buildReplyBody(original: Message, body: MessageBody, options: ReplyBodyOptions = {}): MessageBody {
  const { reply, htmlAt, textAt } = withoutEarlierQuote(original, body);
  const originalHtml = original.body?.html?.trim() ? sanitizeQuotedHtml(original.body.html) : undefined;
  const originalText = original.body?.text?.trim()
    ? original.body.text
    : original.body?.html === undefined
      ? ''
      : readableText(original.body.html);
  const hasText = originalText.trim() !== '';
  // An image-only original, such as a scanned receipt, can still be quoted in an HTML reply.
  const quotesHtmlOnly = !hasText && reply.html !== undefined && /<img\b/i.test(originalHtml ?? '');
  if (!hasText && !quotesHtmlOnly) return reply;
  const header = `On ${replyDate(original, options.timeZone)} ${senderLabel(original)} wrote:`;
  const withQuote = (quotedText: string, quotedHtml: string): MessageBody => {
    const quoted: MessageBody = {};
    if (reply.text !== undefined || reply.html === undefined) {
      if (!hasText) quoted.text = reply.text;
      else {
        const text = reply.text ?? '';
        const at = textAt ?? text.length;
        quoted.text =
          `${text.slice(0, at).trimEnd()}\n\n${header}\n${quoteText(quotedText)}${text.slice(at)}`.trimStart();
      }
    }
    if (reply.html !== undefined) {
      quoted.html = insertHtml(
        reply.html,
        `<div class="${QUOTE_CLASS}"><div>${escapeHtml(header)}</div>` +
          `<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${quotedHtml}</blockquote></div>`,
        htmlAt,
      );
    }
    return quoted;
  };
  const fits = (candidate: MessageBody) => options.fits?.(candidate) ?? true;
  const full = withQuote(originalText, originalHtml ?? textAsHtml(originalText));
  if (fits(full)) return full;
  if (!hasText) return reply;
  if (reply.html !== undefined && originalHtml !== undefined) {
    const plain = withQuote(originalText, textAsHtml(originalText));
    if (fits(plain)) return plain;
  }
  for (let length = Math.floor(originalText.length / 2); length >= 200; length = Math.floor(length / 2)) {
    const short = truncated(originalText, length);
    const candidate = withQuote(short, textAsHtml(short));
    if (fits(candidate)) return candidate;
  }
  return reply;
}

export interface QuotedImageOptions {
  /** Attachments the message already has. An image with the same Content-ID isn't added again. */
  attachments?: AttachmentInput[];
  /** Most attachments the message may have in total. */
  maxCount: number;
  /** Most decoded attachment bytes the message may have in total. */
  maxBytes: number;
  /** The attachment's content, or undefined to leave it out, for example because it is over `maxBytes`. */
  download: (attachment: AttachmentMeta, maxBytes: number) => Promise<Uint8Array | undefined>;
}

/**
 * The original's attachments that `html` shows through cid: references, such as images embedded in a
 * quoted or forwarded message, ready to send with it. Without them those images show as missing.
 * An image that would go over the limits is left out, so the message still goes out.
 */
export async function quotedImages(
  original: Message,
  html: string | undefined,
  options: QuotedImageOptions,
): Promise<AttachmentInput[]> {
  if (!html) return [];
  const referenced = new Set([...html.matchAll(/\bcid:([^"'\s>)]+)/gi)].map((match) => match[1]!));
  const existing = options.attachments ?? [];
  const present = new Set(existing.map((attachment) => attachment.contentId).filter(Boolean));
  let count = existing.length;
  let bytes = existing.reduce((total, attachment) => total + Buffer.byteLength(attachment.content, 'base64'), 0);
  const images: AttachmentInput[] = [];
  for (const attachment of original.attachments ?? []) {
    const contentId = attachment.contentId;
    if (!contentId || !referenced.has(contentId) || present.has(contentId)) continue;
    if (count >= options.maxCount || bytes + attachment.sizeBytes > options.maxBytes) continue;
    const content = await options.download(attachment, options.maxBytes - bytes);
    if (!content || bytes + content.byteLength > options.maxBytes) continue;
    present.add(contentId);
    count++;
    bytes += content.byteLength;
    images.push({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      content: Buffer.from(content).toString('base64'),
      contentId,
      disposition: 'inline',
    });
  }
  return images;
}
