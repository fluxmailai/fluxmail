import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { isEmailError } from '@fluxmail/core';
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

type FetchBehavior = 'silent' | 'reset' | 'close';

/** A plaintext IMAP server that answers until the first FETCH, then fails the connection. */
async function startServer(onFetch: FetchBehavior) {
  const server: Server = createServer((socket: Socket) => {
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
        if (command.startsWith('LIST')) {
          socket.write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK done\r\n`);
        } else if (command.startsWith('SELECT') || command.startsWith('EXAMINE')) {
          socket.write(
            `* 3 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 4] ok\r\n${tag} OK [READ-WRITE] done\r\n`,
          );
        } else if (command.includes('SEARCH')) {
          socket.write(`* SEARCH 1 2 3\r\n${tag} OK done\r\n`);
        } else if (command.includes('FETCH')) {
          if (onFetch === 'reset') socket.resetAndDestroy();
          else if (onFetch === 'close') socket.end();
        } else if (command.startsWith('LOGOUT')) {
          socket.end(`* BYE bye\r\n${tag} OK done\r\n`);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The test server has no port.');
  return { server, port: address.port };
}

let running: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => running?.close(resolve) ?? resolve(undefined));
  running = undefined;
});

async function listFailure(onFetch: FetchBehavior) {
  const { server, port } = await startServer(onFetch);
  running = server;
  const provider = new ImapProvider({
    accountId: 'a1',
    email: 'me@example.com',
    credentials: {
      imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
      saveSent: true,
    },
    store: new MemoryStore(),
    imapFactory: (options) =>
      new ImapFlow({
        ...options,
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: false,
        socketTimeout: 300,
        logger: false,
      }),
  });
  try {
    await provider.listMessages({}, { pageSize: 2 });
  } catch (error) {
    if (!isEmailError(error)) throw error;
    return error;
  } finally {
    await provider.close?.();
  }
  throw new Error('The list succeeded.');
}

describe('IMAP connection lost during a command', () => {
  it('reports a server that stops answering as a connection timeout', async () => {
    const error = await listFailure('silent');
    expect(error.code).toBe('provider_unavailable');
    expect(error.failure).toEqual({ provider: 'imap', phase: 'fetch', reason: 'connection_timeout' });
    expect(error.message).toMatch(/Socket timeout/);
  });

  it('reports a reset connection with its socket error code', async () => {
    const error = await listFailure('reset');
    expect(error.failure).toEqual({
      provider: 'imap',
      phase: 'fetch',
      reason: 'connection_reset',
      ioCode: 'ECONNRESET',
    });
  });

  it('reports a connection the server closed as a reset without a socket error code', async () => {
    const error = await listFailure('close');
    expect(error.failure).toEqual({ provider: 'imap', phase: 'fetch', reason: 'connection_reset' });
  });
});
