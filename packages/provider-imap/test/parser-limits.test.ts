import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { IMAP_PARSER_LIMITS, ImapProvider } from '../src/imapProvider.js';
import type { ImapStateStore } from '../src/types.js';

const store: ImapStateStore = {
  findById: async () => undefined,
  findByLocation: async () => undefined,
  findByDraftId: async () => undefined,
  listByThreadId: async () => [],
  save: async () => {},
  remove: async () => {},
  invalidateMailbox: async () => {},
};

/** A plaintext IMAP server that answers the first command with a CAPABILITY line carrying a literal. */
async function startServer(literalBytes: number) {
  const sent = { bytes: 0 };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.write('* OK ready\r\n');
    let buffered = '';
    let answered = false;
    socket.on('data', async (chunk: Buffer) => {
      buffered += chunk.toString('latin1');
      let end: number;
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const tag = buffered.slice(0, end).split(' ')[0];
        buffered = buffered.slice(end + 2);
        if (answered) {
          socket.write(`${tag} OK done\r\n`);
          continue;
        }
        answered = true;
        socket.write(`* CAPABILITY IMAP4rev1 X-BIG {${literalBytes}}\r\n`);
        const block = Buffer.alloc(1024 * 1024, 'a');
        while (sent.bytes < literalBytes && !socket.destroyed) {
          const part = block.subarray(0, Math.min(block.length, literalBytes - sent.bytes));
          sent.bytes += part.length;
          if (!socket.write(part))
            await new Promise<void>((resolve) => {
              const done = () => {
                socket.off('drain', done);
                socket.off('close', done);
                resolve();
              };
              socket.on('drain', done);
              socket.on('close', done);
            });
        }
        if (!socket.destroyed) socket.write(`\r\n${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The test server has no port.');
  running = { server, sockets };
  return { port: address.port, sent };
}

let running: { server: Server; sockets: Set<Socket> } | undefined;
afterEach(async () => {
  const current = running;
  running = undefined;
  if (!current) return;
  for (const socket of current.sockets) socket.destroy();
  await new Promise((resolve) => current.server.close(resolve));
});

function provider(port: number, seen: ImapFlowOptions[] = []) {
  return new ImapProvider({
    accountId: 'a1',
    email: 'me@example.com',
    credentials: {
      imap: { host: 'imap.example.com', port: 993, security: 'tls', user: 'me', password: 'secret' },
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'secret' },
      saveSent: true,
    },
    store,
    imapFactory: (options) => {
      seen.push(options);
      return new ImapFlow({ ...options, host: '127.0.0.1', port, secure: false, doSTARTTLS: false, logger: false });
    },
  });
}

describe('IMAP parser limits', () => {
  it('passes the limits to every IMAP client', async () => {
    const { port } = await startServer(16);
    const seen: ImapFlowOptions[] = [];
    const imap = provider(port, seen);
    await imap.testConnection().catch(() => {});
    await imap.close?.();
    expect(seen[0]).toMatchObject(IMAP_PARSER_LIMITS);
    expect(IMAP_PARSER_LIMITS.maxResponseSize).toBeGreaterThan(
      Math.max(IMAP_PARSER_LIMITS.maxLiteralSize, IMAP_PARSER_LIMITS.maxLineLength),
    );
  });

  it('rejects a literal above the limit before buffering it', async () => {
    const { port, sent } = await startServer(IMAP_PARSER_LIMITS.maxLiteralSize + 1);
    const client = new ImapFlow({
      host: '127.0.0.1',
      port,
      secure: false,
      doSTARTTLS: false,
      auth: { user: 'me', pass: 'secret' },
      logger: false,
      ...IMAP_PARSER_LIMITS,
    });
    client.on('error', () => {});
    await expect(client.connect()).rejects.toMatchObject({ code: 'LiteralTooLarge' });
    client.close();
    // The server stops writing once the client drops the connection, long before the literal ends.
    expect(sent.bytes).toBeLessThan(IMAP_PARSER_LIMITS.maxLiteralSize);
  });
});
