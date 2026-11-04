/**
 * A plain-text body without the line breaks that end it. A message whose only part is plain
 * text ends with the line break that closes the MIME body, and some servers add another when
 * they store it, so those breaks are transport framing rather than text the sender wrote.
 */
export function withoutTrailingLineBreaks(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '');
}
