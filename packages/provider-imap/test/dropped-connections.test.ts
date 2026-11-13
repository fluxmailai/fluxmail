import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapProvider } from '../src/imapProvider.js';
import type { ImapStateStore } from '../src/types.js';

const store: ImapStateStore = {
  findById: async () => undefined,
  findByLocation: async () => undefined,
  findByDraftId: async () => undefined,
  listByThreadId: async () => [],
  save: async () => undefined,
  remove: async () => undefined,
  invalidateMailbox: async () => undefined,
};

/**
 * What a synthetic server does on each connection: refuse it with a BYE, drop
 * it on the first LIST, drop it on the first SELECT, or answer normally.
 */
type Behavior = 'bye' | 'drop-list' | 'drop-select' | 'hang-list' | 'ok';

async function server(behaviors: Behavior[]) {
  const sockets = new Set<Socket>();
  let listing: (() => void) | undefined;
  const listStarted = new Promise<void>((resolve) => (listing = resolve));
  let connections = 0;
  const listener = createServer((socket) => {
    const behavior = behaviors[connections++] ?? 'ok';
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    if (behavior === 'bye') {
      socket.end('* BYE Too many connections from this user\r\n');
      return;
    }
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
          // ImapFlow's own LIST while connecting asks for no folders; the folder listing asks for "*".
          if (behavior === 'hang-list' && command.includes('"*"')) listing?.();
          else if (behavior === 'drop-list') socket.destroy();
          else socket.write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK done\r\n`);
        } else if (command.startsWith('SELECT')) {
          if (behavior === 'drop-select') socket.destroy();
          else
            socket.write(
              `* 0 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 1] ok\r\n${tag} OK [READ-WRITE] done\r\n`,
            );
        } else if (command.includes('SEARCH')) {
          socket.write(`* SEARCH\r\n${tag} OK done\r\n`);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing synthetic IMAP port');
  const provider = new ImapProvider({
    accountId: 'a1',
    email: 'demo@example.test',
    credentials: {
      imap: { host: '127.0.0.1', port: address.port, security: 'starttls', user: 'demo', password: 'synthetic' },
      smtp: { host: '127.0.0.1', port: 1, security: 'starttls', user: 'demo', password: 'synthetic' },
      saveSent: true,
    },
    store,
    imapFactory: (options) => new ImapFlow({ ...options, doSTARTTLS: false, disableAutoIdle: true, logger: false }),
  });
  return {
    provider,
    listStarted,
    connections: () => connections,
    async close() {
      await provider.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

describe('IMAP dropped connections', () => {
  it('connects again once when the server closes a new connection', async () => {
    const test = await server(['bye', 'ok']);
    try {
      await expect(test.provider.listFolders()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'INBOX' })]),
      );
      expect(test.connections()).toBe(2);
    } finally {
      await test.close();
    }
  });

  it("reports the server's reason when it closes the second connection too", async () => {
    const test = await server(['bye', 'bye', 'ok']);
    try {
      const error = await test.provider.listFolders().catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'provider_unavailable',
        failure: { provider: 'imap', phase: 'connect', reason: 'connection_reset' },
      });
      expect((error as Error).message).toContain('server closed the connection: Too many connections from this user');
      expect(test.connections()).toBe(2);
    } finally {
      await test.close();
    }
  });

  it('lists folders again on a new connection after the server drops LIST', async () => {
    const test = await server(['drop-list', 'ok']);
    try {
      await expect(test.provider.listFolders()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'INBOX' })]),
      );
      expect(test.connections()).toBe(2);
    } finally {
      await test.close();
    }
  });

  it('connects the search connection again once when the server closes it', async () => {
    const test = await server(['bye', 'ok']);
    try {
      await expect(
        test.provider.listMessages({ folder: 'INBOX' }, { signal: new AbortController().signal }),
      ).resolves.toMatchObject({ items: [] });
      expect(test.connections()).toBe(2);
    } finally {
      await test.close();
    }
  });

  it('opens no connection after close() ends a pending LIST', async () => {
    const test = await server(['hang-list', 'ok']);
    try {
      const folders = test.provider.listFolders().catch((error: unknown) => error);
      await test.listStarted;
      await test.provider.close();
      await expect(folders).resolves.toMatchObject({ code: 'provider_unavailable' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(test.connections()).toBe(1);
    } finally {
      await test.close();
    }
  });

  it('reopens the folder on a new connection after the server drops SELECT', async () => {
    const test = await server(['drop-select', 'ok']);
    try {
      await expect(test.provider.listMessages({ folder: 'INBOX' })).resolves.toMatchObject({ items: [] });
      expect(test.connections()).toBe(2);
    } finally {
      await test.close();
    }
  });
});
