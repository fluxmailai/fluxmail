import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmailError, type Message } from '@fluxmail/core';
import type { FluxmailConfig } from '../src/config.js';
import { createRestApi } from '../src/http/rest.js';
import { FULL_PERMISSION_POLICY, customPermissionPolicy, permissionPolicyForProfile } from '../src/permissions.js';
import { createApiKey } from '../src/storage/apiKeys.js';
import { openDb, restIdempotency } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';
import { listAdminAuditEvents } from '../src/storage/adminAudit.js';
import { createTelemetry, type Telemetry } from '../src/telemetry.js';

const account = {
  id: 'acct_1',
  provider: 'gmail' as const,
  email: 'me@example.com',
  status: 'active' as const,
  capabilities: { labels: true, serverThreads: true, serverSearch: 'rich' as const, snippets: true },
  ownerMemberId: 'member_1',
  sharedWithAll: false,
  grantedMemberIds: [],
};
const message: Message = {
  id: 'msg_1',
  threadId: 'thread_1',
  accountId: account.id,
  from: { name: 'Ann', email: 'ann@example.com' },
  to: [{ email: account.email }],
  subject: 'Hello',
  date: '2026-07-14T12:00:00.000Z',
  searchContext: { status: 'matched', excerpt: 'Invoice [ORDER_ID] is ready.' },
  body: { text: 'Hello there' },
  attachments: [],
  flags: { read: false, starred: false, draft: false },
};

function fixture(telemetry?: Telemetry) {
  const db = openDb(':memory:');
  const member = addMember(db, { id: 'member_1', name: 'Owner', role: 'admin' });
  const { key, info: keyInfo } = createApiKey(db, 'test', member.id, FULL_PERMISSION_POLICY);
  const config: FluxmailConfig = {
    dataDir: ':memory:',
    dbPath: ':memory:',
    encryptionKey: Buffer.alloc(32),
    port: 8977,
    publicUrl: 'http://localhost:8977',
    publicUrlConfigured: false,
    oauthPort: 8976,
    oauthHost: '127.0.0.1',
    maxAttachmentBytes: 1024,
    licenseServerUrl: 'https://license.invalid',
  };
  const scheduled = {
    scheduleId: 'schedule_1',
    accountId: account.id,
    draftId: 'draft_1',
    sendAt: '2026-08-01T12:00:00.000Z',
    status: 'pending' as const,
    attempts: 0,
  };
  const service = {
    withPrincipal: vi.fn(),
    assertAccountAccess: vi.fn(() => undefined),
    enforceQuota: vi.fn(() => undefined),
    status: vi.fn(async () => ({ accounts: [], providersAvailable: ['gmail'], scheduled: { pending: 0 } })),
    listAccounts: vi.fn(() => [account]),
    listFolders: vi.fn(async () => [{ id: 'INBOX', name: 'Inbox', role: 'inbox' as const }]),
    listLabels: vi.fn(async () => [{ id: 'Label_1', name: 'private-project' }]),
    listSendAs: vi.fn(async () => [
      { email: 'me@example.com', isPrimary: true, source: 'provider' as const },
      { email: 'private-alias@example.com', isPrimary: false, source: 'provider' as const },
    ]),
    replaceSendAs: vi.fn(async () => [{ email: 'me@example.com', isPrimary: true, source: 'configured' as const }]),
    listMessages: vi.fn(async () => ({ items: [message], nextPageToken: 'next_1', exhausted: false })),
    searchMessagesBatch: vi.fn(async () => ({
      groups: [
        { accountId: 'acct_1', page: { items: [message], exhausted: true } },
        {
          accountId: 'acct_2',
          error: { code: 'provider_unavailable', message: 'Search timed out.', exhausted: false as const },
        },
      ],
      exhausted: false,
    })),
    getMessage: vi.fn(async () => message),
    getDraft: vi.fn(async () => ({ ...message, draftId: 'draft_1', flags: { ...message.flags, draft: true } })),
    previewSend: vi.fn(async () => ({
      accountId: account.id,
      from: account.email,
      to: draftBody.to,
      cc: [],
      bcc: [],
      subject: 'Hello',
      attachments: [],
      bodyTextChars: 6,
      bodyHtmlChars: 0,
    })),
    getThread: vi.fn(async () => ({ id: 'thread_1', subject: 'Hello', messages: [message] })),
    createDraft: vi.fn(async () => ({ ...message, draftId: 'draft_1', flags: { ...message.flags, draft: true } })),
    updateDraft: vi.fn(async () => ({ ...message, draftId: 'draft_1', flags: { ...message.flags, draft: true } })),
    deleteDraft: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ id: 'sent_1', threadId: 'thread_1' })),
    deliver: vi.fn(async () => ({
      operationId: 'dop_1',
      accountId: account.id,
      kind: 'send',
      status: 'succeeded',
      result: { id: 'sent_1', threadId: 'thread_1' },
    })),
    getDelivery: vi.fn(() => ({
      operationId: 'dop_1',
      accountId: account.id,
      kind: 'send',
      status: 'succeeded',
      result: { id: 'sent_1', threadId: 'thread_1' },
    })),
    scheduleSend: vi.fn(async () => scheduled),
    scheduleDelivery: vi.fn(async () => ({
      operationId: 'dop_2',
      accountId: account.id,
      kind: 'scheduled',
      status: 'queued',
      scheduleId: 'schedule_1',
    })),
    listScheduled: vi.fn(() => [scheduled]),
    cancelScheduled: vi.fn(() => ({
      scheduleId: scheduled.scheduleId,
      draftId: scheduled.draftId,
      draftKept: true as const,
    })),
    forward: vi.fn(async () => ({ id: 'sent_forward', threadId: 'thread_1' })),
    deliverForward: vi.fn(async () => ({
      operationId: 'dop_3',
      accountId: account.id,
      kind: 'forward',
      status: 'succeeded',
      result: { id: 'sent_forward', threadId: 'thread_1' },
    })),
    modify: vi.fn(async (_accountId: string, ids: string[]) => ({ succeededIds: ids, failed: [], uncertainIds: [] })),
    getAttachment: vi.fn(async () => ({
      meta: { id: 'att_1', filename: 'report.txt', mimeType: 'text/plain', sizeBytes: 5 },
      content: Buffer.from('hello'),
    })),
  };
  service.withPrincipal.mockReturnValue(service);
  const app = createRestApi({ config, db, service: service as never, telemetry });
  const auth = { authorization: `Bearer ${key}` };
  return { app, auth, config, db, key, keyInfo, member, service, scheduled };
}

