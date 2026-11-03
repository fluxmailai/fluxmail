import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { MessageStructureObject } from 'imapflow';
import { downloadListBody, downloadSnippet, downloadSnippets, inspectStructure } from '../src/body.js';

describe('IMAP body structure', () => {
  it('uses part 1 for a single-part message', () => {
    const structure = {
      type: 'text/plain',
      parameters: { charset: 'utf-8' },
      encoding: '7bit',
      size: 12,
    } as MessageStructureObject;

    expect(inspectStructure(structure)).toEqual({ text: '1', attachments: [] });
  });

  it('reports inline images without filenames as attachments', () => {
    const structure = {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', encoding: '7bit', size: 12 },
        { part: '2', type: 'image/png', encoding: 'base64', size: 24, disposition: 'inline', id: '<logo>' },
      ],
    } as MessageStructureObject;

    expect(inspectStructure(structure)).toMatchObject({
      html: '1',
      attachments: [{ id: 'part:2', mimeType: 'image/png', disposition: 'inline', contentId: 'logo' }],
    });
  });

  it('does not use text inside an attached message as the outer body', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit', size: 12 },
        {
          part: '2',
          type: 'message/rfc822',
          encoding: '7bit',
          size: 40,
          childNodes: [{ part: '2.1', type: 'text/html', encoding: '7bit', size: 20 }],
        },
      ],
    } as MessageStructureObject;

    expect(inspectStructure(structure)).toEqual({
      text: '1',
      attachments: [
        {
          id: 'part:2',
          filename: 'attachment',
          mimeType: 'message/rfc822',
          sizeBytes: 40,
          disposition: 'attachment',
        },
      ],
    });
  });

  it('creates a bounded plain-text snippet from one partial download', async () => {
    const download = vi.fn().mockResolvedValue({
      meta: { charset: 'utf-8' },
      content: Readable.from([Buffer.from(`  Hello\n\nworld  ${'é'.repeat(400)}`)]),
    });

    const snippet = await downloadSnippet({ download } as never, 7, { text: '1', attachments: [] });

    expect(snippet).toHaveLength(300);
    expect(snippet).toMatch(/^Hello world é+/);
    expect(download).toHaveBeenCalledWith(7, '1', { uid: true, maxBytes: 16 * 1024 });
  });

  it('uses HTML only when no plain-text part is available', async () => {
    const download = vi.fn().mockResolvedValue({
      meta: { charset: 'utf-8' },
      content: Readable.from([Buffer.from('<p>Hello&nbsp;<strong>world</strong></p><script>ignore()</script>')]),
    });

    await expect(downloadSnippet({ download } as never, 8, { html: '2', attachments: [] })).resolves.toBe(
      'Hello world',
    );
  });

  it('derives a snippet and search context from one bounded download', async () => {
    const body = `Opening preview\n${'later text '.repeat(40)}Invoice placeholder [ORDER_ID] is here.`;
    const download = vi.fn().mockResolvedValue({
      meta: { charset: 'utf-8', expectedSize: Buffer.byteLength(body) },
      content: Readable.from([Buffer.from(body)]),
    });

    await expect(
      downloadListBody(
        { download } as never,
        9,
        { text: '1', attachments: [] },
        {
          snippet: true,
          searchContextText: 'invoice [ORDER_ID]',
        },
      ),
    ).resolves.toMatchObject({
      snippet: expect.stringContaining('Opening preview'),
      searchContext: { status: 'matched', excerpt: expect.stringContaining('[ORDER_ID]') },
    });
    expect(download).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith(9, '1', { uid: true, maxBytes: 256 * 1024 });
  });

  it('reports scan_limit when a partial download has no literal match', async () => {
    const body = 'x'.repeat(256 * 1024);
    const download = vi.fn().mockResolvedValue({
      meta: { charset: 'utf-8', expectedSize: body.length + 100 },
      content: Readable.from([Buffer.from(body)]),
    });

    await expect(
      downloadListBody(
        { download } as never,
        10,
        { text: '1', attachments: [] },
        { snippet: false, searchContextText: 'needle' },
      ),
    ).resolves.toEqual({ searchContext: { status: 'scan_limit' } });
  });
});

