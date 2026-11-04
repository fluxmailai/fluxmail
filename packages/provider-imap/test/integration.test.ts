import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { downloadListBody, inspectStructure } from '../src/body.js';
import { ImapProvider } from '../src/imapProvider.js';
import type { ImapCredentials, ImapMessageLocation, ImapStateStore } from '../src/types.js';

class MemoryStore implements ImapStateStore {
  rows = new Map<string, ImapMessageLocation>();

  async findById(id: string) {
    return this.rows.get(id);
  }

  async findByLocation(path: string, uidValidity: string, uid: number) {
    return [...this.rows.values()].find(
      (row) => row.mailboxPath === path && row.uidValidity === uidValidity && row.uid === uid,
    );
  }

  async findByDraftId(draftId: string) {
    return [...this.rows.values()].find((row) => row.draftId === draftId);
  }

  async listByThreadId(threadId: string) {
    return [...this.rows.values()].filter((row) => row.threadId === threadId);
  }

  async save(row: ImapMessageLocation) {
    this.rows.set(row.id, row);
  }

  async remove(id: string) {
    this.rows.delete(id);
  }

  async invalidateMailbox(path: string, uidValidity: string) {
    for (const [id, row] of this.rows) {
      if (row.mailboxPath === path && row.uidValidity !== uidValidity) this.rows.delete(id);
    }
  }
}

const host = process.env.GREENMAIL_HOST;
const folders = ['Sent', 'Drafts', 'Trash', 'Archive', 'Spam', 'Vanishing'];
const overrides = { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', archive: 'Archive', spam: 'Spam' } as const;

function credentials(options: { saveSent?: boolean; smtpSecurity?: 'tls' | 'starttls' } = {}): ImapCredentials {
  const smtpSecurity = options.smtpSecurity ?? 'tls';
  return {
    imap: { host: host!, port: 3993, security: 'tls', user: 'test1', password: 'pwd1' },
    smtp: {
      host: host!,
      port: smtpSecurity === 'tls' ? 3465 : 3025,
      security: smtpSecurity,
      user: 'test1',
      password: 'pwd1',
    },
    saveSent: options.saveSent ?? true,
    folderOverrides: overrides,
  };
}

function makeProvider(store = new MemoryStore(), custom = credentials()): ImapProvider {
  return new ImapProvider({
    accountId: 'acct_greenmail',
    email: 'test1@localhost',
    displayName: 'Green Mail',
    credentials: custom,
    store,
  });
}

async function adminClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: host!,
    port: 3993,
    secure: true,
    auth: { user: 'test1', pass: 'pwd1' },
    logger: false,
  });
  await client.connect();
  return client;
}

