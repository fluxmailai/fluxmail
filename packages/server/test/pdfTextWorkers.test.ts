import type { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => [] as Array<EventEmitter & { terminate: () => Promise<number> }>);

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor() {
      super();
      workers.push(this);
    }
  }
  return { ...actual, Worker };
});

const { pdfText } = await import('../src/mcp/attachmentContent.js');

const result = { text: 'Page 1', firstPage: 1, lastPage: 1, totalPages: 1, cut: false };

describe('PDF text workers', () => {
  it('runs at most two extractions at once and starts queued ones as workers finish', async () => {
    const signal = new AbortController().signal;
    const extractions = [1, 2, 3].map(() => pdfText(Buffer.from('pdf'), signal));
    await vi.waitFor(() => expect(workers).toHaveLength(2));

    const canceled = new AbortController();
    const queuedThenCanceled = pdfText(Buffer.from('pdf'), canceled.signal);
    canceled.abort();
    await expect(queuedThenCanceled).resolves.toBeUndefined();

    workers[0]!.emit('message', result);
    await expect(extractions[0]).resolves.toEqual(result);
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    expect(workers[0]!.terminate).toHaveBeenCalled();

    workers[1]!.emit('message', result);
    workers[2]!.emit('message', result);
    await expect(Promise.all(extractions.slice(1))).resolves.toEqual([result, result]);
    expect(workers).toHaveLength(3);

    // Both slots are free again.
    const next = [pdfText(Buffer.from('pdf'), signal), pdfText(Buffer.from('pdf'), signal)];
    await vi.waitFor(() => expect(workers).toHaveLength(5));
    workers[3]!.emit('message', result);
    workers[4]!.emit('message', result);
    await Promise.all(next);
  });
});
