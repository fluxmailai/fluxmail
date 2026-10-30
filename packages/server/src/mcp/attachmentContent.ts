import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PDF_PAGE_RANGE_MESSAGE, PDF_PAGE_RANGE_PATTERN, parsePageRange } from '@fluxmail/core/mcp';
import { createPdfTextExtractor } from '@fluxmail/core/mcp/pdf';

export { attachmentContents, inlineContent, mediaType, pdfTextContent } from '@fluxmail/core/mcp';

export const pageRange = z
  .string()
  .regex(PDF_PAGE_RANGE_PATTERN)
  .refine((value) => parsePageRange(value) !== undefined, { message: PDF_PAGE_RANGE_MESSAGE })
  .describe('PDF page or page range to read as text, such as 201-400');

// Character maps for PDFs that use predefined CJK encodings, copied from pdfjs-dist at the
// pdf.js version unpdf bundles. Refresh them when upgrading unpdf. Same path from src and dist.
export const PDF_CMAP_PDFJS_VERSION = '5.6.205';

/** Extract PDF text in a memory-limited worker. Resolves undefined when extraction fails or is aborted. */
export const pdfText = createPdfTextExtractor({
  // The build emits the worker next to this module; tests load the source.
  workerUrl: new URL(import.meta.url.endsWith('.ts') ? './pdfTextWorker.ts' : './pdfTextWorker.js', import.meta.url),
  cMapDirectory: fileURLToPath(new URL('../../pdf-cmaps/', import.meta.url)),
});
