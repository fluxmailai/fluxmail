import { describe, expect, it } from 'vitest';
import { attachmentDownloadHeaders, safeAttachmentFilename } from '../src/index.js';

describe('attachment downloads', () => {
  it('replaces reserved, control and unpaired surrogate characters', () => {
    expect(safeAttachmentFilename('a/b\\c:"d"\n.txt')).toBe('a_b_c__d__.txt');
    expect(safeAttachmentFilename('bad\ud800.txt')).toBe('bad_.txt');
    expect(safeAttachmentFilename('')).toBe('attachment');
  });

  it('builds download headers with an ASCII fallback name', () => {
    expect(
      attachmentDownloadHeaders({ filename: 'résumé (1).pdf', mimeType: 'application/pdf', byteLength: 3 }),
    ).toEqual({
      'content-type': 'application/pdf',
      'content-length': '3',
      'content-disposition': `attachment; filename="r_sum_ (1).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.pdf`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(
      attachmentDownloadHeaders({ filename: 'x', mimeType: 'text/html\r\nx: y', byteLength: 0 })['content-type'],
    ).toBe('application/octet-stream');
  });
});
