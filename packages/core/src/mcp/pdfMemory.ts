import { PDF_TEXT_LIMITS } from './results.js';

// pdf.js decompresses PDF streams into ArrayBuffers, which live outside the V8 heap that a
// worker's resourceLimits bound. A small PDF whose font or page stream inflates to gigabytes
// would otherwise exhaust the process while the heap stays small.
const MEBIBYTE = 1024 * 1024;
// Smaller allocations are only counted until they add up to this, so ordinary buffers cost
// nothing extra and the memory check runs at most once per mebibyte allocated.
const CHECK_EVERY_BYTES = MEBIBYTE;

const TYPED_ARRAYS = [
  'ArrayBuffer',
  'Float16Array',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
] as const;

type Allocator = (abstract new (...args: unknown[]) => object) & { BYTES_PER_ELEMENT?: number };

/** Thrown inside a PDF text worker when the PDF needs more ArrayBuffer memory than the budget. */
export class PdfMemoryLimitError extends RangeError {
  constructor() {
    super('The PDF needs more memory than text extraction allows.');
    this.name = 'PdfMemoryLimitError';
  }
}

/** What limitPdfWorkerMemory reports back to the worker. */
export interface PdfWorkerMemory {
  /**
   * Throws PdfMemoryLimitError if any allocation was refused. pdf.js catches some of these errors
   * and carries on with a page or font missing, so the worker calls this before posting a result.
   */
  assertWithinLimit(): void;
}

/**
 * Caps the ArrayBuffer memory a PDF text worker holds. Call it at the top of the worker module,
 * then load pdf.js with a dynamic `import('unpdf')` so it allocates through the cap: new typed
 * arrays, copies and decompressed stream chunks fail with PdfMemoryLimitError once the worker's
 * ArrayBuffers would exceed the budget. Call `assertWithinLimit` before posting a result, so a PDF
 * that needed more memory fails instead of returning partial text.
 *
 * Only call this in a worker thread: it replaces global constructors for the whole thread, and
 * `process.memoryUsage().arrayBuffers` reports the calling worker's own ArrayBuffers.
 */
export function limitPdfWorkerMemory(
  budgetBytes = PDF_TEXT_LIMITS.arrayBufferMb * MEBIBYTE,
  readArrayBuffers: () => number = () => process.memoryUsage().arrayBuffers,
): PdfWorkerMemory {
  let unchecked = 0;
  let exceeded = false;
  const reserve = (bytes: number) => {
    if (!(bytes > 0)) return;
    unchecked += bytes;
    if (bytes < CHECK_EVERY_BYTES && unchecked < CHECK_EVERY_BYTES) return;
    unchecked = 0;
    if (readArrayBuffers() + bytes <= budgetBytes) return;
    exceeded = true;
    throw new PdfMemoryLimitError();
  };
  // The bytes a typed array constructor will allocate: a length, or a copy of an array-like.
  const allocation = (first: unknown, bytesPerElement: number) => {
    if (typeof first === 'number') return first * bytesPerElement;
    if (
      first instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && first instanceof SharedArrayBuffer)
    )
      return 0;
    const length = (first as { length?: unknown } | null)?.length;
    return typeof first === 'object' && typeof length === 'number' ? length * bytesPerElement : 0;
  };
  const scope = globalThis as unknown as Record<string, Allocator | undefined>;
  for (const name of TYPED_ARRAYS) {
    const allocator = scope[name];
    if (!allocator) continue;
    const limited: Allocator = new Proxy(allocator, {
      construct(target, args, newTarget): object {
        reserve(allocation(args[0], target.BYTES_PER_ELEMENT ?? 1));
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    // slice, map and other methods that create arrays find their constructor here.
    Object.defineProperty(allocator.prototype, 'constructor', {
      value: limited,
      writable: true,
      configurable: true,
    });
    scope[name] = limited;
  }
  // Decompressed chunks come from native code, so count them as they arrive.
  const NativeDecompressionStream = globalThis.DecompressionStream;
  if (NativeDecompressionStream)
    globalThis.DecompressionStream = class extends NativeDecompressionStream {
      constructor(format: ConstructorParameters<typeof DecompressionStream>[0]) {
        super(format);
        const counted = this.readable.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              reserve(chunk.byteLength);
              controller.enqueue(chunk);
            },
          }),
        );
        Object.defineProperty(this, 'readable', { value: counted });
      }
    };
  return {
    assertWithinLimit() {
      if (exceeded) throw new PdfMemoryLimitError();
    },
  };
}