describe('batched IMAP previews', () => {
  const plain = (uid: number, body: string, extra: Partial<MessageStructureObject> = {}) => ({
    uid,
    structure: {
      type: 'text/plain',
      encoding: '7bit',
      size: Buffer.byteLength(body),
      ...extra,
    } as MessageStructureObject,
    body: Buffer.from(body),
  });
  const multipart = (uid: number, nodes: MessageStructureObject[]) =>
    ({ uid, structure: { type: 'multipart/alternative', childNodes: nodes } as MessageStructureObject }) as const;
  // Serves each UID FETCH from per-UID part contents, keyed like imapflow's bodyParts.
  function fakeClient(contents: Map<number, Map<string, Buffer>>, failingKey?: string) {
    const fetch = vi.fn(async function* (range: string, query: { bodyParts: { key: string; maxLength: number }[] }) {
      const [{ key, maxLength }] = query.bodyParts;
      if (key === failingKey) throw new Error('private provider failure');
      for (const uid of range.split(',').map(Number)) {
        const part = contents.get(uid)?.get(key);
        if (part) yield { uid, bodyParts: new Map([[key, part.subarray(0, maxLength)]]) };
      }
    });
    return { fetch };
  }
  // Base64 the way mail wraps it, in short lines.
  const base64Lines = (text: string) =>
    Buffer.from(text)
      .toString('base64')
      .replace(/(.{8})/g, '$1\r\n');
  const entries = (items: { uid: number; structure: MessageStructureObject }[]) =>
    items.map(({ uid, structure }) => ({ uid, structure, parts: inspectStructure(structure) }));

  it('reads every preview for a page with one fetch per part and encoding', async () => {
    const single = [1, 2, 3].map((uid) => plain(uid, `  Message ${uid}\n\nbody `));
    const latin = plain(4, '', { parameters: { charset: 'iso-8859-1' } });
    const quoted = multipart(5, [
      {
        part: '1',
        type: 'text/plain',
        encoding: 'quoted-printable',
        parameters: { charset: 'utf-8' },
      } as MessageStructureObject,
      { part: '2', type: 'text/html', encoding: 'quoted-printable' } as MessageStructureObject,
    ]);
    const html = multipart(6, [
      { part: '1', type: 'image/png', encoding: 'base64', disposition: 'attachment' } as MessageStructureObject,
      { part: '2', type: 'text/html', encoding: 'base64', parameters: { charset: 'utf-8' } } as MessageStructureObject,
    ]);
    const empty = multipart(7, [{ part: '1', type: 'image/png', encoding: 'base64' } as MessageStructureObject]);
    const contents = new Map<number, Map<string, Buffer>>([
      ...single.map(({ uid, body }) => [uid, new Map([['text', body]])] as const),
      [4, new Map([['text', Buffer.from([0x63, 0x61, 0x66, 0xe9])]])],
      [5, new Map([['1', Buffer.from('Caf=C3=A9 au =\r\nlait')]])],
      [6, new Map([['2', Buffer.from(base64Lines('<p>Hello&nbsp;<b>world</b></p>'))]])],
    ]);
    const client = fakeClient(contents);

    const snippets = await downloadSnippets(client as never, entries([...single, latin, quoted, html, empty]));

    expect(Object.fromEntries(snippets)).toEqual({
      1: 'Message 1 body',
      2: 'Message 2 body',
      3: 'Message 3 body',
      4: 'café',
      5: 'Café au lait',
      6: 'Hello world',
      7: undefined,
    });
    expect(client.fetch).toHaveBeenCalledTimes(3);
    expect(client.fetch).toHaveBeenCalledWith(
      '1,2,3,4',
      { uid: true, bodyParts: [{ key: 'text', start: 0, maxLength: 16 * 1024 }] },
      { uid: true },
    );
  });

  it('bounds the decoded input and drops a truncated escape or base64 group', async () => {
    const long = 'é'.repeat(20_000);
    const quoted = multipart(1, [
      { part: '1', type: 'text/plain', encoding: 'quoted-printable' } as MessageStructureObject,
    ]);
    const based = multipart(2, [{ part: '1', type: 'text/plain', encoding: 'base64' } as MessageStructureObject]);
    const contents = new Map([
      [1, new Map([['1', Buffer.from('Ends inside =C3=A')]])],
      [2, new Map([['1', Buffer.from(Buffer.from(long).toString('base64'))]])],
    ]);

    const snippets = await downloadSnippets(fakeClient(contents) as never, entries([quoted, based]));

    expect(snippets.get(1)).toBe('Ends inside �');
    expect(snippets.get(2)).toHaveLength(300);
    expect(snippets.get(2)).toMatch(/^é+$/);
  });

  it('keeps the last bytes of padded base64', async () => {
    const items = ['End.', 'Ends', 'Ends.'].map((_, index) =>
      multipart(index + 1, [{ part: '1', type: 'text/plain', encoding: 'base64' } as MessageStructureObject]),
    );
    const contents = new Map(
      ['End.', 'Ends', 'Ends.'].map((text, index) => [index + 1, new Map([['1', Buffer.from(base64Lines(text))]])]),
    );

    const snippets = await downloadSnippets(fakeClient(contents) as never, entries(items));

    expect([...snippets.values()]).toEqual(['End.', 'Ends', 'Ends.']);
  });

  it('joins format=flowed soft line breaks', async () => {
    const flowed = plain(1, '', { parameters: { format: 'flowed' } });
    const deleted = plain(2, '', { parameters: { format: 'flowed', delsp: 'yes' } });
    const contents = new Map([
      [1, new Map([['text', Buffer.from('One soft \r\nbreak')]])],
      [2, new Map([['text', Buffer.from('Hello wor \r\nld')]])],
    ]);

    const snippets = await downloadSnippets(fakeClient(contents) as never, entries([flowed, deleted]));

    expect(snippets.get(1)).toBe('One soft break');
    expect(snippets.get(2)).toBe('Hello world');
  });

  it('leaves out messages whose part could not be read, and only those', async () => {
    const plainOne = plain(1, 'Readable');
    const missing = plain(2, 'Expunged');
    const contents = new Map([[1, new Map([['text', Buffer.from('Readable')]])]]);

    const snippets = await downloadSnippets(fakeClient(contents) as never, entries([plainOne, missing]));

    expect(Object.fromEntries(snippets)).toEqual({ 1: 'Readable' });
  });

  it('downloads each message of a rejected fetch on its own', async () => {
    const readable = plain(1, 'Readable');
    const rejected = [2, 3].map((uid) =>
      multipart(uid, [{ part: '1', type: 'text/plain', encoding: '7bit' } as MessageStructureObject]),
    );
    const contents = new Map([[1, new Map([['text', Buffer.from('Readable')]])]]);
    const client = {
      ...fakeClient(contents, '1'),
      download: vi.fn(async (uid: number) => {
        if (uid === 3) throw new Error('private provider failure');
        return { meta: { charset: 'utf-8' }, content: Readable.from([Buffer.from('Downloaded alone')]) };
      }),
    };

    const snippets = await downloadSnippets(client as never, entries([readable, ...rejected]));

    expect(Object.fromEntries(snippets)).toEqual({ 1: 'Readable', 2: 'Downloaded alone' });
    expect(client.download.mock.calls.map(([uid]) => uid)).toEqual([2, 3]);
  });

  it('decodes a part the server labels us-ascii as UTF-8', async () => {
    const labeled = [1, 2].map((uid) =>
      plain(uid, '', { parameters: { charset: uid === 1 ? 'us-ascii' : 'US_ASCII' } }),
    );
    const contents = new Map(labeled.map(({ uid }) => [uid, new Map([['text', Buffer.from('café naïve')]])]));

    const snippets = await downloadSnippets(fakeClient(contents) as never, entries(labeled));

    expect([...snippets.values()]).toEqual(['café naïve', 'café naïve']);
  });

  it('downloads Japanese charsets on their own, as iconv-lite cannot decode them', async () => {
    const japanese = plain(1, '', { parameters: { charset: 'ISO-2022-JP' } });
    const client = {
      ...fakeClient(new Map()),
      download: vi.fn(async () => ({
        meta: { charset: 'utf-8' },
        content: Readable.from([Buffer.from('こんにちは')]),
      })),
    };

    const snippets = await downloadSnippets(client as never, entries([japanese]));

    expect(snippets.get(1)).toBe('こんにちは');
    expect(client.fetch).not.toHaveBeenCalled();
    expect(client.download).toHaveBeenCalledWith(1, '1', { uid: true, maxBytes: 16 * 1024 });
  });

  it('stops between fetches once the deadline passes', async () => {
    const first = multipart(1, [{ part: '1', type: 'text/plain', encoding: '7bit' } as MessageStructureObject]);
    const second = multipart(2, [{ part: '2', type: 'text/plain', encoding: '7bit' } as MessageStructureObject]);
    const contents = new Map([
      [1, new Map([['1', Buffer.from('First')]])],
      [2, new Map([['2', Buffer.from('Second')]])],
    ]);
    const client = fakeClient(contents);
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = client.fetch.getMockImplementation()!;
    client.fetch.mockImplementation((...args) => {
      // The first fetch takes past the deadline.
      now = 2_000;
      return fetch(...args);
    });

    const snippets = await downloadSnippets(client as never, entries([first, second]), 1_500);

    expect(Object.fromEntries(snippets)).toEqual({ 1: 'First' });
    expect(client.fetch).toHaveBeenCalledOnce();
    await expect(downloadSnippets(client as never, entries([first]), 1_500)).resolves.toEqual(new Map());
    expect(client.fetch).toHaveBeenCalledOnce();
  });

  it('splits large quoted-printable batches into bounded fetches', async () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      multipart(index + 1, [{ part: '1', type: 'text/plain', encoding: 'quoted-printable' } as MessageStructureObject]),
    );
    const contents = new Map(items.map(({ uid }) => [uid, new Map([['1', Buffer.from(`Note ${uid}`)]])]));
    const client = fakeClient(contents);

    const snippets = await downloadSnippets(client as never, entries(items));

    expect(snippets.size).toBe(30);
    expect(client.fetch).toHaveBeenCalledTimes(2);
    expect(client.fetch.mock.calls[0]?.[0].split(',')).toHaveLength(21);
  });
});
