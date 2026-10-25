import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';

type ContentBlock = CallToolResult['content'][number];

const TEXT_TYPES = /^(text\/[\w.+-]+|application\/(json|xml|csv|yaml|x-yaml|javascript|[\w.-]+\+(json|xml)))$/;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

// At most `workers` extractions run at once in this process, so concurrent requests cannot
// multiply the heap limit. Waiting for a worker shares the same timeout as extraction.
const PDF_TEXT_LIMITS = { maxPages: 200, maxChars: 80_000, heapMb: 128, timeoutMs: 15_000, workers: 2 };

export function mediaType(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}

function decodeText(content: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

/**
 * Some clients, including claude.ai, only pass a blob to the model through
 * file storage, so UTF-8 text attachments go out as text.
 */
export function attachmentContents(
  uri: string,
  mimeType: string,
  content: Buffer,
): { uri: string; mimeType: string; text: string } | { uri: string; mimeType: string; blob: string } {
  const text = TEXT_TYPES.test(mediaType(mimeType)) ? decodeText(content) : undefined;
  return text === undefined ? { uri, mimeType, blob: content.toString('base64') } : { uri, mimeType, text };
}

export function inlineContent(uri: string, mimeType: string, content: Buffer): ContentBlock {
  if (IMAGE_TYPES.test(mediaType(mimeType))) return { type: 'image', data: content.toString('base64'), mimeType };
  return { type: 'resource', resource: attachmentContents(uri, mimeType, content) };
}

function parsePages(pages: string): { first: number; last: number } {
  const [first, last = first] = pages.split('-').map(Number) as [number, number?];
  return { first, last };
}

export const pageRange = z
  .string()
  .regex(/^[1-9]\d{0,5}(-[1-9]\d{0,5})?$/)
  .refine(
    (value) => {
      const { first, last } = parsePages(value);
      return last >= first;
    },
    { message: 'Use a page or an ascending range such as 201-400.' },
  )
  .describe('PDF page or page range to read as text, such as 201-400');

interface PdfText {
  text: string;
  firstPage: number;
  lastPage: number;
  totalPages: number;
  cut: boolean;
}

// The build emits the worker next to this module; tests load the source.
const PDF_WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './pdfTextWorker.ts' : './pdfTextWorker.js',
  import.meta.url,
);

// Character maps for PDFs that use predefined CJK encodings, copied from pdfjs-dist at the
// pdf.js version unpdf bundles. Refresh them when upgrading unpdf. Same path from src and dist.
export const PDF_CMAP_PDFJS_VERSION = '5.6.205';
const PDF_CMAP_DIRECTORY = fileURLToPath(new URL('../../pdf-cmaps/', import.meta.url));

let runningWorkers = 0;
const workerQueue: Array<() => void> = [];

/** Resolves true once a worker slot is held, or false when the signal aborts first. */
function acquireWorkerSlot(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (runningWorkers < PDF_TEXT_LIMITS.workers) {
    runningWorkers++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const grant = () => {
      signal.removeEventListener('abort', cancel);
      resolve(true);
    };
    const cancel = () => {
      workerQueue.splice(workerQueue.indexOf(grant), 1);
      resolve(false);
    };
    workerQueue.push(grant);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Hand the slot to the next waiting extraction, or free it. */
function releaseWorkerSlot(): void {
  const next = workerQueue.shift();
  if (next) next();
  else runningWorkers--;
}

/** Extract PDF text in a memory-limited worker. Resolves undefined when extraction fails or is aborted. */
export async function pdfText(
  content: Buffer,
  signal: AbortSignal,
  pages = '1-999999',
  onError?: (error: unknown) => void,
): Promise<PdfText | undefined> {
  const waitTimeout = AbortSignal.timeout(PDF_TEXT_LIMITS.timeoutMs);
  if (!(await acquireWorkerSlot(AbortSignal.any([signal, waitTimeout])))) {
    if (waitTimeout.aborted && !signal.aborted)
      onError?.(new Error('PDF text extraction timed out waiting for a worker.'));
    return undefined;
  }
  try {
    return await runPdfWorker(content, signal, pages, onError);
  } finally {
    releaseWorkerSlot();
  }
}

function runPdfWorker(
  content: Buffer,
  signal: AbortSignal,
  pages: string,
  onError?: (error: unknown) => void,
): Promise<PdfText | undefined> {
  const { first: firstPage, last: lastPage } = parsePages(pages);
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    const bytes = new Uint8Array(content);
    const worker = new Worker(PDF_WORKER_URL, {
      workerData: {
        bytes,
        cMapDirectory: PDF_CMAP_DIRECTORY,
        firstPage,
        lastPage,
        maxPages: PDF_TEXT_LIMITS.maxPages,
        maxChars: PDF_TEXT_LIMITS.maxChars,
      },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: PDF_TEXT_LIMITS.heapMb },
    });
    let settled = false;
    const finish = (result?: PdfText, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) onError?.(error);
      // Resolve after the thread stops so a released slot no longer holds its heap.
      void worker.terminate().finally(() => resolve(result));
    };
    const abort = () => finish();
    const timer = setTimeout(
      () => finish(undefined, new Error('PDF text extraction timed out.')),
      PDF_TEXT_LIMITS.timeoutMs,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (result: PdfText) => finish(result));
    worker.once('error', (error) => finish(undefined, error));
    worker.once('exit', (code) => finish(undefined, new Error(`PDF text worker exited with code ${code}.`)));
  });
}

export function pdfTextContent(filename: string, pdf: PdfText | undefined): ContentBlock[] {
  if (!pdf) return [];
  const { firstPage, lastPage, totalPages } = pdf;
  if (lastPage < firstPage) {
    return [{ type: 'text', text: `${filename} has ${totalPages} ${totalPages === 1 ? 'page' : 'pages'}.` }];
  }
  const whole = firstPage === 1 && lastPage === totalPages && !pdf.cut;
  const pages = firstPage === lastPage ? `page ${firstPage}` : `pages ${firstPage}-${lastPage}`;
  const cut = pdf.cut ? `, cut at ${PDF_TEXT_LIMITS.maxChars.toLocaleString('en-US')} characters` : '';
  const scope = whole ? '' : ` (${pages} of ${totalPages}${cut})`;
  return [
    {
      type: 'text',
      text: pdf.text
        ? `Text extracted from ${filename}${scope}:\n\n${pdf.text}`
        : `No text found in ${filename}${scope}.`,
    },
  ];
}
