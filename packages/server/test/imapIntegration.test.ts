import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { ImapCredentials } from '@fluxmail/provider-imap';
import { AccountRegistry } from '../src/accounts/registry.js';
import type { FluxmailConfig } from '../src/config.js';
import { SendScheduler } from '../src/scheduler/sendScheduler.js';
import { EmailService } from '../src/service/emailService.js';
import { openDb, type FluxmailDb } from '../src/storage/db.js';
import { createScheduledSend, getScheduledSend } from '../src/storage/scheduledSends.js';
import { addMember } from '../src/storage/members.js';
import { buildMcpServer } from '../src/mcp/buildServer.js';
import { FULL_PERMISSION_POLICY } from '../src/permissions.js';

const host = process.env.GREENMAIL_HOST;

function closeDb(db: FluxmailDb): void {
  (db as unknown as { $client: { close(): void } }).$client.close();
}

function config(dbPath: string): FluxmailConfig {
  return {
    dataDir: path.dirname(dbPath),
    dbPath,
    encryptionKey: randomBytes(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 10 * 1024 * 1024,
    licenseServerUrl: 'https://license.invalid',
  };
}

const imapPort = Number(process.env.GREENMAIL_IMAPS_PORT ?? 3993);
const smtpsPort = Number(process.env.GREENMAIL_SMTPS_PORT ?? 3465);

const credentials: ImapCredentials = {
  imap: { host: host!, port: imapPort, security: 'tls', user: 'server', password: 'pwd2' },
  smtp: { host: host!, port: smtpsPort, security: 'tls', user: 'server', password: 'pwd2' },
  saveSent: true,
  folderOverrides: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', archive: 'Archive', spam: 'Spam' },
};

describe.skipIf(!host).sequential('IMAP account persistence integration', () => {
  it('validates credentials and restores drafts and stable IDs after a database restart', async () => {
    const admin = new ImapFlow({
      host: host!,
      port: imapPort,
      secure: true,
      auth: { user: 'server', pass: 'pwd2' },
      logger: false,
    });
    await admin.connect();
    try {
      const existing = new Set((await admin.list()).map((folder) => folder.path));
      for (const folder of ['Sent', 'Drafts', 'Trash', 'Archive', 'Spam']) {
        if (!existing.has(folder)) await admin.mailboxCreate(folder);
      }
    } finally {
      await admin.logout();
    }

    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-imap-integration-')), 'fluxmail.db');
    const appConfig = config(dbPath);
    let db = openDb(dbPath);
    let registry = new AccountRegistry(db, appConfig);
    expect(await registry.testImapCredentials('server@localhost', credentials)).toEqual([]);
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('server@localhost', credentials, undefined, owner.id);
    const firstProvider = registry.getProvider(account.id);
    const draft = await firstProvider.createDraft({
      to: [{ email: 'server@localhost' }],
      subject: 'Persistent IMAP draft',
      body: { text: 'survives restart' },
    });
    const schedule = createScheduledSend(db, {
      accountId: account.id,
      draftId: draft.draftId!,
      sendAt: Date.now() - 1_000,
      subject: draft.subject,
      toRecipients: 'server@localhost',
    });
    await (firstProvider as typeof firstProvider & { close(): Promise<void> }).close();
    closeDb(db);

    db = openDb(dbPath);
    registry = new AccountRegistry(db, appConfig);
    const restored = registry.getProvider(account.id);
    const scheduler = new SendScheduler(db, new EmailService(registry, db));
    try {
      await expect(restored.getDraft(draft.draftId!)).resolves.toMatchObject({
        id: draft.id,
        draftId: draft.draftId,
        body: { text: 'survives restart' },
      });
      scheduler.start();
      for (let attempt = 0; attempt < 50 && getScheduledSend(db, schedule.id)?.status !== 'sent'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(getScheduledSend(db, schedule.id)).toMatchObject({
        status: 'sent',
        sentMessageId: draft.id,
        sentThreadId: draft.threadId,
      });
      await expect(restored.getMessage(draft.id)).resolves.toMatchObject({
        folder: { role: 'sent' },
        flags: { draft: false, read: true },
      });
    } finally {
      scheduler.stop();
      await (restored as typeof restored & { close(): Promise<void> }).close();
      closeDb(db);
    }
  }, 20_000);
});

describe.skipIf(!host).sequential('IMAP folder creation integration', () => {
  it('creates a folder over MCP and moves a message into it', async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-imap-folders-')), 'fluxmail.db');
    const db = openDb(dbPath);
    const registry = new AccountRegistry(db, config(dbPath));
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('server@localhost', credentials, undefined, owner.id);
    const provider = registry.getProvider(account.id);
    const server = buildMcpServer(new EmailService(registry, db), { permissions: FULL_PERMISSION_POLICY });
    const client = new Client({ name: 'folders', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const subject = `Folder over MCP ${Date.now()}`;
      await provider.send({ to: [{ email: 'server@localhost' }], subject, body: { text: 'file me' } });
      let messageId: string | undefined;
      for (let attempt = 0; attempt < 30 && !messageId; attempt++) {
        messageId = (await provider.listMessages({ folder: 'inbox', subject })).items[0]?.id;
        if (!messageId) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(messageId).toBeTruthy();

      // GreenMail separates levels with a dot.
      const name = `Clients ${Date.now()}.Acme`;
      const created = await client.callTool({ name: 'create_folder', arguments: { accountId: account.id, name } });
      expect(created.isError).toBeFalsy();
      expect(created.structuredContent).toEqual({ data: { id: name, name } });
      const again = await client.callTool({ name: 'create_folder', arguments: { accountId: account.id, name } });
      expect(again.structuredContent).toEqual({ data: { id: name, name } });
      const refused = await client.callTool({
        name: 'create_folder',
        arguments: { accountId: account.id, name: 'inbox' },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('invalid_request');

      const moved = await client.callTool({
        name: 'move_emails',
        arguments: { accountId: account.id, messageIds: [messageId!], folder: name },
      });
      expect(moved.structuredContent).toMatchObject({ data: { succeededIds: [messageId], failed: [] } });
      await expect(provider.getMessage(messageId!)).resolves.toMatchObject({ folder: { id: name } });
    } finally {
      await client.close();
      await (provider as typeof provider & { close(): Promise<void> }).close();
      closeDb(db);
    }
  }, 20_000);
});

describe.skipIf(!host).sequential('IMAP folder deletion integration', () => {
  it('deletes empty folders over MCP and refuses ones that hold mail or subfolders', async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-imap-folder-delete-')), 'fluxmail.db');
    const db = openDb(dbPath);
    const registry = new AccountRegistry(db, config(dbPath));
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('server@localhost', credentials, undefined, owner.id);
    const provider = registry.getProvider(account.id);
    const server = buildMcpServer(new EmailService(registry, db), { permissions: FULL_PERMISSION_POLICY });
    const client = new Client({ name: 'folders', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { accountId: account.id, ...args } });
    const errorOf = (result: Awaited<ReturnType<typeof call>>) =>
      JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { error: string; message: string };
    try {
      // GreenMail separates levels with a dot.
      const parent = `Sorted ${Date.now()}`;
      const child = `${parent}.Receipts`;
      expect((await call('create_folder', { name: child })).isError).toBeFalsy();

      const subject = `Folder delete over MCP ${Date.now()}`;
      await provider.send({ to: [{ email: 'server@localhost' }], subject, body: { text: 'keep me' } });
      let messageId: string | undefined;
      for (let attempt = 0; attempt < 30 && !messageId; attempt++) {
        messageId = (await provider.listMessages({ folder: 'inbox', subject })).items[0]?.id;
        if (!messageId) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(messageId).toBeTruthy();
      await call('move_emails', { messageIds: [messageId!], folder: child });

      const full = await call('delete_folder', { folder: child });
      expect(full.isError).toBe(true);
      expect(errorOf(full)).toMatchObject({
        error: 'invalid_request',
        message: `"${child}" still has 1 message. Move or trash it first.`,
      });
      const nested = await call('delete_folder', { folder: parent });
      expect(errorOf(nested)).toMatchObject({
        error: 'invalid_request',
        message: `"${parent}" has subfolders. Delete them first.`,
      });
      const inbox = await call('delete_folder', { folder: 'inbox' });
      expect(errorOf(inbox)).toMatchObject({ error: 'invalid_request' });
      const missing = await call('delete_folder', { folder: `${parent}.Missing` });
      expect(errorOf(missing)).toMatchObject({
        error: 'not_found',
        message: `This mailbox has no folder named "${parent}.Missing".`,
      });

      await call('move_emails', { messageIds: [messageId!], folder: 'inbox' });
      const deletedChild = await call('delete_folder', { folder: child });
      expect(deletedChild.structuredContent).toEqual({ data: { deleted: { id: child, name: child } } });
      const deletedParent = await call('delete_folder', { folder: parent });
      expect(deletedParent.structuredContent).toEqual({ data: { deleted: { id: parent, name: parent } } });
      const listed = (await call('list_folders', {})).structuredContent as { data: Array<{ id: string }> };
      expect(listed.data.map((folder) => folder.id)).not.toEqual(expect.arrayContaining([parent]));
      expect(listed.data.map((folder) => folder.id)).not.toEqual(expect.arrayContaining([child]));
      await expect(provider.getMessage(messageId!)).resolves.toMatchObject({ folder: { role: 'inbox' } });
    } finally {
      await client.close();
      await (provider as typeof provider & { close(): Promise<void> }).close();
      closeDb(db);
    }
  }, 20_000);
});

describe.skipIf(!host).sequential('IMAP folder renaming integration', () => {
  it('renames a folder over MCP, with its subfolder and mail, and refuses names it cannot take', async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-imap-folder-rename-')), 'fluxmail.db');
    const db = openDb(dbPath);
    const registry = new AccountRegistry(db, config(dbPath));
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('server@localhost', credentials, undefined, owner.id);
    const provider = registry.getProvider(account.id);
    const server = buildMcpServer(new EmailService(registry, db), { permissions: FULL_PERMISSION_POLICY });
    const client = new Client({ name: 'folders', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { accountId: account.id, ...args } });
    const errorOf = (result: Awaited<ReturnType<typeof call>>) =>
      JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { error: string; message: string };
    const folderIds = async () =>
      ((await call('list_folders', {})).structuredContent as { data: Array<{ id: string }> }).data.map(
        (folder) => folder.id,
      );
    try {
      // GreenMail separates levels with a dot.
      const stamp = Date.now();
      const parent = `Renamed ${stamp}`;
      const child = `${parent}.Receipts`;
      const other = `Other ${stamp}`;
      const renamedParent = `Filed ${stamp}`;
      expect((await call('create_folder', { name: child })).isError).toBeFalsy();
      expect((await call('create_folder', { name: other })).isError).toBeFalsy();

      const subject = `Folder rename over MCP ${stamp}`;
      await provider.send({ to: [{ email: 'server@localhost' }], subject, body: { text: 'keep me' } });
      let messageId: string | undefined;
      for (let attempt = 0; attempt < 30 && !messageId; attempt++) {
        messageId = (await provider.listMessages({ folder: 'inbox', subject })).items[0]?.id;
        if (!messageId) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(messageId).toBeTruthy();
      await call('move_emails', { messageIds: [messageId!], folder: child });

      const taken = await call('rename_folder', { folder: parent, name: other });
      expect(errorOf(taken)).toMatchObject({
        error: 'invalid_request',
        message: `A folder named "${other}" already exists. Choose another name.`,
      });
      const nestedName = await call('rename_folder', { folder: parent, name: `${other}.Inside` });
      expect(errorOf(nestedName)).toMatchObject({ error: 'invalid_request' });
      const inbox = await call('rename_folder', { folder: 'inbox', name: `Mine ${stamp}` });
      expect(errorOf(inbox)).toMatchObject({
        error: 'invalid_request',
        message: '"INBOX" is a system folder and can\'t be renamed.',
      });
      const missing = await call('rename_folder', { folder: `${parent}.Missing`, name: 'Found' });
      expect(errorOf(missing)).toMatchObject({
        error: 'not_found',
        message: `This mailbox has no folder named "${parent}.Missing".`,
      });
      expect(await folderIds()).toEqual(expect.arrayContaining([parent, child, other]));

      // The subfolder and its mail move with the renamed parent.
      const renamed = await call('rename_folder', { folder: parent, name: renamedParent });
      expect(renamed.structuredContent).toEqual({
        data: { folder: { id: renamedParent, name: renamedParent }, previous: { id: parent, name: parent } },
      });
      const after = await folderIds();
      expect(after).toEqual(expect.arrayContaining([renamedParent, `${renamedParent}.Receipts`]));
      expect(after).not.toContain(parent);
      expect(after).not.toContain(child);
      // The message keeps the ID it was listed under before the rename.
      const moved = await provider.listMessages({ folder: `${renamedParent}.Receipts`, subject });
      expect(moved.items.map((item) => item.id)).toEqual([messageId]);
      await expect(provider.getMessage(messageId!)).resolves.toMatchObject({
        folder: { id: `${renamedParent}.Receipts` },
      });

      const renamedChild = await call('rename_folder', { folder: `${renamedParent}.Receipts`, name: 'Invoices' });
      expect(renamedChild.structuredContent).toEqual({
        data: {
          folder: { id: `${renamedParent}.Invoices`, name: `${renamedParent}.Invoices` },
          previous: { id: `${renamedParent}.Receipts`, name: `${renamedParent}.Receipts` },
        },
      });
      const kept = await provider.listMessages({ folder: `${renamedParent}.Invoices`, subject });
      expect(kept.items.map((item) => item.id)).toEqual([messageId]);

      // Leave the shared mailbox as it was.
      const back = await call('move_emails', { messageIds: [messageId!], folder: 'inbox' });
      expect(back.structuredContent).toMatchObject({ data: { succeededIds: [messageId], failed: [] } });
      for (const folder of [`${renamedParent}.Invoices`, renamedParent, other]) {
        expect((await call('delete_folder', { folder })).isError).toBeFalsy();
      }
    } finally {
      await client.close();
      await (provider as typeof provider & { close(): Promise<void> }).close();
      closeDb(db);
    }
  }, 30_000);
});

describe.skipIf(!host).sequential('IMAP folder moving integration', () => {
  // GreenMail renames only within a folder's own parent, so the one move it can do is from the top level down.
  it('moves a folder over MCP, with its subfolder and mail, and refuses destinations it cannot take', async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-imap-folder-move-')), 'fluxmail.db');
    const db = openDb(dbPath);
    const registry = new AccountRegistry(db, config(dbPath));
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount('server@localhost', credentials, undefined, owner.id);
    const provider = registry.getProvider(account.id);
    const server = buildMcpServer(new EmailService(registry, db), { permissions: FULL_PERMISSION_POLICY });
    const client = new Client({ name: 'folders', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { accountId: account.id, ...args } });
    const errorOf = (result: Awaited<ReturnType<typeof call>>) =>
      JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { error: string; message: string };
    const folderIds = async () =>
      ((await call('list_folders', {})).structuredContent as { data: Array<{ id: string }> }).data.map(
        (folder) => folder.id,
      );
    try {
      // GreenMail separates levels with a dot.
      const stamp = Date.now();
      const source = `Moving ${stamp}`;
      const child = `${source}.Receipts`;
      const shelf = `Shelf ${stamp}`;
      expect((await call('create_folder', { name: child })).isError).toBeFalsy();
      expect((await call('create_folder', { name: shelf })).isError).toBeFalsy();

      const subject = `Folder move over MCP ${stamp}`;
      await provider.send({ to: [{ email: 'server@localhost' }], subject, body: { text: 'keep me' } });
      let messageId: string | undefined;
      for (let attempt = 0; attempt < 30 && !messageId; attempt++) {
        messageId = (await provider.listMessages({ folder: 'inbox', subject })).items[0]?.id;
        if (!messageId) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(messageId).toBeTruthy();
      await call('move_emails', { messageIds: [messageId!], folder: child });

      expect(errorOf(await call('move_folder', { folder: source, parent: child }))).toMatchObject({
        error: 'invalid_request',
        message: `"${child}" is inside "${source}", so "${source}" can't be moved into it.`,
      });
      expect(errorOf(await call('move_folder', { folder: source }))).toMatchObject({ error: 'invalid_request' });
      expect(errorOf(await call('move_folder', { folder: 'inbox', parent: shelf }))).toMatchObject({
        error: 'invalid_request',
        message: '"INBOX" is a system folder and can\'t be moved.',
      });
      expect(errorOf(await call('move_folder', { folder: source, parent: `${shelf}.Missing` }))).toMatchObject({
        error: 'not_found',
      });

      // The subfolder and its mail move with the folder, and the message keeps its ID.
      const moved = await call('move_folder', { folder: source, parent: shelf });
      expect(moved.structuredContent).toEqual({
        data: {
          folder: { id: `${shelf}.${source}`, name: `${shelf}.${source}` },
          previous: { id: source, name: source },
        },
      });
      const after = await folderIds();
      expect(after).toEqual(expect.arrayContaining([`${shelf}.${source}`, `${shelf}.${source}.Receipts`]));
      expect(after).not.toContain(source);
      const listed = await provider.listMessages({ folder: `${shelf}.${source}.Receipts`, subject });
      expect(listed.items.map((item) => item.id)).toEqual([messageId]);

      await expect(provider.getMessage(messageId!)).resolves.toMatchObject({
        folder: { id: `${shelf}.${source}.Receipts` },
      });

      // Leave the shared mailbox as it was.
      await call('move_emails', { messageIds: [messageId!], folder: 'inbox' });
      for (const folder of [`${shelf}.${source}.Receipts`, `${shelf}.${source}`, shelf]) {
        expect((await call('delete_folder', { folder })).isError).toBeFalsy();
      }
    } finally {
      await client.close();
      await (provider as typeof provider & { close(): Promise<void> }).close();
      closeDb(db);
    }
  }, 30_000);
});

describe.skipIf(!host).sequential('IMAP changes the folders rule out', () => {
  it('says why a move into or out of the trash folder is refused', async () => {
    // The trash folder has a name the literal move guard doesn't know. It is created once and kept, so
    // repeated runs don't fill the shared mailbox with folders.
    const bin = 'Bin';
    const imap = new ImapFlow({
      host: host!,
      port: imapPort,
      secure: true,
      auth: { user: 'server', pass: 'pwd2' },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    await imap.connect();
    try {
      if (!(await imap.list()).some((folder) => folder.path === bin)) await imap.mailboxCreate(bin);
    } finally {
      await imap.logout();
    }

    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fluxmail-imap-rejections-')), 'fluxmail.db');
    const db = openDb(dbPath);
    const registry = new AccountRegistry(db, config(dbPath));
    const owner = addMember(db, { name: 'Owner' });
    const account = registry.addImapAccount(
      'server@localhost',
      { ...credentials, folderOverrides: { ...credentials.folderOverrides, trash: bin } },
      undefined,
      owner.id,
    );
    const provider = registry.getProvider(account.id);
    const server = buildMcpServer(new EmailService(registry, db), { permissions: FULL_PERMISSION_POLICY });
    const client = new Client({ name: 'rejections', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { accountId: account.id, ...args } });
    const errorOf = (result: Awaited<ReturnType<typeof call>>) =>
      JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { error: string; message: string };
    const find = async (folder: string, subject: string) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const id = (await provider.listMessages({ folder, subject })).items[0]?.id;
        if (id) return id;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No message "${subject}" in ${folder}.`);
    };
    try {
      const subjects = [`Rejected move one ${Date.now()}`, `Rejected move two ${Date.now()}`];
      for (const subject of subjects) {
        await provider.send({ to: [{ email: 'server@localhost' }], subject, body: { text: 'keep me' } });
      }
      const ids = [await find('inbox', subjects[0]!), await find('inbox', subjects[1]!)];

      const intoTrash = {
        error: 'invalid_request',
        message: "That folder is this mailbox's trash. Trash these messages instead of moving them there.",
      };
      expect(errorOf(await call('move_emails', { messageIds: ids, folder: bin }))).toMatchObject(intoTrash);
      expect(errorOf(await call('move_emails', { messageIds: [ids[0]], folder: bin }))).toMatchObject(intoTrash);
      await expect(provider.getMessage(ids[0]!)).resolves.toMatchObject({ folder: { role: 'inbox' } });

      const trashedResult = await call('trash_emails', { messageIds: ids });
      expect(trashedResult.isError).toBeFalsy();
      const trashed = [await find('trash', subjects[0]!), await find('trash', subjects[1]!)];
      const inTrash = {
        error: 'invalid_request',
        message: 'These messages are in the trash. Restore them before moving or archiving them.',
      };
      expect(errorOf(await call('move_emails', { messageIds: trashed, folder: 'inbox' }))).toMatchObject(inTrash);
      expect(errorOf(await call('archive_emails', { messageIds: [trashed[0]] }))).toMatchObject(inTrash);

      const restored = await call('restore_emails', { messageIds: trashed });
      expect(restored.structuredContent).toMatchObject({ data: { succeededIds: trashed, failed: [] } });
    } finally {
      await client.close();
      await (provider as typeof provider & { close(): Promise<void> }).close();
      closeDb(db);
    }
  }, 30_000);
});
