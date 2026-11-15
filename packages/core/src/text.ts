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

/**
 * A folder or label name in one Unicode form, for comparing names a person or agent typed with
 * names a provider stores. An accented letter such as "é" can be one character or a letter followed
 * by a combining accent. Apple Mail stores the second form while most clients send the first, so
 * the same name would otherwise fail to match. Pass `ignoreCase` where the provider ignores case.
 */
export function folderNameKey(name: string, ignoreCase = false): string {
  const composed = name.normalize('NFC');
  return ignoreCase ? composed.toLowerCase() : composed;
}

/**
 * The item whose name matches a requested folder or label name. An exact match wins, so an account
 * that keeps two spellings of a name as separate folders still gets the one asked for. Otherwise
 * names are compared with `folderNameKey`.
 */
export function findByFolderName<T>(
  items: readonly T[],
  name: string,
  nameOf: (item: T) => string | null | undefined,
  ignoreCase = false,
): T | undefined {
  const exact = items.find((item) => nameOf(item) === name);
  if (exact !== undefined) return exact;
  const key = folderNameKey(name, ignoreCase);
  return items.find((item) => {
    const itemName = nameOf(item);
    return typeof itemName === 'string' && folderNameKey(itemName, ignoreCase) === key;
  });
}
