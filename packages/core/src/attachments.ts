const MIME_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/;

/** A filename safe for a download: control, path and reserved characters become underscores. */
export function safeAttachmentFilename(filename: string): string {
  let safe = '';
  for (const character of filename) {
    const code = character.charCodeAt(0);
    // encodeURIComponent throws on an unpaired surrogate, so replace it too.
    const unpaired = character.length === 1 && code >= 0xd800 && code <= 0xdfff;
    safe += code < 32 || code === 127 || unpaired || '/\\:*?"<>|'.includes(character) ? '_' : character;
  }
  return safe || 'attachment';
}

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Response headers for downloading an attachment's decoded content. */
export function attachmentDownloadHeaders(attachment: {
  filename: string;
  mimeType: string;
  byteLength: number;
}): Record<string, string> {
  const name = safeAttachmentFilename(attachment.filename);
  return {
    'content-type': MIME_TYPE_PATTERN.test(attachment.mimeType) ? attachment.mimeType : 'application/octet-stream',
    'content-length': String(attachment.byteLength),
    'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeContentDispositionFilename(name)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}