const draftBody = {
  to: [{ email: 'ann@example.com', name: 'Ann' }],
  subject: 'Hello',
  body: { text: 'Hi Ann' },
};

function jsonRequest(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe('REST API discovery and authentication', () => {
  it('serves public discovery and an OpenAPI 3.1 contract', async () => {
    const { app } = fixture();
    const discovery = await app.request('/api/v1');
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      data: { name: 'fluxmail', openapi: '/api/v1/openapi.json' },
    });

    const response = await app.request('/api/v1/openapi.json');
    expect(response.status).toBe(200);
    // oxlint-disable-next-line typescript/no-explicit-any -- The assertions inspect a dynamic OpenAPI document.
    const document = (await response.json()) as Record<string, any>;
    expect(document.openapi).toBe('3.1.0');
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(document.components.securitySchemes.memberSessionAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(document.paths['/api/v1/me/password'].put.security).toEqual([{ memberSessionAuth: [] }]);
    expect(document.paths['/api/v1/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(document.components.schemas.ForwardRequest.properties.includeAttachments).toMatchObject({
      type: 'boolean',
      default: true,
      description: 'Include attachments from the original message. Defaults to true.',
    });
    expect(document.components.schemas.DraftRequest.properties.from).toMatchObject({ type: 'string', format: 'email' });
    expect(document.paths['/api/v1/accounts/{accountId}/send-as'].get.operationId).toBe('listSendAs');
    expect(document.paths['/api/v1/accounts/{accountId}/send-as'].put.operationId).toBe('replaceSendAs');
    expect(document.components.schemas.ModifyMessagesRequest.properties.folder.description).toMatch(
      /Required when action is move/,
    );
    expect(document.components.schemas.ModifyMessagesRequest.properties.labels.description).toMatch(
      /Required when action is addLabels or removeLabels/,
    );
    expect(
      document.paths['/api/v1/admin/connections'].post.requestBody.content['application/json'].schema.example,
    ).toEqual({ provider: 'gmail', ownerMemberId: 'you@example.com' });
    expect(
      document.paths['/api/v1/admin/imap/tests'].post.requestBody.content['application/json'].schema.example,
    ).toMatchObject({ imap: { port: 993 }, smtp: { port: 465 } });
    expect(
      document.paths['/api/v1/admin/api-keys'].post.requestBody.content['application/json'].schema.example,
    ).toEqual({ name: 'reporting', member: 'you@example.com', permissionProfile: 'read-only' });
    expect(
      document.paths['/api/v1/admin/api-keys/{keyId}'].patch.requestBody.content['application/json'].schema.example,
    ).toEqual({ permissionProfile: 'read-only' });
    expect(
      document.paths['/api/v1/admin/oauth-apps/{provider}'].put.requestBody.content['application/json'].schema.example,
    ).toEqual({ clientId: 'client-id.apps.example.com', clientSecret: 'client-secret' });
    expect(
      document.paths['/api/v1/admin/accounts/{accountId}/imap/folders'].patch.requestBody.content['application/json']
        .schema.example,
    ).toEqual({ sent: 'Sent' });
    expect(document.paths['/api/v1/accounts/{accountId}/send'].post.operationId).toBe('sendMessage');
    expect(document.paths['/api/v1/accounts/{accountId}/send'].post.requestBody.required).toBe(true);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/accounts/{accountId}/messages',
        '/api/v1/accounts/{accountId}/labels',
        '/api/v1/accounts/{accountId}/send',
        '/api/v1/accounts/{accountId}/messages/{messageId}/attachments/{attachmentId}',
      ]),
    );
  });

  it('requires bearer authentication and ignores query-string keys', async () => {
    const { app, key, member, service } = fixture();
    const missing = await app.request('/api/v1/status');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(await missing.json()).toEqual({
      error: { code: 'unauthorized', message: 'Pass a member session or API key as a Bearer token.' },
    });
    expect((await app.request(`/api/v1/status?key=${key}`)).status).toBe(401);

    const authorized = await app.request('/api/v1/status', { headers: { authorization: `Bearer ${key}` } });
    expect(authorized.status).toBe(200);
    expect(service.withPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key',
        memberId: member.id,
        role: 'admin',
        accountIds: null,
      }),
    );
  });

  it('never trusts an unauthenticated local network request', async () => {
    const { app, service } = fixture();
    expect((await app.request('/api/v1/status')).status).toBe(401);
    expect((await app.request('/api/v1/accounts/acct_1/folders')).status).toBe(401);
    expect(service.withPrincipal).not.toHaveBeenCalled();
  });
});

