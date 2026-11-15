import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapProvider } from '../src/imapProvider.js';
import type { ImapMessageLocation, ImapStateStore } from '../src/types.js';

class MemoryStore implements ImapStateStore {
  rows = new Map<string, ImapMessageLocation>([
    ['m1', { id: 'm1', accountId: 'a1', mailboxPath: 'INBOX', uidValidity: '1', uid: 1, threadId: 't1' }],
  ]);
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
  async invalidateMailbox() {}
}

const literal = (value: string) => `{${Buffer.byteLength(value)}}\r\n${value}`;
const quoted = (value: string) => `"${value.replace(/["\\]/g, (match) => `\\${match}`)}"`;

/**
 * A server that sends small body sections as quoted strings instead of
 * literals, as Yahoo does. IMAP allows either for a section.
 */
async function quotingServer(parts: Record<string, { type: string; body: string }>) {
  const sockets = new Set<Socket>();
  const numbers = Object.keys(parts);
  const structure = `(${numbers
    .map((part) => {
      const [type, subtype] = parts[part]!.type.toUpperCase().split('/');
      return `("${type}" "${subtype}" ("CHARSET" "utf-8") NIL NIL "7BIT" ${Buffer.byteLength(parts[part]!.body)} 1 NIL NIL NIL NIL)`;
    })
    .join('')} "ALTERNATIVE" ("BOUNDARY" "synthetic") NIL NIL NIL)`;
  const headers = 'Message-ID: <quoted@example.test>\r\n\r\n';
  const server = createServer((socket) => {
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
        if (command.startsWith('LIST')) {
          socket.write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK done\r\n`);
        } else if (command.startsWith('SELECT')) {
          socket.write(
            `* 1 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 2] ok\r\n${tag} OK [READ-WRITE] done\r\n`,
          );
        } else if (command.includes('FETCH')) {
          const section = /BODY\.PEEK\[(\d+)\]/.exec(command)?.[1];
          if (command.includes('ENVELOPE')) {
            socket.write(
              `* 1 FETCH (UID 1 FLAGS () ENVELOPE (NIL "Quoted parts" NIL NIL NIL NIL NIL NIL NIL "<quoted@example.test>") BODYSTRUCTURE ${structure} BODY[HEADER.FIELDS (MESSAGE-ID REFERENCES IN-REPLY-TO)] ${literal(headers)})\r\n${tag} OK done\r\n`,
            );
          } else if (section && parts[section]) {
            const mime = `Content-Type: ${parts[section].type}; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n`;
            socket.write(
              `* 1 FETCH (UID 1 RFC822.SIZE 400 BODY[${section}.MIME] ${literal(mime)} BODY[${section}]<0> ${quoted(parts[section].body)})\r\n${tag} OK done\r\n`,
            );
          } else if (command.includes('BODYSTRUCTURE')) {
            socket.write(`* 1 FETCH (UID 1 BODYSTRUCTURE ${structure})\r\n${tag} OK done\r\n`);
          } else {
            socket.write(`* 1 FETCH (UID 1 FLAGS ())\r\n${tag} OK done\r\n`);
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
  const provider = new ImapProvider({
    accountId: 'a1',
    email: 'demo@example.test',
    credentials: {
      imap: { host: '127.0.0.1', port: address.port, security: 'starttls', user: 'demo', password: 'synthetic' },
      smtp: { host: '127.0.0.1', port: 1, security: 'starttls', user: 'demo', password: 'synthetic' },
      saveSent: true,
    },
    store: new MemoryStore(),
    imapFactory: (options) => new ImapFlow({ ...options, doSTARTTLS: false, disableAutoIdle: true, logger: false }),
  });
  return {
    provider,
    async close() {
      await provider.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('IMAP body sections sent as quoted strings', () => {
  it('reads text and HTML parts the server quotes', async () => {
    const test = await quotingServer({
      '1': { type: 'text/plain', body: 'Short "quoted" body' },
      '2': { type: 'text/html', body: '<p>Short body</p>' },
    });
    try {
      const message = await test.provider.getMessage('m1');
      expect(message.body).toEqual({ text: 'Short "quoted" body', html: '<p>Short body</p>' });
    } finally {
      await test.close();
    }
  });

  it('reads an empty part the server sends as an empty quoted string', async () => {
    const test = await quotingServer({
      '1': { type: 'text/plain', body: '' },
      '2': { type: 'text/html', body: '<p>Only HTML</p>' },
    });
    try {
      const message = await test.provider.getMessage('m1');
      expect(message.body).toEqual({ text: '', html: '<p>Only HTML</p>' });
    } finally {
      await test.close();
    }
  });
});
