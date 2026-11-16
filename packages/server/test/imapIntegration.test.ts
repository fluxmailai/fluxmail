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

const credentials: ImapCredentials = {
  imap: { host: host!, port: 3993, security: 'tls', user: 'server', password: 'pwd2' },
  smtp: { host: host!, port: 3465, security: 'tls', user: 'server', password: 'pwd2' },
  saveSent: true,
  folderOverrides: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', archive: 'Archive', spam: 'Spam' },
};

describe.skipIf(!host).sequential('IMAP account persistence integration', () => {
  it('validates credentials and restores drafts and stable IDs after a database restart', async () => {
    const admin = new ImapFlow({
      host: host!,
      port: 3993,
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
