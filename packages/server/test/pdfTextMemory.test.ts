import { createDeflate } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { pdfText } from '../src/mcp/attachmentContent.js';

// pdf.js decompresses streams into ArrayBuffers, which a worker's heap limit doesn't cover. A
// small PDF whose streams inflate to hundreds of megabytes must end as a bounded extraction.
const mebibyte = 1024 * 1024;
const bombMiB = 384;
const text = Buffer.from('BT /F1 12 Tf 10 10 Td (a) Tj ET\n');

async function deflatedZeros(mib: number, prefix = Buffer.alloc(0)) {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise((resolve) => deflate.on('end', resolve));
  deflate.write(prefix);
  const zeros = Buffer.alloc(mebibyte);
  for (let i = 0; i < mib; i++)
    if (!deflate.write(zeros)) await new Promise((resolve) => deflate.once('drain', resolve));
  deflate.end();
  await done;
  return Buffer.concat(chunks);
}

function stream(bytes: Buffer, filtered: boolean) {
  return Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length}${filtered ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
    bytes,
    Buffer.from('\nendstream'),
  ]);
}

function pdf(contents: Buffer, contentsFiltered: boolean, font?: Buffer) {
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    stream(contents, contentsFiltered),
    Buffer.from(
      font
        ? '<< /Type /Font /Subtype /TrueType /BaseFont /Dummy /FirstChar 97 /LastChar 97 /Widths [500] /FontDescriptor 6 0 R >>'
        : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ),
  ];
  if (font)
    objects.push(
      Buffer.from(
        '<< /Type /FontDescriptor /FontName /Dummy /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>',
      ),
      stream(font, true),
    );
  const parts = [Buffer.from('%PDF-1.7\n')];
  const offsets: number[] = [];
  let position = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(part);
    position += part.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

async function peakGrowth(run: () => Promise<unknown>) {
  const base = process.memoryUsage.rss();
  let peak = base;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 5);
  try {
    const result = await run();
    return { result, growthMiB: (peak - base) / mebibyte };
  } finally {
    clearInterval(sampler);
  }
}

const extract = (bytes: Buffer, onError = vi.fn()) => pdfText(bytes, new AbortController().signal, '1', onError);

it('ends extraction of a font stream that inflates past the memory limit', { timeout: 60_000 }, async () => {
  const bomb = pdf(text, false, await deflatedZeros(bombMiB));
  expect(bomb.length).toBeLessThan(2 * mebibyte);
  const onError = vi.fn();
  const { result, growthMiB } = await peakGrowth(() => extract(bomb, onError));
  expect(growthMiB).toBeLessThan(320);
  expect(result).toBeUndefined();
  expect(onError).toHaveBeenCalledOnce();
});

it('ends extraction of a page stream that inflates past the memory limit', { timeout: 60_000 }, async () => {
  const bomb = pdf(await deflatedZeros(bombMiB, text), true);
  expect(bomb.length).toBeLessThan(2 * mebibyte);
  const onError = vi.fn();
  const { result, growthMiB } = await peakGrowth(() => extract(bomb, onError));
  expect(growthMiB).toBeLessThan(320);
  expect(result).toBeUndefined();
  expect(onError).toHaveBeenCalledOnce();
});

// pdf.js skips a page whose stream needs more memory than allowed. The extraction must fail
// rather than return the other pages as if that one were blank.
it('fails instead of dropping a page that needs more memory than allowed', { timeout: 60_000 }, async () => {
  const onError = vi.fn();
  const result = await extract(pdf(await deflatedZeros(120, text), true), onError);
  expect(result).toBeUndefined();
  expect(onError).toHaveBeenCalledOnce();
});

it('still reads a PDF with compressed streams', { timeout: 60_000 }, async () => {
  const result = await extract(pdf(await deflatedZeros(4, text), true, await deflatedZeros(1)));
  expect(result).toMatchObject({ text: 'a', firstPage: 1, lastPage: 1, totalPages: 1, cut: false });
});
