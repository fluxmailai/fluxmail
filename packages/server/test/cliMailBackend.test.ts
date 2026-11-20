import { EmailError } from '@fluxmail/core';
import { describe, expect, it } from 'vitest';
import { RestMailBackend } from '../src/cliMailBackend.js';

function backend(response: Response): RestMailBackend {
  return new RestMailBackend({ request: async () => response } as never);
}

function body(chunks: string[], failAfter: boolean): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(Buffer.from(chunks[index++]!));
      } else if (failAfter) {
        controller.error(new TypeError('terminated'));
      } else {
        controller.close();
      }
    },
  });
}

describe('RestMailBackend.downloadAttachment', () => {
  it('returns the content of a complete download', async () => {
    const response = new Response(body(['%PDF-'], false), {
      headers: { 'content-type': 'application/pdf', 'content-length': '5' },
    });
    const downloaded = await backend(response).downloadAttachment('acct_1', 'msg_1', 'att_1');
    expect(downloaded.content.toString()).toBe('%PDF-');
    expect(downloaded.mimeType).toBe('application/pdf');
  });

  it('reports a download that stops partway as provider_unavailable', async () => {
    const response = new Response(body(['%PDF'], true), { headers: { 'content-length': '10' } });
    const error = await backend(response)
      .downloadAttachment('acct_1', 'msg_1', 'att_1')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailError);
    expect(error).toMatchObject({ code: 'provider_unavailable', message: expect.stringMatching(/stopped before/) });
  });

  it('reports a body shorter than its Content-Length as provider_unavailable', async () => {
    // A server that closes the stream cleanly before the stated length.
    const response = new Response(body(['%PDF'], false), { headers: { 'content-length': '10' } });
    await expect(backend(response).downloadAttachment('acct_1', 'msg_1', 'att_1')).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });
});
