// Controlled provider for process integration tests. No real mail provider is loaded.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DraftInput, EmailProvider, Message } from '@fluxmail/core';
import { GMAIL_CAPABILITIES } from '@fluxmail/provider-gmail';
import { AccountRegistry } from '../../src/accounts/registry.js';
import { runCli } from '../../src/cli.js';
import { EmailService } from '../../src/service/emailService.js';

const directory = process.env.FLUXMAIL_DATA_DIR!;
const pause = async () => {
  writeFileSync(path.join(directory, 'crash-point'), 'paused');
  await new Promise<void>(() => {});
};
const crashPoint = process.env.FLUXMAIL_FIXTURE_CRASH_POINT;
const getDraft = async (id: string): Promise<Message> => {
  const draft = JSON.parse(readFileSync(path.join(directory, `${id}.json`), 'utf8')) as Message;
  if (crashPoint === 'before-dispatch') await pause();
  return draft;
};
const provider = {
  capabilities: GMAIL_CAPABILITIES,
  async createDraft(input: DraftInput): Promise<Message> {
    const id = `fixture_${randomUUID()}`;
    const draft: Message = {
      id,
      draftId: id,
      threadId: id,
      accountId: 'acct_fixture',
      to: input.to ?? [],
      subject: input.subject ?? '',
      body: input.body,
      date: new Date().toISOString(),
      attachments: [],
      flags: { read: true, starred: false, draft: true },
    };
    writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(draft));
    return draft;
  },
  getDraft,
  async getAttachment() {
    return {
      meta: { id: 'a1', filename: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 2 },
      content: Buffer.from('hi'),
    };
  },
  async send(input: { draftId: string }) {
    await getDraft(input.draftId);
    const result = { id: `sent_${input.draftId}`, threadId: input.draftId };
    appendFileSync(path.join(directory, 'deliveries.jsonl'), `${JSON.stringify(result)}\n`);
    if (crashPoint === 'provider-pending') await pause();
    return result;
  },
} as unknown as EmailProvider;

AccountRegistry.prototype.getProvider = function (id: string) {
  if (id !== 'acct_fixture') throw new Error('Unexpected fixture account');
  return provider;
};

const deliverScheduled = EmailService.prototype.deliverScheduled;
EmailService.prototype.deliverScheduled = async function (...args) {
  const operation = await deliverScheduled.apply(this, args);
  if (crashPoint === 'after-success') await pause();
  return operation;
};

await runCli();