describe('REST email operations', () => {
  it('lists sender addresses and protects idempotent alias replacement with admin.accounts', async () => {
    const { app, auth, db, member, service } = fixture();
    const listed = await app.request('/api/v1/accounts/acct_1/send-as', { headers: auth });
    expect(listed.status).toBe(200);
    expect(service.listSendAs).toHaveBeenCalledWith('acct_1');

    const body = { identities: [{ email: 'private-alias@example.com', name: 'Sales' }] };
    const denied = await app.request('/api/v1/accounts/acct_1/send-as', jsonRequest('PUT', body, auth));
    expect(denied.status).toBe(403);
    expect(service.replaceSendAs).not.toHaveBeenCalled();

    const { key: adminKey } = createApiKey(
      db,
      'account admin',
      member.id,
      permissionPolicyForProfile('full', ['admin.accounts']),
    );
    const adminAuth = { authorization: `Bearer ${adminKey}` };
    const first = await app.request('/api/v1/accounts/acct_1/send-as', jsonRequest('PUT', body, adminAuth));
    const second = await app.request('/api/v1/accounts/acct_1/send-as', jsonRequest('PUT', body, adminAuth));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(service.replaceSendAs).toHaveBeenCalledTimes(2);
    expect(service.replaceSendAs).toHaveBeenNthCalledWith(1, 'acct_1', body.identities);
    expect(service.replaceSendAs).toHaveBeenNthCalledWith(2, 'acct_1', body.identities);
    expect(listAdminAuditEvents(db).filter((event) => event.operation === 'put /api/v1/accounts/:id/send-as')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'success', resourceType: 'account', resourceId: 'acct_1' }),
        expect.objectContaining({ outcome: 'error', errorCode: 'permission_denied' }),
      ]),
    );
  });

  it('routes the full read, draft, schedule, action, and attachment surface', async () => {
    const { app, auth, service } = fixture();
    expect((await app.request('/api/v1/accounts', { headers: auth })).status).toBe(200);
    expect((await app.request('/api/v1/accounts/acct_1/folders', { headers: auth })).status).toBe(200);
    const labels = await app.request('/api/v1/accounts/acct_1/labels', { headers: auth });
    expect(labels.status).toBe(200);
    await expect(labels.json()).resolves.toEqual({ data: [{ id: 'Label_1', name: 'private-project' }] });
    expect(service.listLabels).toHaveBeenCalledWith('acct_1');

    const listed = await app.request(
      '/api/v1/accounts/acct_1/messages?read=false&text=invoice&pageSize=25&includeSearchContext=true',
      { headers: auth },
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      data: [{ id: 'msg_1', searchContext: { status: 'matched', excerpt: 'Invoice [ORDER_ID] is ready.' } }],
      meta: { nextPageToken: 'next_1' },
    });
    expect(service.listMessages).toHaveBeenCalledWith(
      'acct_1',
      { text: 'invoice', read: false },
      { pageSize: 25, includeSearchContext: true },
    );

    const batch = await app.request(
      '/api/v1/messages/search',
      jsonRequest(
        'POST',
        {
          accounts: [{ accountId: 'acct_1' }, { accountId: 'acct_2', pageToken: 'continue_2' }],
          query: 'subject:report',
          text: 'invoice',
          folder: 'inbox',
          includeSnippet: true,
          includeSearchContext: true,
        },
        auth,
      ),
    );
    expect(batch.status).toBe(200);
    expect(await batch.json()).toMatchObject({
      data: [
        { accountId: 'acct_1', meta: { exhausted: true } },
        { accountId: 'acct_2', error: { code: 'provider_unavailable', exhausted: false } },
      ],
      meta: { exhausted: false },
    });
    expect(service.searchMessagesBatch).toHaveBeenCalledWith({
      accounts: [{ accountId: 'acct_1' }, { accountId: 'acct_2', pageToken: 'continue_2' }],
      query: { text: 'invoice', subject: 'report', folder: 'inbox' },
      includeSnippet: true,
      includeSearchContext: true,
    });

    expect((await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth })).status).toBe(200);
    expect((await app.request('/api/v1/accounts/acct_1/threads/thread_1', { headers: auth })).status).toBe(200);

    expect((await app.request('/api/v1/accounts/acct_1/drafts', jsonRequest('POST', draftBody, auth))).status).toBe(
      201,
    );
    expect(
      (await app.request('/api/v1/accounts/acct_1/drafts/draft_1', jsonRequest('PUT', draftBody, auth))).status,
    ).toBe(200);
    expect(
      (await app.request('/api/v1/accounts/acct_1/drafts/draft_1', jsonRequest('DELETE', undefined, auth))).status,
    ).toBe(200);

    expect((await app.request('/api/v1/accounts/acct_1/scheduled-sends', { headers: auth })).status).toBe(200);
    expect(
      (await app.request('/api/v1/accounts/acct_1/scheduled-sends/schedule_1', jsonRequest('DELETE', undefined, auth)))
        .status,
    ).toBe(200);

    const modified = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'markRead' }, auth),
    );
    expect(modified.status).toBe(200);
    expect(service.modify).toHaveBeenCalledWith('acct_1', ['msg_1'], 'markRead');

    const attachment = await app.request('/api/v1/accounts/acct_1/messages/msg_1/attachments/att_1', { headers: auth });
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get('content-type')).toBe('text/plain');
    expect(attachment.headers.get('content-disposition')).toContain('report.txt');
    await expect(attachment.text()).resolves.toBe('hello');
  });

  it('strictly validates query strings and JSON bodies', async () => {
    const { app, auth } = fixture();
    const badBoolean = await app.request('/api/v1/accounts/acct_1/messages?read=1', { headers: auth });
    expect(badBoolean.status).toBe(400);
    const unknownQuery = await app.request('/api/v1/accounts/acct_1/messages?typo=true', { headers: auth });
    expect(unknownQuery.status).toBe(400);
    const badDate = await app.request('/api/v1/accounts/acct_1/messages?after=2026-02-30', { headers: auth });
    expect(badDate.status).toBe(400);
    const unknownBody = await app.request(
      '/api/v1/accounts/acct_1/drafts',
      jsonRequest('POST', { ...draftBody, typo: true }, auth),
    );
    expect(unknownBody.status).toBe(400);
    const replyAll = await app.request(
      '/api/v1/accounts/acct_1/drafts',
      jsonRequest('POST', { body: { text: 'Reply' }, replyAll: true }, auth),
    );
    expect(replyAll.status).toBe(400);
    const draftWithSender = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest(
        'POST',
        { draftId: 'draft_1', from: 'sales@example.com' },
        { ...auth, 'idempotency-key': 'draft-with-sender' },
      ),
    );
    expect(draftWithSender.status).toBe(400);
    const badAttachment = await app.request(
      '/api/v1/accounts/acct_1/drafts',
      jsonRequest(
        'POST',
        {
          body: { text: 'Attachment' },
          attachments: [{ filename: 'x.txt', mimeType: 'text/plain', content: 'not base64' }],
        },
        auth,
      ),
    );
    expect(badAttachment.status).toBe(400);

    const missingBody = await app.request('/api/v1/accounts/acct_1/drafts', {
      method: 'POST',
      headers: auth,
    });
    expect(missingBody.status).toBe(400);

    const wrongContentType = await app.request('/api/v1/accounts/acct_1/drafts', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/plain' },
      body: JSON.stringify(draftBody),
    });
    expect(wrongContentType.status).toBe(400);
    expect((await wrongContentType.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid_request' },
    });
  });

  it('parses typed portable search syntax and returns warnings in metadata', async () => {
    const { app, auth, service } = fixture();
    const typed = await app.request(
      `/api/v1/accounts/acct_1/messages?query=${encodeURIComponent('from:ann@example.com is:unread quarterly')}`,
      { headers: auth },
    );
    expect(typed.status).toBe(200);
    expect(service.listMessages).toHaveBeenLastCalledWith(
      'acct_1',
      { from: 'ann@example.com', read: false, text: 'quarterly' },
      {},
    );

    const warned = await app.request(
      `/api/v1/accounts/acct_1/messages?query=${encodeURIComponent('form:ann@example.com')}`,
      { headers: auth },
    );
    expect(warned.status).toBe(200);
    await expect(warned.json()).resolves.toMatchObject({
      meta: {
        diagnostics: [
          {
            code: 'possible_operator_typo',
            severity: 'warning',
            suggestion: 'from',
          },
        ],
      },
    });

    const duplicate = await app.request(
      `/api/v1/accounts/acct_1/messages?query=${encodeURIComponent('from:ann@example.com')}&from=bob@example.com`,
      { headers: auth },
    );
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: {
        code: 'invalid_request',
        data: { diagnostics: [expect.objectContaining({ severity: 'error' })] },
      },
    });
  });

  it('returns typed-query warnings in successful batch group metadata', async () => {
    const { app, auth, service } = fixture();
    const response = await app.request(
      '/api/v1/messages/search',
      jsonRequest('POST', { accounts: [{ accountId: 'acct_1' }], query: 'form:ann@example.com' }, auth),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ accountId: string; meta?: { diagnostics?: unknown[] } }>;
    };
    expect(body.data[0]).toMatchObject({
      accountId: 'acct_1',
      meta: {
        diagnostics: [
          {
            code: 'possible_operator_typo',
            severity: 'warning',
            suggestion: 'from',
          },
        ],
      },
    });
    expect(service.searchMessagesBatch).toHaveBeenCalledWith({
      accounts: [{ accountId: 'acct_1' }],
      query: { text: 'form:ann@example.com' },
    });
  });

  it('maps provider errors without exposing internal failures', async () => {
    const { app, auth, service } = fixture();
    service.getMessage.mockRejectedValueOnce(new EmailError('provider_unavailable', 'Gmail is unavailable.'));
    const unavailable = await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: {
        code: 'provider_unavailable',
        message: 'The mail provider could not complete the request.',
        requestId: expect.any(String),
      },
    });

    service.getMessage.mockRejectedValueOnce(new Error('database password leaked'));
    const internal = await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth });
    expect(internal.status).toBe(500);
    await expect(internal.json()).resolves.toMatchObject({
      error: { code: 'internal', message: 'The request could not be completed.', requestId: expect.any(String) },
    });

    service.getMessage.mockRejectedValueOnce(
      new EmailError('rate_limited', 'private throttle response', { retryAfterMs: 12_000 }),
    );
    const throttled = await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('12');
    const error = await throttled.json();
    expect(error).toMatchObject({ error: { code: 'rate_limited', data: { retryAfterMs: 12_000 } } });
    expect(JSON.stringify(error)).not.toContain('private throttle response');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'omits an invalid provider retry delay of %s',
    async (retryAfterMs) => {
      const { app, auth, service } = fixture();
      service.getMessage.mockRejectedValueOnce(
        new EmailError('rate_limited', 'private throttle response', { retryAfterMs }),
      );
      const response = await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBeNull();
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'rate_limited', requestId: expect.any(String) } });
      expect(JSON.stringify(body)).not.toContain('private throttle response');
      expect(JSON.stringify(body)).not.toContain('retryAfterMs');
    },
  );

  it('links a safe error response to its local log entry', async () => {
    const { auth, config, db, service } = fixture();
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(), flush: vi.fn(), close: vi.fn() };
    const app = createRestApi({ config, db, service: service as never, logger: logger as never });
    service.getMessage.mockRejectedValueOnce(new Error('private database password'));
    const response = await app.request('/api/v1/accounts/acct_1/messages/msg_1', { headers: auth });
    const body = (await response.json()) as { error: { requestId: string } };
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    expect(JSON.stringify([...warn.mock.calls, ...logger.error.mock.calls])).toContain(body.error.requestId);
    expect(JSON.stringify(body)).not.toContain('private database password');
  });

  it('keeps status available when plan quota blocks other operations', async () => {
    const { app, auth, service } = fixture();
    service.enforceQuota.mockImplementation(() => {
      throw new EmailError('entitlement_exceeded', 'The instance is over its plan limits.');
    });
    expect((await app.request('/api/v1/status', { headers: auth })).status).toBe(200);
    const accounts = await app.request('/api/v1/accounts', { headers: auth });
    expect(accounts.status).toBe(403);
    const batch = await app.request(
      '/api/v1/messages/search',
      jsonRequest('POST', { accounts: [{ accountId: 'acct_1' }], query: 'invoice' }, auth),
    );
    expect(batch.status).toBe(403);
    expect(service.searchMessagesBatch).not.toHaveBeenCalled();
  });

  it('returns JSON errors for malformed bodies and oversized attachments', async () => {
    const { app, auth, service } = fixture();
    const malformed = await app.request('/api/v1/accounts/acct_1/drafts', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });

    service.getAttachment.mockResolvedValueOnce({
      meta: { id: 'att_1', filename: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: 1025 },
      content: Buffer.alloc(1025),
    });
    const attachment = await app.request('/api/v1/accounts/acct_1/messages/msg_1/attachments/att_1', { headers: auth });
    expect(attachment.status).toBe(400);
    await expect(attachment.json()).resolves.toMatchObject({
      error: {
        code: 'invalid_request',
        message: 'Attachment is too large to return through the REST API, which returns attachments up to 1024 bytes.',
      },
    });

    service.getAttachment.mockRejectedValueOnce(
      new EmailError('invalid_request', 'Attachment is too large to return through MCP.', {
        sizeBytes: 2048,
        maxBytes: 1024,
      }),
    );
    const providerLimit = await app.request('/api/v1/accounts/acct_1/messages/msg_1/attachments/att_1', {
      headers: auth,
    });
    expect(providerLimit.status).toBe(400);
    await expect(providerLimit.json()).resolves.toMatchObject({
      error: {
        code: 'invalid_request',
        message: 'Attachment is too large to return through the REST API, which returns attachments up to 1024 bytes.',
      },
    });
  });

  it('sanitizes attachment filenames before writing response headers', async () => {
    const { app, auth, service } = fixture();
    service.getAttachment.mockResolvedValueOnce({
      meta: {
        id: 'att_1',
        filename: '../../report"\r\nX-Test: injected.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
      },
      content: Buffer.from('hello'),
    });
    const response = await app.request('/api/v1/accounts/acct_1/messages/msg_1/attachments/att_1', {
      headers: auth,
    });
    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).not.toContain('../');
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
  });

  it('records operation telemetry without request data', async () => {
    const { auth, config, db, service } = fixture();
    const capture = vi.fn();
    const warn = vi.fn();
    const logError = vi.fn();
    const app = createRestApi({
      config,
      db,
      service: service as never,
      telemetry: { capture, shutdown: async () => undefined },
      logger: {
        info: vi.fn(),
        warn,
        error: logError,
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      },
    });
    expect((await app.request('/api/v1')).status).toBe(200);
    expect((await app.request('/api/v1/status', { headers: auth })).status).toBe(200);
    expect((await app.request('/api/v1/accounts/acct_1/labels', { headers: auth })).status).toBe(200);
    expect((await app.request('/api/v1/accounts/acct_1/send-as', { headers: auth })).status).toBe(200);
    const privateQuery = 'from:private@example.com from:other@example.com';
    expect(
      (
        await app.request(`/api/v1/accounts/acct_1/messages?query=${encodeURIComponent(privateQuery)}`, {
          headers: auth,
        })
      ).status,
    ).toBe(400);
    const successfulBatchQuery = 'private-success-search subject:invoice';
    service.searchMessagesBatch.mockResolvedValueOnce({
      groups: [
        {
          accountId: 'acct_1',
          page: {
            items: [{ searchContext: { status: 'matched', excerpt: 'private REST body excerpt' } }],
            exhausted: true,
          },
        },
      ],
      exhausted: true,
    });
    expect(
      (
        await app.request(
          '/api/v1/messages/search',
          jsonRequest(
            'POST',
            {
              accounts: [{ accountId: 'acct_1' }],
              query: successfulBatchQuery,
              includeSearchContext: true,
            },
            auth,
          ),
        )
      ).status,
    ).toBe(200);
    const privateBatchQuery = 'subject:private-batch-search';
    expect(
      (
        await app.request(
          '/api/v1/messages/search',
          jsonRequest(
            'POST',
            { accounts: [{ accountId: 'acct_1' }, { accountId: 'acct_2' }], query: privateBatchQuery },
            auth,
          ),
        )
      ).status,
    ).toBe(200);
    service.listLabels.mockRejectedValueOnce(new EmailError('permission_denied', 'private-project denied'));
    expect((await app.request('/api/v1/accounts/acct_1/labels', { headers: auth })).status).toBe(403);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'getApiInfo', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'searchMessages',
        outcome: 'success',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'searchMessages',
        outcome: 'error',
        error_code: 'account_failure',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'listSendAs', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'getStatus', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'rest', operation: 'listLabels', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'listLabels',
        outcome: 'error',
        error_code: 'permission_denied',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'listMessages',
        outcome: 'error',
        error_code: 'invalid_request',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('me@example.com');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-project');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-alias@example.com');
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateQuery);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateBatchQuery);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(successfulBatchQuery);
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private REST body excerpt');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('acct_2');
    expect(warn).toHaveBeenCalledWith(
      'rest.operation_failed',
      'private-project denied',
      expect.objectContaining({ code: 'permission_denied' }),
      expect.objectContaining({ productSurface: 'rest', operation: 'listLabels' }),
    );
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('REST permissions', () => {
  it('enforces permission profiles and reply-derived read access', async () => {
    const { app, db, member } = fixture();
    const { key: readKey, info: readInfo } = createApiKey(
      db,
      'reader',
      member.id,
      permissionPolicyForProfile('read-only'),
    );
    const readAuth = { authorization: `Bearer ${readKey}` };
    expect((await app.request('/api/v1/accounts', { headers: readAuth })).status).toBe(200);
    const denied = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', draftBody, { ...readAuth, 'idempotency-key': 'read-denied' }),
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatchObject({
      code: 'permission_denied',
      message:
        'This API key does not allow: mail.send. To enable it, an administrator can run ' +
        `"fluxmail apikey permissions ${readInfo.id} --profile full".`,
      data: { missingCapabilities: ['mail.send'] },
    });

    const { key: draftsKey } = createApiKey(db, 'drafts-only', member.id, customPermissionPolicy(['mail.drafts']));
    const replyDenied = await app.request(
      '/api/v1/accounts/acct_1/drafts',
      jsonRequest(
        'POST',
        { body: { text: 'Reply' }, replyToMessageId: 'msg_1' },
        { authorization: `Bearer ${draftsKey}` },
      ),
    );
    expect(replyDenied.status).toBe(403);

    const { key: writeKey } = createApiKey(db, 'writer', member.id, permissionPolicyForProfile('read-write'));
    const writeAuth = { authorization: `Bearer ${writeKey}` };
    expect(
      (
        await app.request(
          '/api/v1/accounts/acct_1/drafts',
          jsonRequest('POST', { body: { text: 'Reply' }, replyToMessageId: 'msg_1' }, writeAuth),
        )
      ).status,
    ).toBe(201);
  });

  it('keeps protected folders behind dedicated actions', async () => {
    const { app, auth, service } = fixture();
    const move = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'move', folder: 'Trash' }, auth),
    );
    expect(move.status).toBe(400);
    expect(service.modify).not.toHaveBeenCalled();
  });

  it('defers label-name validation to the provider', async () => {
    const { app, auth, service } = fixture();
    const labels = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'addLabels', labels: ['Important'] }, auth),
    );
    expect(labels.status).toBe(200);
    expect(service.modify).toHaveBeenCalledWith('acct_1', ['msg_1'], { addLabels: ['Important'] });
  });

  it('maps each message action to its own capability', async () => {
    const { app, db, member, service } = fixture();
    const { key } = createApiKey(db, 'trash-only', member.id, customPermissionPolicy(['mail.trash']));
    const headers = { authorization: `Bearer ${key}` };
    const trash = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'trash' }, headers),
    );
    expect(trash.status).toBe(200);
    const archive = await app.request(
      '/api/v1/accounts/acct_1/messages/actions',
      jsonRequest('POST', { messageIds: ['msg_1'], action: 'archive' }, headers),
    );
    expect(archive.status).toBe(403);
    expect(service.modify).toHaveBeenCalledTimes(1);
  });
});

