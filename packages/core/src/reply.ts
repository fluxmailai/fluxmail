import type { EmailAddress, Message, SendAsIdentity } from './types.js';

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
      `<p>${escapedHeader}</p><blockquote style="border-left:1px solid #ccc;padding-left:1ex;margin:0 0 0 0.8ex">${originalHtml}</blockquote>`;
  }
  return body;
}
