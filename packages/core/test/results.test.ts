import { describe, expect, it } from 'vitest';
import {
  attachmentContents,
  attachmentUri,
  bodyPage,
  inlineContent,
  MAX_BODY_CHARS,
  parsePageRange,
  pdfTextContent,
  selectBody,
  threadPage,
  threadPageOffset,
  toModifyAction,
} from '../src/mcp/index.js';
import type { Message, Thread } from '../src/index.js';

function msg(id: string, body?: Message['body']): Message {
  return {
    id,
    threadId: 't1',
    accountId: 'acct_1',
    to: [],
    subject: 'Hello',
    date: '2026-07-09T00:00:00.000Z',
    attachments: [],
    flags: { read: true, starred: false, draft: false },
    ...(body ? { body } : {}),
  };
}

describe('message bodies', () => {
  it('keeps the requested parts within one budget and reports cuts', () => {
    const selected = selectBody(msg('m1', { text: 'abcdef', html: '<p>x</p>' }), 'both', 8);
    expect(selected.body).toEqual({ text: 'abcdef', html: '<p' });
    expect(selected.bodyTruncation).toEqual({ text: { totalChars: 6 }, html: { totalChars: 8, nextOffset: 2 } });
    expect(selectBody(msg('m1', { text: 'abc' }), 'none').body).toBeUndefined();
  });

  it('pages through one body part', () => {
    const message = msg('m1', { text: 'abcdef' });
    expect(bodyPage(message, 'text', 2, 3)).toEqual({
      format: 'text',
      text: 'cde',
      offset: 2,
      totalChars: 6,
      nextOffset: 5,
    });
    expect(bodyPage(message, 'html')).toEqual({ format: 'html', text: '', offset: 0, totalChars: 0 });
  });
});

describe('thread pages', () => {
  const thread: Thread = {
    id: 't1',
    subject: 'Hello',
    messages: [msg('m1', { text: 'x'.repeat(MAX_BODY_CHARS) }), msg('m2', { text: 'second' }), msg('m3')],
  };

  it('shares the body budget across a page and links the next page', () => {
    const page = threadPage(thread, { threadId: 't1', offset: 0, pageSize: 2 });
    expect(page.messages.map((message) => message.body?.text?.length)).toEqual([MAX_BODY_CHARS, 0]);
    expect(page.messages[1]!.bodyTruncation).toEqual({ text: { totalChars: 6, nextOffset: 0 } });
    expect(threadPageOffset('t1', page.nextPageToken)).toBe(2);
    expect(threadPage(thread, { threadId: 't1', offset: 2 }).nextPageToken).toBeUndefined();
  });

  it('rejects tokens for another thread or with a bad offset', () => {
    const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(threadPageOffset('t1', undefined)).toBe(0);
    expect(threadPageOffset('t2', token({ threadId: 't1', offset: 1 }))).toBeUndefined();
    expect(threadPageOffset('t1', token({ threadId: 't1', offset: -1 }))).toBeUndefined();
    expect(threadPageOffset('t1', 'not json')).toBeUndefined();
  });
});

describe('toModifyAction', () => {
  it('maps actions and their arguments', () => {
    expect(toModifyAction('star', {})).toEqual({ action: 'star' });
    expect(toModifyAction('move', { folder: 'Projects' })).toEqual({ action: { move: 'Projects' } });
    expect(toModifyAction('addLabels', { labels: ['a'] })).toEqual({ action: { addLabels: ['a'] } });
  });

  it('reports missing arguments and protected move destinations', () => {
    expect(toModifyAction('move', {})).toEqual({ error: 'Moving messages requires "folder"' });
    expect(toModifyAction('move', { folder: ' Trash ' })).toEqual({
      error: 'Archive or trash these messages instead of moving them to this folder.',
    });
    expect(toModifyAction('removeLabels', { labels: [] })).toEqual({ error: 'removeLabels requires "labels"' });
  });
});

describe('attachment content', () => {
  it('returns UTF-8 text attachments as text and others as blobs', () => {
    expect(attachmentContents('u', 'text/plain; charset=utf-8', Buffer.from('hi'))).toEqual({
      uri: 'u',
      mimeType: 'text/plain; charset=utf-8',
      text: 'hi',
    });
    expect(attachmentContents('u', 'text/plain', Buffer.from([0xff]))).toEqual({
      uri: 'u',
      mimeType: 'text/plain',
      blob: '/w==',
    });
    expect(inlineContent('u', 'image/png', Buffer.from('png'))).toEqual({
      type: 'image',
      data: 'cG5n',
      mimeType: 'image/png',
    });
  });

  it('encodes each attachment URI segment', () => {
    expect(attachmentUri('a/1', 'm 1', 'x', 'r#1.pdf')).toBe('fluxmail://attachment/a%2F1/m%201/x/r%231.pdf');
  });

  it('replaces unpaired surrogates in the attachment URI filename', () => {
    expect(attachmentUri('a', 'm', 'x', 'bad\ud800.pdf')).toBe('fluxmail://attachment/a/m/x/bad%EF%BF%BD.pdf');
    expect(attachmentUri('a', 'm', 'x', '😀.pdf')).toBe('fluxmail://attachment/a/m/x/%F0%9F%98%80.pdf');
  });

  it('parses ascending page ranges only', () => {
    expect(parsePageRange('3')).toEqual({ first: 3, last: 3 });
    expect(parsePageRange('201-400')).toEqual({ first: 201, last: 400 });
    expect(parsePageRange('5-2')).toBeUndefined();
    expect(parsePageRange('0')).toBeUndefined();
  });

  it('describes partial and empty PDF extractions', () => {
    expect(pdfTextContent('a.pdf', undefined)).toEqual([]);
    expect(pdfTextContent('a.pdf', { text: 'Hi', firstPage: 1, lastPage: 1, totalPages: 1, cut: false })).toEqual([
      { type: 'text', text: 'Text extracted from a.pdf:\n\nHi' },
    ]);
    expect(pdfTextContent('a.pdf', { text: '', firstPage: 2, lastPage: 3, totalPages: 9, cut: false })).toEqual([
      { type: 'text', text: 'No text found in a.pdf (pages 2-3 of 9).' },
    ]);
    expect(pdfTextContent('a.pdf', { text: '', firstPage: 10, lastPage: 9, totalPages: 9, cut: false })).toEqual([
      { type: 'text', text: 'a.pdf has 9 pages.' },
    ]);
  });
});