async function waitForMessage(provider: ImapProvider, folder: string, subject: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const message = (await provider.listMessages({ folder, subject })).items[0];
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${subject} in ${folder}`);
}

it('reports labels as unsupported without connecting to the server', async () => {
  await expect(makeProvider().listLabels()).rejects.toMatchObject({ code: 'unsupported_capability' });
});

describe.skipIf(!host).sequential('GreenMail integration', () => {
  const store = new MemoryStore();
  const provider = makeProvider(store);

  beforeAll(async () => {
    let connected = false;
    for (let attempt = 0; attempt < 20 && !connected; attempt++) {
      try {
        await provider.testConnection();
        connected = true;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const client = await adminClient();
    try {
      const existing = new Set((await client.list()).map((folder) => folder.path));
      for (const folder of folders) {
        if (!existing.has(folder)) await client.mailboxCreate(folder);
      }
    } finally {
      await client.logout();
    }
  }, 15_000);

  afterAll(async () => {
    await provider.close();
  });

  it('resolves configured folders and reports their provenance', async () => {
    const listed = await provider.listFolders();
    for (const [role, path] of Object.entries(overrides)) {
      expect(listed.find((folder) => folder.id === path)).toMatchObject({ role, roleSource: 'user' });
    }
  });

  it('delivers through SMTP, saves Sent, and keeps Bcc out of the delivered copy', async () => {
    const subject = 'GreenMail delivery and Bcc';
    const sent = await provider.send({
      to: [{ email: 'test1@localhost' }],
      bcc: [{ email: 'hidden@localhost' }],
      subject,
      body: { text: 'message body' },
    });
    expect(sent.warnings).toBeUndefined();

    const inbox = await waitForMessage(provider, 'inbox', subject);
    const sentCopy = await waitForMessage(provider, 'sent', subject);
    const delivered = await provider.getMessage(inbox.id);
    expect(delivered).toMatchObject({ body: { text: 'message body' } });
    expect(delivered).not.toHaveProperty('bcc');
    await expect(provider.getMessage(sentCopy.id)).resolves.toMatchObject({
      body: { text: 'message body' },
      bcc: [{ email: 'hidden@localhost' }],
    });
  }, 15_000);

  it('reads batched previews that match a download per message', async () => {
    const subject = `Batched preview ${Date.now().toString(36)}`;
    const headers = (index: number, contentType: string, encoding?: string) =>
      [
        'From: Sender <sender@example.com>',
        'To: test1@localhost',
        `Subject: ${subject} ${index}`,
        `Message-ID: <batched-preview-${index}@example.com>`,
        'MIME-Version: 1.0',
        `Content-Type: ${contentType}`,
        ...(encoding ? [`Content-Transfer-Encoding: ${encoding}`] : []),
      ].join('\r\n');
    const base64 = (text: string) =>
      Buffer.from(text)
        .toString('base64')
        .replace(/(.{76})/g, '$1\r\n');
    const raw = [
      `${headers(1, 'text/plain; charset=utf-8', '7bit')}\r\n\r\nPlain   seven-bit\r\nbody.`,
      `${headers(2, 'text/plain; charset=utf-8', 'quoted-printable')}\r\n\r\nCaf=C3=A9 au lait with a soft =\r\nbreak.`,
      `${headers(3, 'multipart/alternative; boundary="b3"')}\r\n\r\n--b3\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nAlternative =E2=9C=93 text\r\n--b3\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64('<p>Alternative HTML</p>')}\r\n--b3--`,
      `${headers(4, 'text/html; charset=utf-8', 'base64')}\r\n\r\n${base64('<style>p{}</style><p>Only&nbsp;<b>HTML</b></p>')}`,
      `${headers(5, 'text/plain; charset=iso-8859-1', '8bit')}\r\n\r\n`,
      `${headers(6, 'text/plain; charset=utf-8; format=flowed; delsp=yes', '7bit')}\r\n\r\nFlowed lin \r\nes join.`,
      `${headers(7, 'multipart/mixed; boundary="b7"')}\r\n\r\n--b7\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nWith an attachment\r\n--b7\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64('%PDF-1.4')}\r\n--b7--`,
      `${headers(8, 'text/plain; charset=utf-8', 'base64')}\r\n\r\n${base64(`Long ${'é'.repeat(12_000)}`)}`,
      `${headers(10, 'text/plain; charset=utf-8; format=flowed; delsp=yes', '7bit')}\r\n\r\nOn Monday, Bob wrote:\r\n> Hello wor \r\n> ld\r\n>  stuffed\r\n-- \r\nSignature`,
      `${headers(9, 'multipart/mixed; boundary="b9"')}\r\n\r\n--b9\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename="a.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64('png')}\r\n--b9--`,
    ];
    const client = await adminClient();
    try {
      for (const [index, message] of raw.entries()) {
        const bytes = Buffer.from(message, 'latin1');
        // The iso-8859-1 body is written as raw bytes.
        await client.append(
          'INBOX',
          index === 4 ? Buffer.concat([bytes, Buffer.from([0x63, 0x61, 0x66, 0xe9])]) : bytes,
        );
      }
      const page = await provider.listMessages({ folder: 'inbox', subject }, { pageSize: 25, includeSnippet: true });
      expect(page.items).toHaveLength(raw.length);
      expect(page.diagnostics).toBeUndefined();

      const lock = await client.getMailboxLock('INBOX');
      try {
        for (const item of page.items) {
          const location = await store.findById(item.id);
          const fetched = await client.fetchOne(String(location!.uid), { bodyStructure: true }, { uid: true });
          const expected = await downloadListBody(client, location!.uid, inspectStructure(fetched!.bodyStructure), {
            snippet: true,
          });
          expect({ subject: item.subject, snippet: item.snippet }).toEqual({
            subject: item.subject,
            snippet: expected.snippet,
          });
        }
      } finally {
        lock.release();
      }
      const snippets = Object.fromEntries(
        page.items.map((item) => [item.subject.slice(subject.length + 1), item.snippet]),
      );
      expect(snippets).toMatchObject({
        '1': 'Plain seven-bit body.',
        '2': 'Café au lait with a soft break.',
        '3': 'Alternative ✓ text',
        '4': 'Only HTML',
        '5': 'café',
        '6': 'Flowed lines join.',
        '7': 'With an attachment',
      });
      expect(snippets['8']).toMatch(/^Long é+$/);
      expect(snippets['9']).toBeUndefined();
    } finally {
      await client.logout();
    }
  });

  it('reads multipart bodies and downloads attachment parts', async () => {
    const subject = 'GreenMail multipart attachment';
    await provider.send({
      to: [{ email: 'test1@localhost' }],
      subject,
      body: { text: 'plain version', html: '<p>html version</p>' },
      attachments: [
        {
          filename: 'hello.txt',
          mimeType: 'text/plain',
          content: Buffer.from('attachment bytes').toString('base64'),
        },
      ],
    });
    const listed = await waitForMessage(provider, 'inbox', subject);
    await expect(provider.listMessages({ folder: 'inbox', subject, hasAttachment: true })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: listed.id })],
    });
    const message = await provider.getMessage(listed.id);
    expect(message.body).toMatchObject({ text: 'plain version', html: '<p>html version</p>' });
    expect(message.attachments).toHaveLength(1);
    const downloaded = await provider.getAttachment(message.id, message.attachments![0]!.id);
    expect(downloaded.meta).toMatchObject({ filename: 'hello.txt', mimeType: 'text/plain' });
    expect(downloaded.content.toString()).toBe('attachment bytes');
  });

  it('paginates deterministically and rejects a token for a different query', async () => {
    for (const suffix of ['one', 'two', 'three']) {
      await provider.send({
        to: [{ email: 'test1@localhost' }],
        subject: `GreenMail pagination ${suffix}`,
        body: { text: suffix },
      });
    }
    const first = await provider.listMessages({ folder: 'inbox', subject: 'GreenMail pagination' }, { pageSize: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextPageToken).toBeTruthy();
    const second = await provider.listMessages(
      { folder: 'inbox', subject: 'GreenMail pagination' },
      { pageSize: 2, pageToken: first.nextPageToken },
    );
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    await expect(
      provider.listMessages({ folder: 'inbox', subject: 'another query' }, { pageToken: first.nextPageToken }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('continues pagination deterministically across folders', async () => {
    const subject = 'GreenMail cross-folder pagination';
    for (const body of ['first', 'second']) {
      await provider.send({ to: [{ email: 'test1@localhost' }], subject, body: { text: body } });
    }
    const inbox = await provider.listMessages({ folder: 'inbox', subject });
    await provider.modify([inbox.items[0]!.id], 'archive');

    const found = [];
    let pageToken: string | undefined;
    do {
      const page = await provider.listMessages({ subject }, { pageSize: 1, ...(pageToken ? { pageToken } : {}) });
      found.push(...page.items);
      pageToken = page.nextPageToken;
    } while (pageToken);

    expect(found).toHaveLength(4);
    expect(new Set(found.map((message) => `${message.folder.id}:${message.id}`)).size).toBe(4);
    expect(new Set(found.map((message) => message.folder.role))).toEqual(new Set(['inbox', 'sent', 'archive']));
  }, 15_000);

  it('marks a message answered after a reply and forwarded after a forward', async () => {
    const subject = 'GreenMail replied flags';
    await provider.send({ to: [{ email: 'test1@localhost' }], subject, body: { text: 'reply to me' } });
    const message = await waitForMessage(provider, 'inbox', subject);
    const location = (await store.findById(message.id))!;
    const flags = async () => {
      const client = await adminClient();
      try {
        const lock = await client.getMailboxLock(location.mailboxPath);
        try {
          const fetched = await client.fetchOne(String(location.uid), { flags: true }, { uid: true });
          return fetched ? [...(fetched.flags ?? [])] : [];
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
    };

    await provider.markReplied(message.id, 'reply');
    expect(await flags()).toContain('\\Answered');
    await provider.markReplied(message.id, 'forward');
    expect(await flags()).toEqual(expect.arrayContaining(['\\Answered', '$Forwarded']));
    await expect(provider.markReplied('im_missing', 'reply')).resolves.toBeUndefined();

    const draft = await provider.createDraft({ replyToMessageId: message.id, body: { text: 'Draft reply' } });
    await expect(provider.findRepliedMessage(draft.draftId!)).resolves.toBe(message.id);
    const unrelated = await provider.createDraft({ to: [{ email: 'test1@localhost' }], body: { text: 'New' } });
    await expect(provider.findRepliedMessage(unrelated.draftId!)).resolves.toBeUndefined();
  }, 15_000);

  it('changes flags, moves through special folders, and only deletes explicitly', async () => {
    const subject = 'GreenMail modify lifecycle';
    await provider.send({
      to: [{ email: 'test1@localhost' }],
      subject,
      body: { text: 'move me' },
    });
    const message = await waitForMessage(provider, 'inbox', subject);

    await provider.modify([message.id], 'markRead');
    expect((await provider.getMessage(message.id)).flags.read).toBe(true);
    await provider.modify([message.id], 'markUnread');
    expect((await provider.getMessage(message.id)).flags.read).toBe(false);
    await provider.modify([message.id], 'star');
    expect((await provider.getMessage(message.id)).flags.starred).toBe(true);
    await expect(
      provider.listMessages({ folder: 'inbox', subject, read: false, starred: true }),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ id: message.id })] });
    await provider.modify([message.id], 'unstar');
    expect((await provider.getMessage(message.id)).flags.starred).toBe(false);

    await provider.modify([message.id], 'archive');
    expect(await provider.getMessage(message.id)).toMatchObject({ id: message.id, folder: { role: 'archive' } });
    await provider.modify([message.id], 'trash');
    expect(await provider.getMessage(message.id)).toMatchObject({ id: message.id, folder: { role: 'trash' } });
    await provider.modify([message.id], 'untrash');
    expect(await provider.getMessage(message.id)).toMatchObject({ id: message.id, folder: { role: 'inbox' } });
    await provider.modify([message.id], { move: 'Spam' });
    expect(await provider.getMessage(message.id)).toMatchObject({ id: message.id, folder: { role: 'spam' } });
    await provider.modify([message.id], 'delete');
    await expect(provider.getMessage(message.id)).rejects.toMatchObject({ code: 'not_found' });
  }, 15_000);

  it('creates, updates, reads, deletes, and sends drafts', async () => {
    const draft = await provider.createDraft({
      to: [{ email: 'test1@localhost' }],
      subject: 'GreenMail original draft',
      body: { text: 'first body' },
    });
    expect(draft).toMatchObject({ folder: { role: 'drafts' }, flags: { draft: true } });
    const updated = await provider.updateDraft(draft.draftId!, {
      to: [{ email: 'test1@localhost' }],
      subject: 'GreenMail updated draft',
      body: { text: 'second body' },
    });
    expect(updated).toMatchObject({ id: draft.id, draftId: draft.draftId, body: { text: 'second body' } });
    await expect(provider.getDraft(draft.draftId!)).resolves.toMatchObject({ subject: 'GreenMail updated draft' });
    const sent = await provider.send({ draftId: draft.draftId! });
    expect(sent.warnings).toBeUndefined();
    await expect(provider.getDraft(draft.draftId!)).rejects.toMatchObject({ code: 'not_found' });
    await expect(provider.getMessage(draft.id)).resolves.toMatchObject({
      folder: { role: 'sent' },
      flags: { draft: false, read: true },
    });

    const disposable = await provider.createDraft({ subject: 'GreenMail deleted draft', body: { text: 'delete' } });
    await provider.deleteDraft(disposable.draftId!);
    await expect(provider.getDraft(disposable.draftId!)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('builds a synthetic thread from Message-ID, References, and In-Reply-To', async () => {
    const subject = 'GreenMail thread root';
    await provider.send({
      to: [{ email: 'test1@localhost' }],
      subject,
      body: { text: 'root body' },
    });
    const root = await waitForMessage(provider, 'inbox', subject);
    await provider.send({
      to: [{ email: 'test1@localhost' }],
      replyToMessageId: root.id,
      body: { text: 'reply body' },
    });
    await waitForMessage(provider, 'sent', `Re: ${subject}`);
    const thread = await provider.getThread(root.threadId);
    expect(thread.messages.map((message) => message.body?.text)).toEqual(
      expect.arrayContaining(['root body', 'reply body']),
    );
    expect(thread.messages.every((message) => message.threadId === root.threadId)).toBe(true);
  });

  it('reconnects after close and keeps stable IDs through the state store', async () => {
    const subject = 'GreenMail reconnect';
    await provider.send({ to: [{ email: 'test1@localhost' }], subject, body: { text: 'persist me' } });
    const before = await waitForMessage(provider, 'inbox', subject);
    await provider.close();
    const restarted = makeProvider(store);
    try {
      const after = await waitForMessage(restarted, 'inbox', subject);
      expect(after.id).toBe(before.id);
      await expect(restarted.getMessage(before.id)).resolves.toMatchObject({ body: { text: 'persist me' } });
    } finally {
      await restarted.close();
    }
  });

  it('reports a configured folder that disappears after setup', async () => {
    const staleCredentials = credentials();
    staleCredentials.folderOverrides = { ...staleCredentials.folderOverrides, archive: 'Vanishing' };
    const stale = makeProvider(new MemoryStore(), staleCredentials);
    try {
      expect(await stale.listFolders()).toContainEqual(expect.objectContaining({ id: 'Vanishing', role: 'archive' }));
      await stale.close();
      const client = await adminClient();
      try {
        await client.mailboxDelete('Vanishing');
      } finally {
        await client.logout();
      }
      await expect(stale.getFolderWarnings()).resolves.toContainEqual(
        expect.objectContaining({ role: 'archive', reason: 'stale_override' }),
      );
    } finally {
      await stale.close();
    }
  });
});

describe.skipIf(!host).sequential('GreenMail large folder search', () => {
  const folder = 'Bulk';
  const total = 2_100;
  // Every 50th message mentions the keyword. Listed newest first.
  const expected = Array.from({ length: total / 50 }, (_, index) => `Bulk ${total - index * 50}`);

  // Recreates the folder. It isn't deleted afterwards: GreenMail drops the
  // deleting connection when another session still has the folder selected.
  async function createFolder() {
    const client = await adminClient();
    try {
      if ((await client.list()).some((listed) => listed.path === folder)) await client.mailboxDelete(folder);
      await client.mailboxCreate(folder);
      for (let number = 1; number <= total; number++) {
        const keyword = number % 50 === 0 ? ' needle' : '';
        await client.append(
          folder,
          `From: bulk@localhost\r\nTo: test1@localhost\r\nSubject: Bulk ${number}\r\nMessage-ID: <bulk-${number}@localhost>\r\n\r\nBody ${number}${keyword}\r\n`,
        );
      }
    } finally {
      await client.logout();
    }
  }

  // Records each SEARCH's UID range. With delayPerUid, the server answers in
  // time proportional to the UIDs a search covers, like a server without a
  // search index.
  function recordingProvider(delayPerUid = 0) {
    const ranges: (string | undefined)[] = [];
    const provider = new ImapProvider({
      accountId: 'acct_greenmail_bulk',
      email: 'test1@localhost',
      credentials: credentials(),
      store: new MemoryStore(),
      imapFactory: (options) => {
        const client = new ImapFlow(options);
        const search = client.search.bind(client);
        client.search = async (query, searchOptions) => {
          const range = typeof query.uid === 'string' ? query.uid : undefined;
          ranges.push(range);
          const [lower, upper] = range
            ? range.split(':').map(Number)
            : [1, client.mailbox ? client.mailbox.uidNext - 1 : 0];
          await new Promise((resolve) => setTimeout(resolve, delayPerUid * (upper! - lower! + 1)));
          return search(query, searchOptions);
        };
        return client;
      },
    });
    return { provider, ranges };
  }

  async function search(provider: ImapProvider, pageSize: number, softDeadlineMs?: number, pageToken?: string) {
    return provider.listMessages(
      { folder, text: 'needle' },
      {
        pageSize,
        signal: AbortSignal.timeout(30_000),
        ...(softDeadlineMs !== undefined ? { softDeadlineAt: Date.now() + softDeadlineMs } : {}),
        ...(pageToken ? { pageToken } : {}),
      },
    );
  }

  async function allPages(provider: ImapProvider, pageSize: number, softDeadlineMs?: number) {
    const subjects: string[] = [];
    const counts: number[] = [];
    let pageToken: string | undefined;
    do {
      const page = await search(provider, pageSize, softDeadlineMs, pageToken);
      subjects.push(...page.items.map((message) => message.subject));
      counts.push(page.items.length);
      pageToken = page.nextPageToken;
    } while (pageToken && counts.length < 20);
    return { subjects, counts };
  }

  beforeAll(createFolder, 120_000);

  it('finds the same messages in UID ranges as in one search', async () => {
    const single = recordingProvider();
    const ranged = recordingProvider();
    try {
      const whole = await allPages(single.provider, 100);
      const windows = await allPages(ranged.provider, 10, 60_000);

      expect(whole.subjects).toEqual(expected);
      expect(single.ranges).toEqual([undefined]);
      expect(windows.subjects).toEqual(expected);
      expect(windows.counts).toEqual([10, 10, 10, 10, 2]);
      expect(ranged.ranges.length).toBeGreaterThan(1);
      expect(ranged.ranges.every((range) => range !== undefined)).toBe(true);
    } finally {
      await single.provider.close();
      await ranged.provider.close();
    }
  }, 60_000);

  it('moves forward on each page when a search outlasts the soft deadline', async () => {
    // A search of 2,000 UIDs takes 2 seconds, past the 1-second soft deadline.
    const slow = recordingProvider(1);
    try {
      const subjects: string[] = [];
      let pageToken: string | undefined;
      for (let index = 0; index < 3; index++) {
        const page = await search(slow.provider, 10, 1_000, pageToken);
        expect(page).toMatchObject({ incomplete: true, incompleteReason: 'time_limit' });
        expect(page.items.length).toBeGreaterThan(0);
        subjects.push(...page.items.map((message) => message.subject));
        pageToken = page.nextPageToken;
      }
      expect(subjects).toEqual(expected.slice(0, subjects.length));
    } finally {
      await slow.provider.close();
    }
  }, 60_000);
});
