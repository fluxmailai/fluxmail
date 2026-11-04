import { sanitizeQuotedHtml } from './quotedHtml.js';
import { htmlToReadableText } from './searchContext.js';
import type { EmailAddress, Message, MessageBody, SendAsIdentity } from './types.js';

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

/** The body of a forward: an optional comment, the original's headers, then its text and HTML. */
export function buildForwardBody(original: Message, comment?: string): { text?: string; html?: string } {
  const headerLines = [
    '---------- Forwarded message ----------',
    `From: ${original.from ? formatAddressList([original.from]) : '(unknown)'}`,
    `Date: ${original.date}`,
    `Subject: ${original.subject}`,
    `To: ${formatAddressList(original.to)}`,
    ...(original.cc?.length ? [`Cc: ${formatAddressList(original.cc)}`] : []),
  ].join('\n');

  const body: { text?: string; html?: string } = {};
  const originalText = original.body?.text;
  const originalHtml = original.body?.html;

  if (originalText !== undefined || originalHtml === undefined) {
    body.text = [comment, headerLines, '', originalText ?? ''].filter((x) => x !== undefined).join('\n\n');
  }
  if (originalHtml !== undefined) {
    const escapedHeader = escapeHtml(headerLines).replace(/\n/g, '<br>');
    body.html =
      (comment ? `<p>${escapeHtml(comment)}</p>` : '') +
      `<p>${escapedHeader}</p><blockquote style="border-left:1px solid #ccc;padding-left:1ex;margin:0 0 0 0.8ex">${sanitizeQuotedHtml(originalHtml)}</blockquote>`;
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

/** The reply without a quote of this original that Fluxmail added earlier, for example to a draft being edited. */
function withoutEarlierQuote(original: Message, body: MessageBody): MessageBody {
  const result: MessageBody = { ...body };
  if (body.html !== undefined) {
    const start = body.html.search(QUOTE_START);
    if (start !== -1) {
      const closing = /<\/body\s*>[\s\S]*$/i.exec(body.html.slice(start))?.[0] ?? '';
      result.html = body.html.slice(0, start).replace(/(?:<br\s*\/?>\s*)+$/i, '') + closing;
    }
  }
  if (body.text !== undefined) {
    const lines = body.text.split(/\r?\n/);
    const ending = ` ${senderLabel(original)} wrote:`;
    let end = lines.length;
    for (;;) {
      // Step back over the quoted lines, then check for the "wrote:" line above them.
      let index = end;
      while (index > 0 && (lines[index - 1] === '' || lines[index - 1]!.startsWith('>'))) index--;
      const line = lines[index - 1];
      if (index === end || line === undefined || !line.startsWith('On ') || !line.endsWith(ending)) break;
      end = index - 1;
    }
    if (end < lines.length) result.text = lines.slice(0, end).join('\n').trimEnd();
  }
  return result;
}

function appendHtml(html: string, addition: string): string {
  const close = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  const content = close === -1 ? html : html.slice(0, close);
  // A closing paragraph already ends with a blank line's margin, as in Gmail's replies.
  const gap = /<\/(?:p|ul|ol|h[1-6]|pre|blockquote)>\s*$/i.test(content) ? '' : '<br>';
  return `${content}${gap}${addition}${close === -1 ? '' : html.slice(close)}`;
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
  const reply = withoutEarlierQuote(original, body);
  const originalHtml = original.body?.html?.trim() ? original.body.html : undefined;
  const originalText = original.body?.text?.trim()
    ? original.body.text
    : originalHtml === undefined
      ? ''
      : readableText(originalHtml);
  if (!originalText.trim()) return reply;
  const header = `On ${replyDate(original, options.timeZone)} ${senderLabel(original)} wrote:`;
  const withQuote = (quotedText: string, quotedHtml: string): MessageBody => {
    const quoted: MessageBody = {};
    if (reply.text !== undefined || reply.html === undefined) {
      quoted.text = `${reply.text ?? ''}\n\n${header}\n${quoteText(quotedText)}`.trimStart();
    }
    if (reply.html !== undefined) {
      quoted.html = appendHtml(
        reply.html,
        `<div class="${QUOTE_CLASS}"><div>${escapeHtml(header)}</div>` +
          `<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${quotedHtml}</blockquote></div>`,
      );
    }
    return quoted;
  };
  const fits = (candidate: MessageBody) => options.fits?.(candidate) ?? true;
  const full = withQuote(
    originalText,
    originalHtml === undefined ? textAsHtml(originalText) : sanitizeQuotedHtml(originalHtml),
  );
  if (fits(full)) return full;
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
