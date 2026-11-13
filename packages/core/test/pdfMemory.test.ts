import { afterEach, describe, expect, it } from 'vitest';
import { limitPdfWorkerMemory, PdfMemoryLimitError } from '../src/mcp/pdfMemory.js';

// The limit replaces this file's globals, as it would in a PDF text worker. The fake reading
// stands in for the worker's ArrayBuffer usage.
const mebibyte = 1024 * 1024;
let held = 0;
const memory = limitPdfWorkerMemory(16 * mebibyte, () => held);
afterEach(() => {
  held = 0;
});

describe('PDF worker memory limit', () => {
  it('refuses an allocation that would exceed the budget and remembers it', () => {
    expect(() => memory.assertWithinLimit()).not.toThrow();
    expect(() => new Uint8Array(32 * mebibyte)).toThrow(PdfMemoryLimitError);
    expect(() => new Float64Array(3 * mebibyte)).toThrow(PdfMemoryLimitError);
    expect(() => new ArrayBuffer(17 * mebibyte)).toThrow(PdfMemoryLimitError);
    // pdf.js may catch the error, so the worker checks again before posting a result.
    expect(() => memory.assertWithinLimit()).toThrow(PdfMemoryLimitError);
    held = 15 * mebibyte;
    expect(() => new Uint8Array(2 * mebibyte)).toThrow(PdfMemoryLimitError);
  });

  it('counts small allocations until they add up to a check', () => {
    held = 16 * mebibyte - 1024;
    expect(() => new Uint8Array(1024)).not.toThrow();
    expect(() => {
      for (let i = 0; i < 64; i++) new Uint8Array(64 * 1024);
    }).toThrow(PdfMemoryLimitError);
  });

  it('counts copies and arrays made by typed array methods', () => {
    held = 15 * mebibyte;
    const source = new Uint8Array(512 * 1024);
    held = 15.75 * mebibyte;
    expect(() => new Uint8Array(source).byteLength + new Uint8Array(source).byteLength).toThrow(PdfMemoryLimitError);
    held = 15.75 * mebibyte;
    expect(() => {
      source.slice();
      source.map((x) => x);
    }).toThrow(PdfMemoryLimitError);
  });

  it('keeps typed arrays working within the budget', () => {
    class Bytes extends Uint8Array {}
    const bytes = new Bytes(4 * mebibyte);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(4 * mebibyte);
    expect(Uint8Array.from([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(new ArrayBuffer(8)).byteLength).toBe(8);
    expect(Buffer.alloc(4)).toBeInstanceOf(Uint8Array);
    expect(bytes.slice(0, 4)).toBeInstanceOf(Bytes);
    expect(new Uint8Array(4).slice().constructor).toBe(Uint8Array);
  });

  it('fails decompressed output once it exceeds the budget', async () => {
    const zeros = new Uint8Array(1 * mebibyte);
    const compress = async (copies: number) => {
      const stream = new Blob(Array.from({ length: copies }, () => zeros)).stream();
      return new Uint8Array(await new Response(stream.pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    };
    const inflate = async (input: Uint8Array) => {
      let total = 0;
      const output = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate'));
      for await (const chunk of output) {
        total += chunk.byteLength;
        held = total;
      }
      return total;
    };
    await expect(inflate(await compress(4))).resolves.toBe(4 * mebibyte);
    held = 0;
    await expect(inflate(await compress(64))).rejects.toThrow(PdfMemoryLimitError);
  });
});
