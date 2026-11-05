/**
 * A plain-text body without the line breaks that end it. A message whose only part is plain
 * text ends with the line break that closes the MIME body, and some servers add another when
 * they store it, so those breaks are transport framing rather than text the sender wrote.
 */
export function withoutTrailingLineBreaks(text: string): string {
  // Scans back from the end, so a sender's long run of line breaks before more text stays linear.
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
  return text.slice(0, end);
}
