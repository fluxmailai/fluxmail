import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { isEmailError, type MessageSearchPage } from '@fluxmail/core';
import { ImapProvider } from '../src/imapProvider.js';
import type { ImapMessageLocation, ImapStateStore } from '../src/types.js';

class MemoryStore implements ImapStateStore {
  rows = new Map<string, ImapMessageLocation>();
  async findById(id: string) {
    return this.rows.get(id);
  }
  async findByLocation() {
    return undefined;
  }
  async findByDraftId() {
    return undefined;
  }
  async listByThreadId() {
    return [];
  }
  async save(row: ImapMessageLocation) {
    this.rows.set(row.id, row);
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async invalidateMailbox() {}
}

/** The UIDs a sequence set such as 3501:4000, 3501:* or 7,9 names, up to the folder's last UID. */
function sequenceUids(set: string, last: number): number[] {
  return set.split(',').flatMap((part) => {
    const [from, to = from] = part.split(':').map((value) => (value === '*' ? last : Number(value)));
    const lower = Math.min(from!, to!);
    return Array.from({ length: Math.max(from!, to!) - lower + 1 }, (_, index) => lower + index);
  });
}

const sockets = new Set<Socket>();

interface SlowServer {
  /** Messages in INBOX, with UIDs from 1. */
  messages: number;
  /** UIDs a text search matches. */
  matches: number[];
  /** How long the server reads each message a search covers, like one without a text index. */
  msPerMessage: number;
}

/** A plaintext IMAP server that takes time to answer a search in proportion to the messages it covers. */
async function startServer({ messages, matches, msPerMessage }: SlowServer) {
  const searched: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const [tag, ...words] = line.split(' ');
        const command = words.join(' ').toUpperCase();
        const write = (text: string) => {
          if (!socket.destroyed) socket.write(text);
        };
        if (command.startsWith('LIST')) {
          write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK done\r\n`);
        } else if (command.startsWith('SELECT') || command.startsWith('EXAMINE')) {
          write(
            `* ${messages} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT ${messages + 1}] ok\r\n${tag} OK [READ-WRITE] done\r\n`,
          );
        } else if (command.startsWith('UID SEARCH')) {
          const set = / UID (\S+)/.exec(command.slice('UID SEARCH'.length))?.[1] ?? '1:*';
          searched.push(set);
          const covered = new Set(sequenceUids(set, messages));
          const found = matches.filter((uid) => covered.has(uid));
          setTimeout(
            () => write(`* SEARCH ${found.join(' ')}\r\n${tag} OK done\r\n`),
            covered.size * msPerMessage,
          ).unref();
        } else if (command.startsWith('UID FETCH')) {
          const uids = sequenceUids(words[2]!, messages);
          const rows = uids.map(
            (uid, index) =>
              `* ${index + 1} FETCH (UID ${uid} FLAGS () INTERNALDATE "01-Jan-2026 00:00:00 +0000" ` +
              `ENVELOPE (NIL "Invoice ${uid}" NIL NIL NIL NIL NIL NIL NIL "<${uid}@example.com>") ` +
              `BODYSTRUCTURE ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1))\r\n`,
          );
          write(`${rows.join('')}${tag} OK done\r\n`);
        } else if (command.startsWith('LOGOUT')) {
          socket.end(`* BYE bye\r\n${tag} OK done\r\n`);
        } else {
          write(`${tag} OK done\r\n`);
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The test server has no port.');
  return { server, port: address.port, searched };
}

let running: Server | undefined;
let provider: ImapProvider | undefined;
afterEach(async () => {
  await provider?.close?.();
  provider = undefined;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise((resolve) => running?.close(resolve) ?? resolve(undefined));
  running = undefined;
});

// Cloud closes a connection after 20 seconds without a reply and asks for a
// page within 15. These defaults keep that ratio at a tenth of the time.
const SOCKET_TIMEOUT_MS = 2_000;
const SOFT_BUDGET_MS = 1_500;

async function slowProvider(
  options: SlowServer,
  { socketTimeoutMs = SOCKET_TIMEOUT_MS, softBudgetMs = SOFT_BUDGET_MS } = {},
) {
  const { server, port, searched } = await startServer(options);
  running = server;
  provider = new ImapProvider({
    accountId: 'a1',
    email: 'me@example.com',
    credentials: {
      imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
      saveSent: true,
    },
    store: new MemoryStore(),
    imapFactory: (imapOptions) =>
      new ImapFlow({
        ...imapOptions,
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: false,
        socketTimeout: socketTimeoutMs,
        logger: false,
      }),
  });
  const search = (text: string, pageToken?: string) =>
    provider!.listMessages(
      { folder: 'INBOX', text },
      {
        signal: new AbortController().signal,
        softDeadlineAt: Date.now() + softBudgetMs,
        ...(pageToken ? { pageToken } : {}),
      },
    );
  return { search, searched };
}

describe('IMAP text search on a server that reads every message', () => {
  it('returns partial pages that continue to the end of the folder', async () => {
    // 2,000 messages take 2.5 seconds to search, longer than the connection waits for a reply.
    const { search, searched } = await slowProvider({
      messages: 2_500,
      matches: [300, 1_100, 2_200, 2_400],
      msPerMessage: 1.25,
    });

    const pages: MessageSearchPage[] = [];
    let pageToken: string | undefined;
    do {
      const startedAt = Date.now();
      const page = await search('invoice', pageToken);
      expect(Date.now() - startedAt).toBeLessThan(SOFT_BUDGET_MS + 1_000);
      pages.push(page);
      pageToken = page.nextPageToken;
    } while (pageToken && pages.length < 20);

    expect(pages.flatMap((page) => page.items.map((message) => message.subject))).toEqual([
      'Invoice 2400',
      'Invoice 2200',
      'Invoice 1100',
      'Invoice 300',
    ]);
    expect(pages[0]).toMatchObject({ exhausted: false, incomplete: true, incompleteReason: 'time_limit' });
    expect(pages[0]!.items.length).toBeGreaterThan(0);
    expect(pages.at(-1)).toMatchObject({ exhausted: true });
    // Every message is searched once, in ranges the server answers before the connection gives up.
    const spans = searched.map((set) => sequenceUids(set, 2_500).length);
    expect(Math.max(...spans)).toBeLessThanOrEqual(500);
    expect(spans.reduce((total, span) => total + span, 0)).toBe(2_500);
  }, 30_000);

  it('searches later words only in the messages that matched the first', async () => {
    const { search, searched } = await slowProvider({ messages: 400, matches: [20, 390], msPerMessage: 0.1 });

    const page = await search('overdue invoice');

    expect(page.items.map((message) => message.subject)).toEqual(['Invoice 390', 'Invoice 20']);
    expect(searched).toEqual(['1:*', '20,390']);
  });

  it('searches a smaller range after one that did not answer, then reports a search timeout', async () => {
    const { search, searched } = await slowProvider(
      { messages: 4_000, matches: [3_900], msPerMessage: 100 },
      { socketTimeoutMs: 10_000, softBudgetMs: 300 },
    );

    const first = await search('invoice');
    expect(first).toMatchObject({ items: [], exhausted: false, incomplete: true, incompleteReason: 'time_limit' });
    const error = await search('invoice', first.nextPageToken).catch((error: unknown) => error);

    if (!isEmailError(error)) throw new Error('The search did not fail.');
    expect(error.code).toBe('provider_unavailable');
    expect(error.failure).toEqual({ provider: 'imap', phase: 'search', reason: 'search_timeout' });
    expect(error.data).toEqual({ reason: 'search_timeout', exhausted: false });
    expect(error.message).toMatch(/took too long/);
    expect(searched.map((set) => sequenceUids(set, 4_000).length)).toEqual([500, 250]);
  }, 30_000);

  it('reports a search the connection gave up on as a search timeout', async () => {
    // A folder this small is searched in one command, with no time limit of its own.
    const { search } = await slowProvider(
      { messages: 100, matches: [50], msPerMessage: 100 },
      { socketTimeoutMs: 300 },
    );

    const error = await search('invoice').catch((error: unknown) => error);

    if (!isEmailError(error)) throw new Error('The search did not fail.');
    expect(error.failure).toEqual({ provider: 'imap', phase: 'search', reason: 'search_timeout' });
    expect(error.message).toMatch(/took too long/);
  });
});
