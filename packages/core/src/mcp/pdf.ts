import { Worker } from 'node:worker_threads';
import { PDF_TEXT_LIMITS, parsePageRange, type PdfText } from './results.js';

export interface PdfTextExtractorOptions {
  /**
   * The worker module. It reads `{ bytes, cMapDirectory, firstPage, lastPage, maxPages, maxChars }`
   * from `workerData` and posts one PdfText message.
   */
  workerUrl: URL;
  /** pdf.js reads CMaps from a filesystem path ending in a separator; a file:// URL does not load. */
  cMapDirectory: string;
}

export type PdfTextExtractor = (
  content: Buffer,
  signal: AbortSignal,
  pages?: string,
  onError?: (error: unknown) => void,
) => Promise<PdfText | undefined>;

// Shared by every extractor in this process, so concurrent extractions cannot multiply the
// heap limit.
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

/**
 * Extracts PDF text in memory-limited workers. At most PDF_TEXT_LIMITS.workers extractions run at
 * once in the process. Waiting for a worker shares the extraction timeout. The extractor resolves
 * undefined when extraction fails or is aborted.
 */
export function createPdfTextExtractor({ workerUrl, cMapDirectory }: PdfTextExtractorOptions): PdfTextExtractor {
  const runPdfWorker = (
    content: Buffer,
    signal: AbortSignal,
    pages: string,
    onError?: (error: unknown) => void,
  ): Promise<PdfText | undefined> => {
    const range = parsePageRange(pages);
    if (!range) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(undefined);
      const bytes = new Uint8Array(content);
      const worker = new Worker(workerUrl, {
        workerData: {
          bytes,
          cMapDirectory,
          firstPage: range.first,
          lastPage: range.last,
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
  };

  return async (content, signal, pages = '1-999999', onError) => {
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
  };
}
