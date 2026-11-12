import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapProvider } from '../src/imapProvider.js';
import type { ImapMessageLocation, ImapStateStore } from '../src/types.js';

class MemoryStore implements ImapStateStore {
  rows = new Map<string, ImapMessageLocation>([
    ['m1', { id: 'm1', accountId: 'a1', mailboxPath: 'INBOX', uidValidity: '1', uid: 1, threadId: 't1' }],
  ]);
  invalidations: string[] = [];
  async findById(id: string) {
    return this.rows.get(id);
  }
  async findByLocation(path: string, uidValidity: string, uid: number) {
    return [...this.rows.values()].find(
      (row) => row.mailboxPath === path && row.uidValidity === uidValidity && row.uid === uid,
    );
  }
  async findByDraftId() {
    return undefined;
  }
  async listByThreadId(id: string) {
    return [...this.rows.values()].filter((row) => row.threadId === id);
  }
  async save(row: ImapMessageLocation) {
    this.rows.set(row.id, row);
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async invalidateMailbox(_path: string, uidValidity: string) {
    this.invalidations.push(uidValidity);
  }
}

type Selection = 'invalid' | 'missing-validity' | 'no' | 'ok';
const source =
  'Message-ID: <root@example.test>\r\nSubject: Synthetic thread\r\nContent-Type: text/plain\r\n\r\nSynthetic body';

/** Real ImapFlow connections against a synthetic server, with a scripted SELECT response per connection. */
async function mailbox(selections: Selection[], failStore = false, failStoreCommand = false) {
  const sockets = new Set<Socket>();
  const commands: Array<{ connection: number; command: string }> = [];
  let connections = 0;
  const server = createServer((socket) => {
    const connection = connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
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
        commands.push({ connection, command });
        if (command.startsWith('LIST')) {
          socket.write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK done\r\n`);
        } else if (command.startsWith('SELECT')) {
          const selection = selections[connection] ?? 'invalid';
          if (selection === 'invalid') socket.write(`${tag} UNEXPECTED response\r\n`);
          else if (selection === 'no') socket.write(`${tag} NO unavailable\r\n`);
          else {
            socket.write(
              `* 1 EXISTS\r\n${selection === 'ok' ? '* OK [UIDVALIDITY 1] ok\r\n' : ''}* OK [UIDNEXT 2] ok\r\n${tag} OK [READ-WRITE] done\r\n`,
            );
          }
        } else if (command.includes('SEARCH')) {
          socket.write(`* SEARCH 1\r\n${tag} OK done\r\n`);
        } else if (command.includes('STORE') && failStoreCommand) {
          socket.write(`${tag} UNEXPECTED response\r\n`);
        } else if (command.includes('FETCH')) {
          if (command.includes('ENVELOPE')) {
            socket.write(
              `* 1 FETCH (UID 1 FLAGS () ENVELOPE (NIL "Synthetic thread" NIL NIL NIL NIL NIL NIL NIL "<root@example.test>"))\r\n${tag} OK done\r\n`,
            );
          } else {
            socket.write(`* 1 FETCH (UID 1 BODY[] {${Buffer.byteLength(source)}}\r\n${source})\r\n${tag} OK done\r\n`);
          }
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing synthetic IMAP port');
  const store = new MemoryStore();
  if (failStore)
    store.invalidateMailbox = async () => {
      throw new Error('Store failed');
    };
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
    store,
    commands,
    connections: () => connections,
    async close() {
      await provider.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('IMAP selection recovery', () => {
  it.each(['invalid', 'missing-validity'] as const)(
    'recovers getThread after a transient %s selection',
    async (failure) => {
      const test = await mailbox([failure, 'ok']);
      try {
        const thread = await test.provider.getThread('t1');
        expect(thread.messages).toHaveLength(1);
        expect(thread.messages[0]?.body?.text).toBe('Synthetic body');
        expect(test.connections()).toBe(2);
        expect(
          test.commands.filter(({ connection, command }) => connection === 0 && command.includes('FETCH')),
        ).toEqual([]);
        expect(test.store.invalidations.every((value) => value === '1')).toBe(true);
      } finally {
        await test.close();
      }
    },
  );

  it.each(['invalid', 'missing-validity'] as const)(
    'stops after one reconnect if selection is still %s',
    async (failure) => {
      const test = await mailbox([failure, failure]);
      try {
        await expect(test.provider.getThread('t1')).rejects.toMatchObject({
          code: 'provider_unavailable',
          failure: { provider: 'imap', phase: 'select', reason: 'invalid_response' },
        });
        expect(test.connections()).toBe(2);
        expect(test.store.invalidations).toEqual([]);
      } finally {
        await test.close();
      }
    },
  );

  it('does not retry a server refusal', async () => {
    const test = await mailbox(['no', 'ok']);
    try {
      await expect(test.provider.getThread('t1')).rejects.toMatchObject({
        code: 'provider_unavailable',
        failure: { phase: 'select', reason: 'server_no' },
      });
      expect(test.connections()).toBe(1);
    } finally {
      await test.close();
    }
  });

  it('does not repeat work after selection succeeds', async () => {
    const test = await mailbox(['ok', 'ok'], true);
    try {
      await expect(test.provider.getThread('t1')).rejects.toMatchObject({
        message: expect.stringContaining('Store failed'),
      });
      expect(test.connections()).toBe(1);
    } finally {
      await test.close();
    }
  });

  it('does not replay a mutation after an invalid STORE response', async () => {
    const test = await mailbox(['ok', 'ok'], false, true);
    try {
      // ImapFlow's STORE resolves false for a failed command. It still must
      // reach the server only once, whatever the server's response.
      await test.provider.modify(['m1'], 'markRead');
      expect(test.connections()).toBe(1);
      expect(test.commands.filter(({ command }) => command.includes('STORE'))).toHaveLength(1);
    } finally {
      await test.close();
    }
  });

  it('keeps a caller-owned search connection instead of reconnecting underneath it', async () => {
    const test = await mailbox(['invalid', 'ok']);
    try {
      await expect(
        test.provider.listMessages({ folder: 'inbox' }, { signal: new AbortController().signal }),
      ).rejects.toMatchObject({
        code: 'provider_unavailable',
        failure: { phase: 'select', reason: 'invalid_response' },
      });
      expect(test.connections()).toBe(1);
    } finally {
      await test.close();
    }
  });
});
