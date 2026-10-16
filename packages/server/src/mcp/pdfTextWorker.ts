import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

// Runs in its own thread with a heap limit so a hostile PDF cannot exhaust the
// server. Pages are read one at a time and only whole pages are returned, unless
// the first page alone exceeds the character budget.
const { bytes, cMapDirectory, firstPage, lastPage, maxPages, maxChars } = workerData as {
  bytes: Uint8Array;
  cMapDirectory: string;
  firstPage: number;
  lastPage: number;
  maxPages: number;
  maxChars: number;
};
// pdf.js reads CMaps from a filesystem path in Node; a file:// URL does not load.
const pdf = await getDocumentProxy(bytes, { verbosity: 0, cMapUrl: cMapDirectory, cMapPacked: true });
const end = Math.min(lastPage, pdf.numPages, firstPage + maxPages - 1);
const pages: string[] = [];
let chars = 0;
let cut = false;
for (let number = firstPage; number <= end; number++) {
  const page = await pdf.getPage(number);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
    .join('')
    .trim();
  page.cleanup();
  if (chars + text.length > maxChars) {
    if (pages.length === 0) {
      pages.push(text.slice(0, maxChars));
      cut = true;
    }
    break;
  }
  pages.push(text);
  chars += text.length + 2;
}
parentPort!.postMessage({
  text: pages.join('\n\n'),
  firstPage,
  lastPage: firstPage + pages.length - 1,
  totalPages: pdf.numPages,
  cut,
});
await pdf.loadingTask.destroy();