describe('REST send idempotency', () => {
  it('replays a pre-upgrade REST record during its original lifetime', async () => {
    const { app, auth, db, keyInfo, service } = fixture();
    const requestHash = createHash('sha256')
      .update(
        '{"operation":"sendMessage","request":{"accountId":"acct_1","input":{"body":{"text":"Hi Ann"},"subject":"Hello","to":[{"email":"ann@example.com","name":"Ann"}]}}}',
      )
      .digest('hex');
    const oldBody = JSON.stringify({ data: { id: 'sent_old', threadId: 'thread_old' } });
    db.insert(restIdempotency)
      .values({
        principalId: keyInfo.id,
        idempotencyKey: 'old-key',
        requestHash,
        state: 'completed',
        responseStatus: 200,
        responseBody: oldBody,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })
      .run();
    const replay = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', draftBody, { ...auth, 'idempotency-key': 'old-key' }),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(await replay.text()).toBe(oldBody);
    expect(service.deliver).not.toHaveBeenCalled();
  });

  it('provides draft lookup and a side effect free preview', async () => {
    const { app, auth, service } = fixture();
    const draft = await app.request('/api/v1/accounts/acct_1/drafts/draft_1', { headers: auth });
    expect(draft.status).toBe(200);
    await expect(draft.json()).resolves.toMatchObject({ data: { draftId: 'draft_1' } });
    const preview = await app.request('/api/v1/accounts/acct_1/send/preview', jsonRequest('POST', draftBody, auth));
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({ data: { subject: 'Hello', from: 'me@example.com' } });
    expect(service.previewSend).toHaveBeenCalledOnce();
    expect(service.deliver).not.toHaveBeenCalled();
  });

  it('records lookup and preview outcomes without private input', async () => {
    const { auth, config, db, service } = fixture();
    const capture = vi.fn();
    const app = createRestApi({
      config,
      db,
      service: service as never,
      telemetry: { capture, shutdown: vi.fn() } as never,
    });
    await app.request('/api/v1/accounts/acct_1/drafts/private-draft', { headers: auth });
    await app.request(
      '/api/v1/accounts/acct_1/send/preview',
      jsonRequest('POST', { ...draftBody, subject: 'private subject' }, auth),
    );
    await app.request('/api/v1/accounts/acct_1/delivery-operations/private-operation', { headers: auth });
    service.getDraft.mockRejectedValueOnce(new EmailError('not_found', 'private provider text'));
    await app.request('/api/v1/accounts/acct_1/drafts/private-fail', { headers: auth });
    service.previewSend.mockRejectedValueOnce(new EmailError('not_found', 'private preview'));
    await app.request(
      '/api/v1/accounts/acct_1/send/preview',
      jsonRequest('POST', { ...draftBody, subject: 'private subject' }, auth),
    );
    service.getDelivery.mockImplementationOnce(() => {
      throw new EmailError('not_found', 'private operation');
    });
    await app.request('/api/v1/accounts/acct_1/delivery-operations/private-operation', { headers: auth });
    for (const operation of ['getDraft', 'previewSend', 'getDeliveryOperation']) {
      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({ product_surface: 'rest', operation, outcome: 'success' }),
      );
    }
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'rest',
        operation: 'getDraft',
        outcome: 'error',
        error_code: 'not_found',
      }),
    );
    for (const operation of ['previewSend', 'getDeliveryOperation']) {
      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({ product_surface: 'rest', operation, outcome: 'error', error_code: 'not_found' }),
      );
    }
    const captured = JSON.stringify(capture.mock.calls);
    for (const value of [
      'private-draft',
      'private subject',
      'private-operation',
      'private provider text',
      'private preview',
    ])
      expect(captured).not.toContain(value);
  });

  it('requires a key and returns a delivery operation', async () => {
    const { app, auth, service } = fixture();
    const missing = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, auth));
    expect(missing.status).toBe(400);

    const headers = { ...auth, 'idempotency-key': 'send-1' };
    const first = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, headers));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ data: { operationId: 'dop_1', status: 'succeeded' } });
    expect(service.deliver).toHaveBeenCalledWith('acct_1', expect.objectContaining({ subject: 'Hello' }), 'send-1');
    const status = await app.request('/api/v1/accounts/acct_1/delivery-operations/dop_1', { headers: auth });
    expect(status.status).toBe(200);
    expect(service.getDelivery).toHaveBeenCalledWith('acct_1', 'dop_1');
  });

  it('rechecks mailbox scope before a delivery', async () => {
    const { app, auth, service } = fixture();
    const headers = { ...auth, 'idempotency-key': 'scope-replay' };
    service.assertAccountAccess.mockImplementationOnce(() => {
      throw new EmailError('not_found', 'No account with id "acct_1"');
    });
    const denied = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, headers));
    expect(denied.status).toBe(404);
    expect(service.deliver).not.toHaveBeenCalled();
    const granted = await app.request('/api/v1/accounts/acct_1/send', jsonRequest('POST', draftBody, headers));
    expect(granted.status).toBe(200);
    expect(service.deliver).toHaveBeenCalledOnce();
  });

  it('returns an uncertain result without retrying through REST', async () => {
    const capture = vi.fn();
    const telemetry = createTelemetry({
      dataDir: mkdtempSync(join(tmpdir(), 'fluxmail-rest-telemetry-')),
      env: {},
      client: { capture, shutdown: async () => undefined },
    });
    const { app, auth, service } = fixture(telemetry);
    service.deliver.mockResolvedValueOnce({
      operationId: 'dop_uncertain',
      accountId: 'acct_1',
      kind: 'send',
      status: 'uncertain',
      error: { code: 'provider_unavailable' },
    });
    const response = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', draftBody, { ...auth, 'idempotency-key': 'uncertain-send' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { status: 'uncertain', operationId: 'dop_uncertain' },
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: '$exception',
        properties: expect.objectContaining({
          deployment_type: 'self_hosted',
          product_surface: 'rest',
          operation: 'sendMessage',
          error_code: 'account_failure',
        }),
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(/ann@example|uncertain-send|dop_uncertain/);
    await telemetry.shutdown();
  });

  it('reports changed idempotency requests as a safe conflict', async () => {
    const { app, auth, service } = fixture();
    service.deliver.mockRejectedValueOnce(new EmailError('idempotency_conflict', 'private request data'));
    const response = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', draftBody, { ...auth, 'idempotency-key': 'changed-key' }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'idempotency_conflict', requestId: expect.any(String) } });
    expect(JSON.stringify(body)).not.toContain('private request data');
  });

  it('uses the same operation shape for scheduled sends and forwards', async () => {
    const { app, auth, service } = fixture();
    const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const scheduled = await app.request(
      '/api/v1/accounts/acct_1/send',
      jsonRequest('POST', { ...draftBody, sendAt }, { ...auth, 'idempotency-key': 'scheduled-1' }),
    );
    expect(scheduled.status).toBe(202);
    expect(service.scheduleDelivery).toHaveBeenCalledTimes(1);
    await expect(scheduled.json()).resolves.toMatchObject({ data: { operationId: 'dop_2', status: 'queued' } });

    const forwarded = await app.request(
      '/api/v1/accounts/acct_1/messages/msg_1/forward',
      jsonRequest('POST', { to: [{ email: 'bob@example.com' }] }, { ...auth, 'idempotency-key': 'forward-1' }),
    );
    expect(forwarded.status).toBe(200);
    expect(service.deliverForward).toHaveBeenCalledTimes(1);
  });
});
