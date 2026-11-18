import { describe, expect, it, vi } from 'vitest';
import { FolderNameError } from '@fluxmail/core';
import { OutlookProvider } from '../src/outlookProvider.js';

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });
}

const folders = [
  { id: 'folder-inbox', displayName: 'Inbox', childFolderCount: 1, unreadItemCount: 2 },
  { id: 'folder-drafts', displayName: 'Drafts', childFolderCount: 0, unreadItemCount: 0 },
  { id: 'folder-sent', displayName: 'Sent Items', childFolderCount: 0, unreadItemCount: 0 },
  { id: 'folder-trash', displayName: 'Deleted Items', childFolderCount: 1, unreadItemCount: 0 },
  { id: 'folder-spam', displayName: 'Junk Email', childFolderCount: 0, unreadItemCount: 0 },
  { id: 'folder-archive', displayName: 'Archive', childFolderCount: 0, unreadItemCount: 0 },
];

function folderResponse(url: URL): Response | undefined {
  if (url.pathname === '/v1.0/me/mailFolders' && url.searchParams.has('includeHiddenFolders')) {
    return json({ value: folders });
  }
  if (url.pathname === '/v1.0/me/mailFolders/folder-inbox/childFolders') {
    return json({
      value: [{ id: 'folder-projects', displayName: 'Projects', childFolderCount: 0, unreadItemCount: 1 }],
    });
  }
  if (url.pathname === '/v1.0/me/mailFolders/folder-trash/childFolders') {
    return json({
      value: [{ id: 'folder-trash-child', displayName: 'Deleted Project', childFolderCount: 0, unreadItemCount: 1 }],
    });
  }
  const known: Record<string, string> = {
    inbox: 'folder-inbox',
    sentitems: 'folder-sent',
    drafts: 'folder-drafts',
    deleteditems: 'folder-trash',
    junkemail: 'folder-spam',
    archive: 'folder-archive',
  };
  const match = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)$/);
  if (match?.[1] && known[match[1]]) return json({ id: known[match[1]] });
  return undefined;
}

function provider(fetchImpl: typeof fetch) {
  return new OutlookProvider({
    accountId: 'acct-1',
    tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('access-token') },
    fetch: fetchImpl,
  });
}

function ignoredResponse(status: number, cancellationFails = false) {
  const cancel = vi.fn(() => {
    if (cancellationFails) throw new Error('Response cancellation failed');
  });
  const body = new ReadableStream({ cancel });
  const response = new Response(status === 204 ? null : body, { status });
  if (status === 204) Object.defineProperty(response, 'body', { value: body });
  return { response, cancel };
}

describe('OutlookProvider', () => {
  it('lists Outlook categories and exposes their preset colors', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1.0/me/outlook/masterCategories') {
        return json({
          value: [
            { id: 'category-1', displayName: 'Customer', color: 'preset7' },
            { id: null, displayName: 'Ignored', color: 'preset0' },
          ],
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    await expect(provider(fetchMock).listLabels()).resolves.toEqual([
      { id: 'category-1', name: 'Customer', color: { preset: 'preset7' } },
    ]);
  });

  it('asks for reauthorization when category permission is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ error: { code: 'ErrorAccessDenied', message: 'insufficient privileges' } }, 403),
      ) as unknown as typeof fetch;

    await expect(provider(fetchMock).listLabels()).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringContaining('Reauthorize'),
    });
  });

  it('lists nested folders with well-known roles and virtual views', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const response = folderResponse(new URL(String(input)));
      return response ?? json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    const outlook = provider(fetchMock);
    expect(outlook.capabilities.searchContext).toBe(true);
    expect(outlook.capabilities.search.folderRoles.archive).toBe('unknown');
    const result = await outlook.listFolders();

    expect(result).toContainEqual({ id: 'folder-inbox', name: 'Inbox', role: 'inbox', unreadCount: 2 });
    expect(result).toContainEqual({ id: 'folder-projects', name: 'Inbox/Projects', unreadCount: 1 });
    expect(result).toContainEqual({ id: 'starred', name: 'Flagged', role: 'starred' });
    expect(outlook.capabilities.search.folderRoles).toMatchObject({
      inbox: 'available',
      archive: 'available',
      all: 'available',
    });
    for (const call of vi.mocked(fetchMock).mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get('authorization')).toBe('Bearer access-token');
      expect(headers.get('prefer')).toBe('IdType="ImmutableId"');
    }
  });

  it('lists folder messages, translates search, and returns an opaque next-page token', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/folder-inbox/messages?$skip=25';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/mailFolders/folder-inbox/messages') {
        if (url.searchParams.get('$skip') === '25') {
          return json({
            value: [
              {
                id: 'message-2',
                conversationId: 'thread-2',
                parentFolderId: 'folder-inbox',
                subject: 'Read report',
                receivedDateTime: '2026-07-14T13:00:00Z',
                isRead: true,
              },
              {
                id: 'message-3',
                conversationId: 'thread-3',
                parentFolderId: 'folder-inbox',
                subject: 'Unread report',
                receivedDateTime: '2026-07-14T14:00:00Z',
                isRead: false,
              },
            ],
          });
        }
        return json({
          value: [
            {
              id: 'message-read',
              conversationId: 'thread-read',
              parentFolderId: 'folder-inbox',
              subject: 'Old report',
              receivedDateTime: '2026-07-14T11:00:00Z',
              isRead: true,
            },
            {
              id: 'message-1',
              conversationId: 'thread-1',
              parentFolderId: 'folder-inbox',
              from: { emailAddress: { address: 'alex@example.com' } },
              toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
              subject: 'Report',
              receivedDateTime: '2026-07-14T12:00:00Z',
              bodyPreview: 'Preview',
              isRead: false,
              isDraft: false,
              flag: { flagStatus: 'notFlagged' },
              categories: ['Customer'],
            },
          ],
          '@odata.nextLink': nextLink,
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const first = await outlook.listMessages(
      { folder: 'inbox', text: 'quarterly report', from: 'alex@example.com', read: false },
      { pageSize: 25 },
    );
    expect(first.items[0]).toMatchObject({
      id: 'message-1',
      folder: { role: 'inbox' },
      snippet: 'Preview',
      flags: { read: false },
      labels: ['Customer'],
    });
    expect(first.items.map((item) => item.id)).toEqual(['message-1', 'message-3']);
    expect(first.nextPageToken).toBeUndefined();

    const listCall = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)))
      .find((url) => url.pathname.endsWith('/messages'))!;
    expect(listCall.searchParams.get('$search')).toContain('\\"quarterly\\" AND \\"report\\"');
    expect(listCall.searchParams.get('$search')).toContain('from:');
    expect(listCall.searchParams.get('$filter')).toBeNull();

    expect(vi.mocked(fetchMock).mock.calls.some(([input]) => String(input) === nextLink)).toBe(true);
  });

  it('requests a text body only for accepted search-context results', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        return json({
          value: [
            {
              id: 'message-1',
              conversationId: 'thread-1',
              parentFolderId: 'folder-inbox',
              subject: 'Invoice',
              receivedDateTime: '2026-07-14T12:00:00Z',
              bodyPreview: 'Opening preview',
            },
          ],
        });
      }
      if (url.pathname === '/v1.0/me/messages/message-1') {
        expect(url.searchParams.get('$select')).toBe('body');
        expect(new Headers(init?.headers).get('prefer')).toContain('outlook.body-content-type="text"');
        return json({ body: { contentType: 'text', content: 'Opening line\nInvoice [ORDER_ID] is ready.' } });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    const page = await provider(fetchMock).listMessages({ text: 'invoice [ORDER_ID]' }, { includeSearchContext: true });

    expect(page.items[0]).toMatchObject({
      snippet: 'Opening preview',
      searchContext: { status: 'matched', excerpt: 'Invoice [ORDER_ID] is ready.' },
    });
    expect(
      vi
        .mocked(fetchMock)
        .mock.calls.filter(([input]) => new URL(String(input)).pathname.startsWith('/v1.0/me/messages/message-1')),
    ).toHaveLength(1);
  });

  it('keeps Outlook metadata when optional search-context enrichment fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        return json({
          value: [
            {
              id: 'message-1',
              conversationId: 'thread-1',
              parentFolderId: 'folder-inbox',
              subject: 'Invoice',
              receivedDateTime: '2026-07-14T12:00:00Z',
            },
          ],
        });
      }
      if (url.pathname === '/v1.0/me/messages/message-1') {
        return json({ error: { code: 'ErrorItemNotFound', message: 'private body failure' } }, 404);
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    const page = await provider(fetchMock).listMessages({ text: 'invoice' }, { includeSearchContext: true });

    expect(page.items[0]).toMatchObject({
      id: 'message-1',
      subject: 'Invoice',
      searchContext: { status: 'unavailable' },
    });
    expect(page.diagnostics).toEqual([
      expect.objectContaining({ code: 'search_context_unavailable', severity: 'warning' }),
    ]);
    expect(JSON.stringify(page.diagnostics)).not.toContain('private body failure');
  });

  it('replays an opaque Graph page when a Fluxmail page stops partway through it', async () => {
    const nextLink =
      'https://graph.microsoft.com/v1.0/me/mailFolders/folder-inbox/messages?$skip=2&$top=2&opaque=a%2Bb';
    const messageRequests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requestUrl = String(input);
      const url = new URL(requestUrl);
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/mailFolders/folder-inbox/messages') {
        messageRequests.push(requestUrl);
        if (url.searchParams.get('$skip') === '2') {
          return json({
            value: [
              {
                id: 'message-2',
                conversationId: 'thread-2',
                parentFolderId: 'folder-inbox',
                subject: 'Second match',
                receivedDateTime: '2026-07-14T13:00:00Z',
                isRead: false,
              },
              {
                id: 'message-3',
                conversationId: 'thread-3',
                parentFolderId: 'folder-inbox',
                subject: 'Third match',
                receivedDateTime: '2026-07-14T14:00:00Z',
                isRead: false,
              },
            ],
          });
        }
        return json({
          value: [
            {
              id: 'message-1',
              conversationId: 'thread-1',
              parentFolderId: 'folder-inbox',
              subject: 'First match',
              receivedDateTime: '2026-07-14T11:00:00Z',
              isRead: false,
            },
            {
              id: 'message-read',
              conversationId: 'thread-read',
              parentFolderId: 'folder-inbox',
              subject: 'Filtered',
              receivedDateTime: '2026-07-14T12:00:00Z',
              isRead: true,
            },
          ],
          '@odata.nextLink': nextLink,
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const first = await outlook.listMessages({ folder: 'inbox', read: false }, { pageSize: 2 });
    const second = await outlook.listMessages(
      { folder: 'inbox', read: false },
      { pageSize: 2, pageToken: first.nextPageToken },
    );

    expect(first.items.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(first.nextPageToken).toBeTruthy();
    expect(second.items.map((message) => message.id)).toEqual(['message-3']);
    expect(second.nextPageToken).toBeUndefined();
    expect(messageRequests.filter((request) => request === nextLink)).toHaveLength(2);
  });

  it('applies attachment and UTC date filters locally when Graph search is active', async () => {
    const attachmentRequests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        return json({
          value: [
            {
              id: 'message-old',
              conversationId: 'thread-old',
              parentFolderId: 'folder-inbox',
              subject: 'Old report',
              receivedDateTime: '2025-12-31T23:59:59.999Z',
            },
            {
              id: 'message-inline',
              conversationId: 'thread-inline',
              parentFolderId: 'folder-inbox',
              subject: 'Inline report',
              receivedDateTime: '2026-01-02T12:00:00.000Z',
            },
            {
              id: 'message-boundary',
              conversationId: 'thread-boundary',
              parentFolderId: 'folder-inbox',
              subject: 'Boundary report',
              receivedDateTime: '2026-01-03T00:00:00.000Z',
            },
            {
              id: 'message-file',
              conversationId: 'thread-file',
              parentFolderId: 'folder-inbox',
              subject: 'File report',
              receivedDateTime: '2026-01-02T13:00:00.000Z',
            },
          ],
        });
      }
      const attachment = url.pathname.match(/^\/v1\.0\/me\/messages\/([^/]+)\/attachments$/)?.[1];
      if (attachment) {
        attachmentRequests.push(attachment);
        return json({
          value: [{ id: `attachment-${attachment}`, isInline: attachment === 'message-inline' }],
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const page = await outlook.listMessages({
      text: 'report',
      hasAttachment: true,
      after: '2026-01-01',
      before: '2026-01-03',
    });

    expect(page.items.map((message) => message.id)).toEqual(['message-file']);
    expect(page.inspectedCandidates).toBe(4);
    expect(attachmentRequests).toEqual(['message-inline', 'message-file']);
    const messageRequest = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/v1.0/me/messages')!;
    expect(messageRequest.searchParams.get('$search')).toBeTruthy();
    expect(messageRequest.searchParams.get('$filter')).toBeNull();
  });

  it('continues after filtered Outlook results reach the scan limit', async () => {
    const candidates = Array.from({ length: 1_001 }, (_, index) => ({
      id: `message-${index + 1}`,
      conversationId: `thread-${index + 1}`,
      parentFolderId: 'folder-inbox',
      subject: `Report ${index + 1}`,
      receivedDateTime: '2026-01-02T12:00:00.000Z',
      isRead: index < 1_000,
    }));
    let messageRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        messageRequests += 1;
        return json({ value: candidates });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);
    const query = { text: 'report', read: false };

    const first = await outlook.listMessages(query, { pageSize: 1 });
    const second = await outlook.listMessages(query, { pageSize: 1, pageToken: first.nextPageToken });

    expect(first).toMatchObject({
      items: [],
      incomplete: true,
      incompleteReason: 'scan_limit',
      inspectedCandidates: 1_000,
    });
    expect(first.nextPageToken).toBeTruthy();
    expect(second.items.map((message) => message.id)).toEqual(['message-1001']);
    expect(second.nextPageToken).toBeUndefined();
    expect(second.incomplete).toBeUndefined();
    expect(second.inspectedCandidates).toBe(1);
    expect(messageRequests).toBe(2);
  });

  it('reports a terminal Outlook provider limit without a continuation token', async () => {
    const candidates = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message-${index + 1}`,
      conversationId: `thread-${index + 1}`,
      parentFolderId: 'folder-inbox',
      subject: `Report ${index + 1}`,
      receivedDateTime: '2026-01-02T12:00:00.000Z',
      isRead: true,
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') return json({ value: candidates });
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    const page = await provider(fetchMock).listMessages({ text: 'report', read: false }, { pageSize: 1 });

    expect(page).toMatchObject({
      items: [],
      incomplete: true,
      incompleteReason: 'provider_limit',
      inspectedCandidates: 1_000,
    });
    expect(page.nextPageToken).toBeUndefined();
  });

  it('accepts virtual folder display names without treating them as Graph folder ids', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        return json({
          value: [
            {
              id: 'message-inbox',
              conversationId: 'thread-inbox',
              parentFolderId: 'folder-inbox',
              subject: 'Inbox report',
              receivedDateTime: '2026-07-14T12:00:00Z',
              isRead: false,
            },
            {
              id: 'message-trash-child',
              conversationId: 'thread-trash-child',
              parentFolderId: 'folder-trash-child',
              subject: 'Deleted report',
              receivedDateTime: '2026-07-14T13:00:00Z',
              isRead: false,
            },
          ],
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    await outlook.listMessages({ folder: 'Flagged' });
    const allMail = await outlook.listMessages({ folder: 'All mail' });
    const omittedFolder = await outlook.listMessages({});

    expect(allMail.items.map((message) => message.id)).toEqual(['message-inbox']);
    expect(omittedFolder.items.map((message) => message.id)).toEqual(['message-inbox']);

    const messageRequests = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith('/messages'));
    expect(messageRequests).toHaveLength(3);
    expect(messageRequests[0]?.pathname).toBe('/v1.0/me/messages');
    expect(messageRequests[0]?.searchParams.get('$filter')).toContain("flag/flagStatus eq 'flagged'");
    expect(messageRequests[0]?.searchParams.get('$filter')).toContain("parentFolderId ne 'folder-trash'");
    expect(messageRequests[0]?.searchParams.get('$filter')).toContain("parentFolderId ne 'folder-spam'");
    expect(messageRequests[1]?.pathname).toBe('/v1.0/me/messages');
    expect(messageRequests[1]?.searchParams.get('$filter')).toContain("parentFolderId ne 'folder-trash'");
    expect(messageRequests[1]?.searchParams.get('$filter')).toContain("parentFolderId ne 'folder-spam'");
    expect(messageRequests[1]?.searchParams.get('$filter')).not.toContain('folder-trash-child');
    expect(messageRequests[2]?.searchParams.get('$filter')).toBe(messageRequests[1]?.searchParams.get('$filter'));
  });

  it('excludes junk and deleted messages from mailbox-wide search pages', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/messages?$skip=25';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages') {
        if (url.searchParams.get('$skip') === '25') {
          return json({
            value: [
              {
                id: 'message-trash-child',
                conversationId: 'thread-trash-child',
                parentFolderId: 'folder-trash-child',
                subject: 'Deleted report',
                receivedDateTime: '2026-07-14T14:00:00Z',
                isRead: false,
              },
            ],
          });
        }
        return json({
          value: [
            {
              id: 'message-inbox',
              conversationId: 'thread-inbox',
              parentFolderId: 'folder-inbox',
              subject: 'Inbox report',
              receivedDateTime: '2026-07-14T12:00:00Z',
              isRead: false,
            },
            {
              id: 'message-spam',
              conversationId: 'thread-spam',
              parentFolderId: 'folder-spam',
              subject: 'Spam report',
              receivedDateTime: '2026-07-14T13:00:00Z',
              isRead: false,
            },
          ],
          '@odata.nextLink': nextLink,
        });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    const first = await outlook.listMessages({ text: 'report', read: false });
    expect(first.items.map((message) => message.id)).toEqual(['message-inbox']);
    expect(first.nextPageToken).toBeUndefined();
    expect(first.inspectedCandidates).toBe(3);
  });

  it('refreshes once after a 401 response', async () => {
    const getAccessToken = vi.fn().mockResolvedValueOnce('old-token').mockResolvedValueOnce('new-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }, 401))
      .mockResolvedValueOnce(json({ id: 'me' })) as unknown as typeof fetch;
    const outlook = new OutlookProvider({
      accountId: 'acct-1',
      tokenProvider: { getAccessToken },
      fetch: fetchMock,
    });

    await outlook.testConnection();

    expect(getAccessToken).toHaveBeenNthCalledWith(1, false);
    expect(getAccessToken).toHaveBeenNthCalledWith(2, true);
    expect(new URL(String(vi.mocked(fetchMock).mock.calls[0]![0])).pathname).toBe('/v1.0/me/mailFolders/inbox');
  });

  it('returns not_found for an unknown conversation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ value: [] })) as unknown as typeof fetch;

    await expect(provider(fetchMock).getThread('missing-thread')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a recipient-free message before creating a draft', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;

    await expect(provider(fetchMock).send({ subject: 'No recipient', body: { text: 'Hello' } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'creates and sends a draft with a file attachment (cancel rejects: %s)',
    async (cancellationFails) => {
      let attachmentAdded = false;
      const { response: sendResponse, cancel } = ignoredResponse(202, cancellationFails);
      const calls: Array<{ url: URL; method: string; body?: unknown }> = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        calls.push({
          url,
          method,
          ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
        });
        const folder = folderResponse(url);
        if (folder) return folder;
        if (url.pathname === '/v1.0/me/messages' && method === 'POST') return json({ id: 'draft-1' }, 201);
        if (url.pathname === '/v1.0/me/messages/draft-1/attachments' && method === 'POST') {
          attachmentAdded = true;
          return json({ id: 'attachment-1' }, 201);
        }
        if (url.pathname === '/v1.0/me/messages/draft-1' && method === 'GET') {
          return json({
            id: 'draft-1',
            conversationId: 'thread-1',
            parentFolderId: 'folder-drafts',
            toRecipients: [{ emailAddress: { address: 'alex@example.com' } }],
            subject: 'Status',
            createdDateTime: '2026-07-14T12:00:00Z',
            body: { contentType: 'text', content: 'Hello' },
            isDraft: true,
            isRead: true,
            attachments: attachmentAdded
              ? [{ id: 'attachment-1', name: 'note.txt', contentType: 'text/plain', size: 5, isInline: false }]
              : [],
          });
        }
        if (url.pathname === '/v1.0/me/messages/draft-1/send' && method === 'POST') return sendResponse;
        return json({ error: { code: 'ErrorItemNotFound', message: `${method} ${url.pathname}` } }, 404);
      }) as unknown as typeof fetch;
      const outlook = new OutlookProvider({
        accountId: 'acct-1',
        tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('access-token') },
        fetch: fetchMock,
        resolveSender: (email) => (email === 'sales@example.com' ? { email, name: 'Sales' } : undefined),
      });

      const result = await outlook.send({
        from: 'sales@example.com',
        to: [{ email: 'alex@example.com' }],
        subject: 'Status',
        body: { text: 'Hello' },
        attachments: [
          { filename: 'note.txt', mimeType: 'text/plain', content: Buffer.from('hello').toString('base64') },
          {
            filename: 'logo.png',
            mimeType: 'image/png',
            content: Buffer.from('image').toString('base64'),
            contentId: 'logo@example.com',
            disposition: 'inline',
          },
        ],
      });

      expect(result).toEqual({ id: 'draft-1', threadId: 'thread-1' });
      expect(cancel).toHaveBeenCalledOnce();
      expect(calls.filter((call) => call.url.pathname.endsWith('/send'))).toHaveLength(1);
      expect(
        calls.find((call) => call.url.pathname === '/v1.0/me/messages' && call.method === 'POST')?.body,
      ).toMatchObject({
        subject: 'Status',
        body: { contentType: 'Text', content: 'Hello' },
        toRecipients: [{ emailAddress: { address: 'alex@example.com' } }],
        from: { emailAddress: { address: 'sales@example.com', name: 'Sales' } },
      });
      const attachments = calls.filter((call) => call.url.pathname.endsWith('/attachments')).map((call) => call.body);
      expect(attachments).toEqual([
        expect.objectContaining({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'note.txt',
          isInline: false,
        }),
        expect.objectContaining({ name: 'logo.png', contentId: 'logo@example.com', isInline: true }),
      ]);
    },
  );

  it('selects inline content IDs on the Graph file attachment type', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      expect(url.pathname).toBe('/v1.0/me/messages/message-1');
      expect(url.searchParams.get('$expand')).toBe(
        'attachments($select=id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId)',
      );
      return json({
        id: 'message-1',
        parentFolderId: 'folder-inbox',
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'attachment-1',
            name: 'logo.png',
            contentType: 'image/png',
            size: 5,
            isInline: true,
            contentId: '<logo@example.com>',
          },
        ],
      });
    }) as unknown as typeof fetch;

    await expect(provider(fetchMock).getMessage('message-1')).resolves.toMatchObject({
      attachments: [{ id: 'attachment-1', contentId: 'logo@example.com', disposition: 'inline' }],
    });
  });

  it.each([
    { status: 202, cancellationFails: false },
    { status: 204, cancellationFails: false },
    { status: 202, cancellationFails: true },
    { status: 204, cancellationFails: true },
  ])(
    'cancels ignored $status response bodies (cancel rejects: $cancellationFails)',
    async ({ status, cancellationFails }) => {
      const { response, cancel } = ignoredResponse(status, cancellationFails);
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const folder = folderResponse(url);
        if (folder) return folder;
        if (url.pathname.endsWith('/permanentDelete')) return response;
        return json({ id: 'message-1', parentFolderId: 'folder-inbox' });
      }) as unknown as typeof fetch;

      await provider(fetchMock).modify(['message-1'], 'delete');

      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    'releases every chunk response for a 10 MB upload (cancel rejects: %s)',
    async (cancellationFails) => {
      const content = Buffer.alloc(10_000_000, 0xff);
      const uploads: Uint8Array[] = [];
      const ranges: string[] = [];
      const responses: ReturnType<typeof ignoredResponse>[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const folder = folderResponse(url);
        if (folder) return folder;
        if (url.pathname === '/v1.0/me/messages' && init?.method === 'POST') return json({ id: 'draft-1' }, 201);
        if (url.pathname.endsWith('/createUploadSession')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ AttachmentItem: { size: content.length } });
          return json({ uploadUrl: 'https://upload.example.com/attachment' });
        }
        if (url.hostname === 'upload.example.com') {
          expect(init?.method).toBe('PUT');
          expect(new Headers(init?.headers).has('authorization')).toBe(false);
          for (const previous of responses) expect(previous.cancel).toHaveBeenCalledOnce();
          const chunk = init?.body as Uint8Array;
          expect(new Headers(init?.headers).get('content-length')).toBe(String(chunk.byteLength));
          uploads.push(chunk);
          ranges.push(new Headers(init?.headers).get('content-range')!);
          const response = ignoredResponse(uploads.length === 3 ? 201 : 200, cancellationFails);
          responses.push(response);
          return response.response;
        }
        expect(url.pathname).toBe('/v1.0/me/messages/draft-1');
        return json({ id: 'draft-1', isDraft: true, parentFolderId: 'folder-drafts' });
      }) as unknown as typeof fetch;

      await provider(fetchMock).createDraft({
        body: { text: 'Hello' },
        attachments: [
          { filename: 'large.bin', mimeType: 'application/octet-stream', content: content.toString('base64') },
        ],
      });

      expect(ranges).toEqual([
        'bytes 0-3932159/10000000',
        'bytes 3932160-7864319/10000000',
        'bytes 7864320-9999999/10000000',
      ]);
      expect(Buffer.concat(uploads).equals(content)).toBe(true);
      for (const response of responses) expect(response.cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])('preserves upload errors without retrying (cancel rejects: %s)', async (cancellationFails) => {
    const { response, cancel } = ignoredResponse(500, cancellationFails);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1.0/me/messages') return json({ id: 'draft-1' }, 201);
      if (url.pathname.endsWith('/createUploadSession')) {
        return json({ uploadUrl: 'https://upload.example.com/attachment' });
      }
      expect(url.hostname).toBe('upload.example.com');
      return response;
    }) as unknown as typeof fetch;

    await expect(
      provider(fetchMock).createDraft({
        body: { text: 'Hello' },
        attachments: [
          {
            filename: 'large.bin',
            mimeType: 'application/octet-stream',
            content: Buffer.alloc(3 * 1024 * 1024).toString('base64'),
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'Microsoft Graph attachment upload failed (500)',
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, 10_000_000])('uses decoded bytes for a 10 MB attachment with maxBytes %s', async (maxBytes) => {
    const content = Buffer.alloc(10_000_000, 0xff);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/$value')) {
        expect(new Headers(init?.headers).get('accept')).toBe('*/*');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-token');
        return new Response(content, { headers: { 'content-type': 'application/octet-stream' } });
      }
      return json({
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: 'attachment-1',
        name: 'large.bin',
        size: 13_333_336,
        ...(url.searchParams.has('$select') ? {} : { contentBytes: content.toString('base64') }),
      });
    }) as unknown as typeof fetch;

    const attachment = await provider(fetchMock).getAttachment('message-1', 'attachment-1', { maxBytes });

    expect(attachment.content.equals(content)).toBe(true);
    expect(attachment.meta.sizeBytes).toBe(content.length);
    expect(fetchMock).toHaveBeenCalledTimes(maxBytes === undefined ? 1 : 2);
  });

  it.each([false, true])('stops oversized downloads at the limit (cancel rejects: %s)', async (cancellationFails) => {
    const chunks = [Buffer.from('hell'), Buffer.from('o'), Buffer.alloc(1_000_000)];
    let reads = 0;
    const cancel = vi.fn(() => {
      if (cancellationFails) throw new Error('Response cancellation failed');
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[reads++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, { headers: { 'content-length': '1' } });
    const text = vi.spyOn(response, 'text');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/$value')) return response;
      expect(url.searchParams.get('$select')).toBe('id,name,contentType,size,isInline');
      return json({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'attachment-1', name: 'note.txt', size: 1 });
    }) as unknown as typeof fetch;

    await expect(provider(fetchMock).getAttachment('message-1', 'attachment-1', { maxBytes: 4 })).rejects.toMatchObject(
      {
        code: 'invalid_request',
        data: { sizeBytes: 5, maxBytes: 4 },
      },
    );

    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(text).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('joins streamed chunks at the exact limit even when metadata overstates the size', async () => {
    const chunks = [Buffer.from('he'), Buffer.from('llo')];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/$value')) return new Response(body);
      return json({
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: 'attachment-1',
        name: 'note.txt',
        size: 100,
      });
    }) as unknown as typeof fetch;

    await expect(
      provider(fetchMock).getAttachment('message-1', 'attachment-1', { maxBytes: 5 }),
    ).resolves.toMatchObject({
      meta: { sizeBytes: 5 },
      content: Buffer.from('hello'),
    });
    expect(body.locked).toBe(false);
  });

  it.each([0, 1])('enforces a zero-byte limit on %s raw attachment bytes', async (sizeBytes) => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/$value')) return new Response(Buffer.alloc(sizeBytes));
      return json({
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: 'attachment-1',
        name: 'empty.bin',
        size: 100,
      });
    }) as unknown as typeof fetch;
    const download = provider(fetchMock).getAttachment('message-1', 'attachment-1', { maxBytes: 0 });

    if (sizeBytes === 0) {
      await expect(download).resolves.toMatchObject({ meta: { sizeBytes: 0 }, content: Buffer.alloc(0) });
    } else {
      await expect(download).rejects.toMatchObject({ code: 'invalid_request', data: { sizeBytes: 1, maxBytes: 0 } });
    }
  });

  it('refreshes expired authorization for raw attachment downloads', async () => {
    let downloads = 0;
    const getAccessToken = vi.fn(async (forceRefresh?: boolean) => (forceRefresh ? 'refreshed-token' : 'access-token'));
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/$value')) {
        downloads++;
        if (downloads === 1) return json({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }, 401);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer refreshed-token');
        return new Response(Buffer.from('hello'));
      }
      return json({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'attachment-1', name: 'note.txt', size: 5 });
    }) as unknown as typeof fetch;
    const outlook = new OutlookProvider({ accountId: 'acct-1', tokenProvider: { getAccessToken }, fetch: fetchMock });

    await expect(outlook.getAttachment('message-1', 'attachment-1', { maxBytes: 5 })).resolves.toMatchObject({
      content: Buffer.from('hello'),
    });
    expect(getAccessToken).toHaveBeenLastCalledWith(true);
    expect(downloads).toBe(2);
  });

  it('releases the reader when a raw attachment stream fails without retrying', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('Attachment stream failed'));
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/$value')) return new Response(body);
      return json({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'attachment-1', name: 'note.txt', size: 5 });
    }) as unknown as typeof fetch;

    await expect(provider(fetchMock).getAttachment('message-1', 'attachment-1', { maxBytes: 5 })).rejects.toMatchObject(
      {
        code: 'provider_unavailable',
        message: expect.stringContaining('Attachment stream failed'),
      },
    );
    expect(body.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports missing raw attachment content without an unbounded fallback request', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/$value')) return new Response(null);
      return json({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'attachment-1', name: 'note.txt', size: 5 });
    }) as unknown as typeof fetch;

    await expect(provider(fetchMock).getAttachment('message-1', 'attachment-1', { maxBytes: 5 })).rejects.toMatchObject(
      {
        code: 'provider_unavailable',
        message: 'Microsoft Graph returned no attachment data',
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects non-file attachments without fetching their content', async () => {
    const fetchMock = vi.fn(async () =>
      json({ '@odata.type': '#microsoft.graph.itemAttachment', id: 'attachment-1', name: 'forwarded.eml', size: 100 }),
    ) as unknown as typeof fetch;

    await expect(provider(fetchMock).getAttachment('message-1', 'attachment-1', { maxBytes: 5 })).rejects.toMatchObject(
      {
        code: 'unsupported_capability',
      },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('derives the subject when replacing a reply draft', async () => {
    let patchedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages/draft-1' && method === 'GET') {
        return json({
          id: 'draft-1',
          conversationId: 'thread-1',
          parentFolderId: 'folder-drafts',
          subject: 'Re: Original subject',
          createdDateTime: '2026-07-14T12:00:00Z',
          body: { contentType: 'text', content: 'Updated reply' },
          isDraft: true,
        });
      }
      if (url.pathname === '/v1.0/me/messages/original-1' && method === 'GET') {
        return json({
          id: 'original-1',
          conversationId: 'thread-1',
          parentFolderId: 'folder-inbox',
          subject: 'Original subject',
          receivedDateTime: '2026-07-14T11:00:00Z',
          isDraft: false,
        });
      }
      if (url.pathname === '/v1.0/me/messages/draft-1' && method === 'PATCH') {
        patchedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ id: 'draft-1' });
      }
      if (url.pathname === '/v1.0/me/messages/draft-1/attachments') return json({ value: [] });
      return json({ error: { code: 'ErrorItemNotFound', message: `${method} ${url.pathname}` } }, 404);
    }) as unknown as typeof fetch;

    await provider(fetchMock).updateDraft('draft-1', {
      replyToMessageId: 'original-1',
      to: [{ email: 'alex@example.com' }],
      body: { text: 'Updated reply' },
    });

    expect(patchedBody).toMatchObject({
      subject: 'Re: Original subject',
      body: { contentType: 'Text', content: 'Updated reply' },
      toRecipients: [{ emailAddress: { address: 'alex@example.com' } }],
      ccRecipients: [],
      bccRecipients: [],
    });
    expect(patchedBody).not.toHaveProperty('from');
  });

  it('updates flags, moves messages, permanently deletes, and downloads attachments', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({
        path: url.pathname,
        method,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages/message-1' && url.searchParams.get('$select') === 'parentFolderId') {
        return json({ id: 'message-1', parentFolderId: 'folder-inbox' });
      }
      if (url.pathname.endsWith('/attachments/attachment-1/$value')) return new Response(Buffer.from('hello'));
      if (url.pathname.endsWith('/attachments/attachment-1')) {
        if (url.searchParams.has('$select')) {
          return json({
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'attachment-1',
            name: 'note.txt',
            contentType: 'text/plain',
            size: 5,
          });
        }
        return json({
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'attachment-1',
          name: 'note.txt',
          contentType: 'text/plain',
          size: 5,
          contentBytes: Buffer.from('hello').toString('base64'),
        });
      }
      if (method === 'PATCH') return json({ id: 'message-1' });
      if (url.pathname.endsWith('/move')) return json({ id: 'message-1' }, 201);
      if (url.pathname.endsWith('/permanentDelete')) return new Response(null, { status: 204 });
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    await outlook.modify(['message-1'], 'markRead');
    await outlook.modify(['message-1'], 'star');
    await outlook.modify(['message-1'], 'archive');
    await outlook.modify(['message-1'], 'trash');
    await outlook.modify(['message-1'], 'delete');
    for (const destination of ['trash', 'deleteditems', 'Deleted Items', 'folder-trash', 'archive', 'folder-archive']) {
      await expect(outlook.modify(['message-1'], { move: destination })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    const attachment = await outlook.getAttachment('message-1', 'attachment-1', { maxBytes: 10 });

    expect(attachment.content.toString()).toBe('hello');
    expect(calls).toContainEqual({ path: '/v1.0/me/messages/message-1', method: 'PATCH', body: { isRead: true } });
    expect(calls).toContainEqual({
      path: '/v1.0/me/messages/message-1',
      method: 'PATCH',
      body: { flag: { flagStatus: 'flagged' } },
    });
    expect(calls).toContainEqual({
      path: '/v1.0/me/messages/message-1/move',
      method: 'POST',
      body: { destinationId: 'folder-archive' },
    });
    expect(calls).toContainEqual({
      path: '/v1.0/me/messages/message-1/move',
      method: 'POST',
      body: { destinationId: 'deleteditems' },
    });
    expect(calls).toContainEqual({ path: '/v1.0/me/messages/message-1/permanentDelete', method: 'POST' });
    expect(calls.filter((call) => call.path.endsWith('/move'))).toHaveLength(2);
    await expect(outlook.getAttachment('message-1', 'attachment-1', { maxBytes: 4 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(outlook.getAttachment('message-1', 'attachment-1')).resolves.toMatchObject({
      content: Buffer.from('hello'),
    });
    const attachmentRequests = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.startsWith('/v1.0/me/messages/message-1/attachments/attachment-1'));
    expect(attachmentRequests).toHaveLength(5);
    expect(attachmentRequests[0]?.searchParams.get('$select')).toBe('id,name,contentType,size,isInline');
    expect(attachmentRequests[1]?.search).toBe('');
    expect(attachmentRequests[1]?.pathname).toBe('/v1.0/me/messages/message-1/attachments/attachment-1/$value');
    expect(attachmentRequests[2]?.searchParams.get('$select')).toBe('id,name,contentType,size,isInline');
    expect(attachmentRequests[3]?.search).toBe('');
    expect(attachmentRequests[3]?.pathname).toBe('/v1.0/me/messages/message-1/attachments/attachment-1/$value');
    expect(attachmentRequests[4]?.search).toBe('');
  });

  it('adds and removes categories without replacing unrelated categories', async () => {
    const patches: Array<{ id: string; categories: string[] }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1.0/me/outlook/masterCategories') {
        return json({ value: [{ id: 'category-1', displayName: 'Customer', color: 'preset7' }] });
      }
      const match = url.pathname.match(/^\/v1\.0\/me\/messages\/([^/]+)$/);
      if (match && method === 'GET' && url.searchParams.get('$select') === 'categories') {
        const categories =
          match[1] === 'message-1'
            ? ['Existing']
            : match[1] === 'message-2'
              ? ['Existing', 'Customer']
              : ['Existing', 'Orphaned'];
        return json({ categories });
      }
      if (match && method === 'PATCH') {
        patches.push({
          id: match[1]!,
          categories: (JSON.parse(String(init?.body)) as { categories: string[] }).categories,
        });
        return json({ id: match[1] });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    await outlook.modify(['message-1'], { addLabels: ['category-1', 'New category'] });
    await outlook.modify(['message-2'], { removeLabels: ['Customer', 'missing'] });
    await outlook.modify(['message-3'], { removeLabels: ['Orphaned'] });

    expect(patches).toEqual([
      { id: 'message-1', categories: ['Existing', 'Customer', 'New category'] },
      { id: 'message-2', categories: ['Existing'] },
      { id: 'message-3', categories: ['Existing'] },
    ]);
    expect(
      vi
        .mocked(fetchMock)
        .mock.calls.filter(([input]) => new URL(String(input)).pathname === '/v1.0/me/outlook/masterCategories'),
    ).toHaveLength(3);
  });

  it('matches accented folder and category names in either Unicode form', async () => {
    // Outlook for Mac can save an accented name with a combining accent.
    const meetings = { id: 'folder-meetings', displayName: 'Réunions'.normalize('NFD'), childFolderCount: 0 };
    const moves: unknown[] = [];
    const patches: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1.0/me/mailFolders' && url.searchParams.has('includeHiddenFolders')) {
        return json({ value: [...folders, meetings] });
      }
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/outlook/masterCategories') {
        return json({ value: [{ id: 'category-1', displayName: 'Clé'.normalize('NFD') }] });
      }
      if (url.pathname === '/v1.0/me/messages/message-1/move') {
        moves.push(JSON.parse(String(init?.body)));
        return json({ id: 'message-1' }, 201);
      }
      if (url.pathname === '/v1.0/me/messages/message-1' && method === 'GET') {
        return json({ parentFolderId: 'folder-inbox', categories: ['Clé'.normalize('NFD')] });
      }
      if (url.pathname === '/v1.0/me/messages/message-1' && method === 'PATCH') {
        patches.push(JSON.parse(String(init?.body)));
        return json({ id: 'message-1' });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    await outlook.modify(['message-1'], { move: 'réunions' });
    await outlook.modify(['message-1'], { addLabels: ['Clé'] });
    await outlook.modify(['message-1'], { removeLabels: ['CLÉ'] });

    expect(moves).toEqual([{ destinationId: 'folder-meetings' }]);
    expect(patches).toEqual([{ categories: [] }]);
  });

  it('moves to the exact folder name when both Unicode forms exist as separate folders', async () => {
    const composed = { id: 'folder-composed', displayName: 'Réunions', childFolderCount: 0 };
    const decomposed = { id: 'folder-decomposed', displayName: 'Réunions'.normalize('NFD'), childFolderCount: 0 };
    const moves: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1.0/me/mailFolders' && url.searchParams.has('includeHiddenFolders')) {
        return json({ value: [...folders, composed, decomposed] });
      }
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages/message-1/move') {
        moves.push(JSON.parse(String(init?.body)));
        return json({ id: 'message-1' }, 201);
      }
      if (url.pathname === '/v1.0/me/messages/message-1') return json({ parentFolderId: 'folder-inbox' });
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    await outlook.modify(['message-1'], { move: decomposed.displayName });
    await outlook.modify(['message-1'], { move: composed.displayName });

    expect(moves).toEqual([{ destinationId: 'folder-decomposed' }, { destinationId: 'folder-composed' }]);
  });

  it('rejects archive and generic moves through Trash and its descendants', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const folder = folderResponse(url);
      if (folder) return folder;
      if (url.pathname === '/v1.0/me/messages/message-trash' && url.searchParams.get('$select') === 'parentFolderId') {
        return json({ id: 'message-trash', parentFolderId: 'folder-trash' });
      }
      if (
        url.pathname === '/v1.0/me/messages/message-trash-child' &&
        url.searchParams.get('$select') === 'parentFolderId'
      ) {
        return json({ id: 'message-trash-child', parentFolderId: 'folder-trash-child' });
      }
      if (url.pathname.endsWith('/move')) return json({ id: 'message-trash' }, 201);
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    const outlook = provider(fetchMock);

    for (const id of ['message-trash', 'message-trash-child']) {
      for (const action of ['archive', { move: 'inbox' }] as const) {
        await expect(outlook.modify([id], action)).rejects.toMatchObject({
          code: 'invalid_request',
        });
      }
    }
    await expect(outlook.modify(['message-inbox'], { move: 'folder-trash-child' })).rejects.toMatchObject({
      code: 'invalid_request',
    });

    expect(vi.mocked(fetchMock).mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith('/move'))).toBe(
      false,
    );
  });

  describe('bulk message changes', () => {
    function bulkMock(
      handle?: (url: URL, method: string, attempt: number) => Response | Promise<Response> | undefined,
    ) {
      const calls: Array<{ path: string; method: string }> = [];
      const attempts = new Map<string, number>();
      let inFlight = 0;
      let maxInFlight = 0;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const folder = folderResponse(url);
        if (folder) return folder;
        const method = init?.method ?? 'GET';
        const key = `${method} ${url.pathname}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        calls.push({ path: url.pathname, method });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const handled = await handle?.(url, method, attempt);
          if (handled) return handled;
          if (method === 'GET') return json({ id: 'message', parentFolderId: 'folder-inbox' });
          if (url.pathname.endsWith('/move')) return json({ id: 'moved' }, 201);
          if (url.pathname.endsWith('/permanentDelete')) return new Response(null, { status: 204 });
          return json({ id: 'message' });
        } finally {
          inFlight -= 1;
        }
      }) as unknown as typeof fetch;
      return { fetchMock, calls, attempts, maxInFlight: () => maxInFlight };
    }

    const ids = Array.from({ length: 25 }, (_, index) => `message-${index}`);

    it('archives more than 20 messages with bounded concurrency and checks Trash first', async () => {
      const mock = bulkMock();

      await provider(mock.fetchMock).modify(ids, 'archive');

      const checks = mock.calls.filter((call) => call.method === 'GET');
      const moves = mock.calls.filter((call) => call.path.endsWith('/move'));
      expect(checks).toHaveLength(25);
      expect(moves).toHaveLength(25);
      expect(mock.calls.findIndex((call) => call.path.endsWith('/move'))).toBe(25);
      expect(mock.maxInFlight()).toBe(4);
      for (const [, init] of vi.mocked(mock.fetchMock).mock.calls) {
        expect(new Headers(init?.headers).get('prefer')).toBe('IdType="ImmutableId"');
      }
    });

    it.each(['delete', 'markRead', { addLabels: ['Customer'] }] as const)(
      'limits concurrent requests for %j',
      async (action) => {
        const mock = bulkMock((url) =>
          url.pathname === '/v1.0/me/outlook/masterCategories'
            ? json({ value: [{ id: 'category-1', displayName: 'Customer', color: 'preset7' }] })
            : undefined,
        );

        await provider(mock.fetchMock).modify(ids, action);

        expect(mock.maxInFlight()).toBeLessThanOrEqual(4);
      },
    );

    it('retries a throttled move after Retry-After', async () => {
      const mock = bulkMock((url, method, attempt) =>
        url.pathname === '/v1.0/me/messages/message-3/move' && attempt === 1
          ? json({ error: { code: 'TooManyRequests', message: 'slow down' } }, 429, { 'retry-after': '0' })
          : undefined,
      );

      await provider(mock.fetchMock).modify(ids, 'archive');

      expect(mock.attempts.get('POST /v1.0/me/messages/message-3/move')).toBe(2);
      expect(mock.calls.filter((call) => call.path.endsWith('/move'))).toHaveLength(26);
    });

    it('maps a missing message to not_found before any move starts', async () => {
      const mock = bulkMock((url, method) =>
        url.pathname === '/v1.0/me/messages/message-21' && method === 'GET'
          ? json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404)
          : undefined,
      );

      await expect(provider(mock.fetchMock).modify(ids, { move: 'Inbox/Projects' })).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(mock.calls.some((call) => call.path.endsWith('/move'))).toBe(false);
    });

    it('does not retry a move that fails with a server error and starts no new moves after it', async () => {
      const mock = bulkMock((url) =>
        url.pathname === '/v1.0/me/messages/message-2/move'
          ? json({ error: { code: 'ServiceUnavailable', message: 'offline' } }, 503)
          : undefined,
      );

      await expect(provider(mock.fetchMock).modify(ids, 'trash')).rejects.toMatchObject({
        code: 'provider_unavailable',
        failure: { provider: 'outlook', httpStatus: 503, reason: 'http_error' },
      });
      expect(mock.attempts.get('POST /v1.0/me/messages/message-2/move')).toBe(1);
      expect(mock.calls.length).toBeLessThan(ids.length);
    });

    it('reports a timed-out move as a request timeout without retrying it', async () => {
      const mock = bulkMock((url) => {
        if (url.pathname === '/v1.0/me/messages/message-0/move') {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }
        return undefined;
      });

      await expect(provider(mock.fetchMock).modify(['message-0'], 'trash')).rejects.toMatchObject({
        code: 'provider_unavailable',
        failure: { provider: 'outlook', phase: 'request', reason: 'request_timeout' },
      });
      expect(mock.attempts.get('POST /v1.0/me/messages/message-0/move')).toBe(1);
    });
  });
});

describe('OutlookProvider ported Cloud fixes', () => {
  it('looks up well-known folders at most four at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return folderResponse(new URL(String(input))) ?? json({ value: [] });
      } finally {
        inFlight -= 1;
      }
    }) as unknown as typeof fetch;

    await provider(fetchMock).listFolders();
    expect(maxInFlight).toBe(4);
  });

  it('waits for every started well-known folder lookup before reporting a failure', async () => {
    let slowFinished = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1.0/me/mailFolders/inbox') return json({ error: { code: 'ServiceUnavailable' } }, 400);
      if (url.pathname === '/v1.0/me/mailFolders/sentitems') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        slowFinished = true;
      }
      return folderResponse(url) ?? json({ value: [] });
    }) as unknown as typeof fetch;

    await expect(provider(fetchMock).listFolders()).rejects.toBeDefined();
    expect(slowFinished).toBe(true);
  });

  it('checks large attachments chunk by chunk', () => {
    const outlook = provider(vi.fn() as unknown as typeof fetch) as unknown as {
      decodedAttachment: (input: { filename: string; mimeType: string; content: string }) => Buffer;
    };
    const bytes = Buffer.alloc(200_000, 9);
    const content = bytes.toString('base64');
    expect(outlook.decodedAttachment({ filename: 'a.bin', mimeType: 'application/octet-stream', content })).toEqual(
      bytes,
    );
    for (const invalid of [`${content.slice(0, -8)}!!!!${content.slice(-4)}`, `${content}AAAA`.slice(0, -1)]) {
      expect(() =>
        outlook.decodedAttachment({ filename: 'a.bin', mimeType: 'application/octet-stream', content: invalid }),
      ).toThrow('Attachment "a.bin" is not valid base64');
    }
  });
});

describe('OutlookProvider sender name', () => {
  it('reports no name, because the mail service decides the one a message carries', async () => {
    const resolveSender = vi.fn((email: string) => ({ email, name: 'Sales' }));
    const outlook = new OutlookProvider({
      accountId: 'acct-1',
      tokenProvider: { getAccessToken: vi.fn().mockResolvedValue('access-token') },
      fetch: vi.fn() as unknown as typeof fetch,
      resolveSender,
    });

    await expect(outlook.senderName()).resolves.toBeUndefined();
    await expect(
      (outlook.senderName as (from?: string) => Promise<unknown>)('sales@example.com'),
    ).resolves.toBeUndefined();
    expect(resolveSender).not.toHaveBeenCalled();
  });
});

describe('OutlookProvider folder creation', () => {
  interface FakeFolder {
    id: string;
    displayName: string;
    parentId?: string;
    isHidden?: boolean;
  }

  function graph(extra: FakeFolder[] = []) {
    const tree: FakeFolder[] = [
      ...folders.map(({ id, displayName }) => ({ id, displayName })),
      { id: 'folder-projects', displayName: 'Projects', parentId: 'folder-inbox' },
      ...extra,
    ];
    let next = 1;
    const posts: Array<{ path: string; body: unknown }> = [];
    const moves: unknown[] = [];
    const children = (parentId?: string) =>
      tree
        .filter((folder) => folder.parentId === parentId)
        .map((folder) => ({
          id: folder.id,
          displayName: folder.displayName,
          isHidden: folder.isHidden ?? false,
          childFolderCount: tree.filter((child) => child.parentId === folder.id).length,
          unreadItemCount: 0,
        }));
    const conflict = vi.fn((_parentId: string | undefined, _name: string) => false);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'POST' && /^\/v1\.0\/me\/mailFolders(\/[^/]+\/childFolders)?$/.test(url.pathname)) {
        const parentId = url.pathname.match(/mailFolders\/([^/]+)\/childFolders/)?.[1];
        const body = JSON.parse(String(init?.body)) as { displayName: string };
        posts.push({ path: url.pathname, body });
        const taken = tree.some(
          (folder) =>
            folder.parentId === parentId && folder.displayName.toLowerCase() === body.displayName.toLowerCase(),
        );
        if (taken || conflict(parentId, body.displayName)) {
          return json(
            { error: { code: 'ErrorFolderExists', message: 'A folder with the specified name already exists.' } },
            409,
          );
        }
        const created = {
          id: `folder-new-${next++}`,
          displayName: body.displayName,
          ...(parentId ? { parentId } : {}),
        };
        tree.push(created);
        return json({ id: created.id, displayName: created.displayName, unreadItemCount: 0 }, 201);
      }
      if (url.pathname === '/v1.0/me/mailFolders' && url.searchParams.has('includeHiddenFolders')) {
        return json({ value: children(undefined) });
      }
      const childMatch = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)\/childFolders$/);
      if (childMatch) return json({ value: children(decodeURIComponent(childMatch[1]!)) });
      const known = folderResponse(url);
      if (known) return known;
      if (url.pathname === '/v1.0/me/messages/message-1/move') {
        moves.push(JSON.parse(String(init?.body)));
        return json({ id: 'message-1' }, 201);
      }
      if (url.pathname === '/v1.0/me/messages/message-1') return json({ parentFolderId: 'folder-inbox' });
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    return { outlook: provider(fetchMock), tree, posts, moves, conflict };
  }

  it('creates a top-level folder and moves messages into it', async () => {
    const { outlook, posts, moves } = graph();

    await outlook.listFolders();
    const folder = await outlook.createFolder(' Receipts ');
    expect(folder).toEqual({ id: 'folder-new-1', name: 'Receipts', unreadCount: 0 });
    expect(posts).toEqual([{ path: '/v1.0/me/mailFolders', body: { displayName: 'Receipts' } }]);
    // The folder cache was cleared, so the move finds the new folder.
    await outlook.modify(['message-1'], { move: folder.name });
    expect(moves).toEqual([{ destinationId: 'folder-new-1' }]);
  });

  it('creates missing parents under an existing folder', async () => {
    const { outlook, posts } = graph();

    await expect(outlook.createFolder('inbox/projects/2026/Q1')).resolves.toEqual({
      id: 'folder-new-2',
      name: 'Inbox/Projects/2026/Q1',
      unreadCount: 0,
    });
    expect(posts).toEqual([
      { path: '/v1.0/me/mailFolders/folder-projects/childFolders', body: { displayName: '2026' } },
      { path: '/v1.0/me/mailFolders/folder-new-1/childFolders', body: { displayName: 'Q1' } },
    ]);
    await expect(outlook.listFolders()).resolves.toContainEqual(
      expect.objectContaining({ id: 'folder-new-2', name: 'Inbox/Projects/2026/Q1' }),
    );
  });

  it('returns an existing folder in any case without creating it', async () => {
    const { outlook, posts } = graph();

    await expect(outlook.createFolder('INBOX/PROJECTS')).resolves.toEqual({
      id: 'folder-projects',
      name: 'Inbox/Projects',
      unreadCount: 0,
    });
    expect(posts).toEqual([]);
  });

  it('returns the folder when Outlook reports the name was taken in the meantime', async () => {
    const { outlook, tree, conflict } = graph();
    conflict.mockImplementationOnce(() => {
      tree.push({ id: 'folder-other', displayName: 'Receipts' });
      return true;
    });

    await expect(outlook.createFolder('Receipts')).resolves.toEqual({
      id: 'folder-other',
      name: 'Receipts',
      unreadCount: 0,
    });
  });

  it('reports a name taken by a hidden folder', async () => {
    const { outlook } = graph([{ id: 'folder-hidden', displayName: 'Secret', isHidden: true }]);

    const error = await outlook.createFolder('Secret').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({
      code: 'invalid_request',
      message: 'A folder named "Secret" already exists but is hidden from folder lists. Choose another name.',
      failure: { provider: 'outlook', httpStatus: 409 },
    });
  });

  it('reports a name Outlook refuses without its response text', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST')
        return json({ error: { code: 'ErrorInvalidRequest', message: 'private reason' } }, 400);
      const url = new URL(String(input));
      if (url.pathname === '/v1.0/me/mailFolders' && url.searchParams.has('includeHiddenFolders')) {
        return json({ value: [] });
      }
      return folderResponse(url) ?? json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;

    const error = await provider(fetchMock)
      .createFolder('Bad')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect((error as Error).message).toBe(
      `Outlook would not create the folder "Bad". The name may use characters or a length Outlook doesn't allow.`,
    );
  });

  it.each(['Inbox', 'Deleted Items', 'junkemail', 'SentItems', 'Archive', 'Flagged', 'All mail', 'Flagged/Later'])(
    'rejects the system folder %s',
    async (name) => {
      const { outlook, posts } = graph();

      await expect(outlook.createFolder(name)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(posts).toEqual([]);
    },
  );

  it('allows a subfolder of a role folder', async () => {
    const { outlook } = graph();

    await expect(outlook.createFolder('Archive/2025')).resolves.toMatchObject({ name: 'Archive/2025' });
  });

  it('refuses folders in the trash, where messages cannot be moved', async () => {
    const { outlook, posts } = graph([{ id: 'folder-old', displayName: 'Old', parentId: 'folder-trash' }]);

    await expect(outlook.createFolder('Deleted Items/2025')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Deleted Items" is the trash folder. Choose another name.',
    });
    await expect(outlook.createFolder('Deleted Items/Old/2025')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Deleted Items/Old" is in the trash. Choose another name.',
    });
    expect(posts).toEqual([]);
  });

  it('returns a folder whose own name contains the separator without creating a parent', async () => {
    const { outlook, posts } = graph([{ id: 'folder-flat', displayName: 'Clients/Acme' }]);

    await expect(outlook.createFolder('Clients/Acme')).resolves.toMatchObject({
      id: 'folder-flat',
      name: 'Clients/Acme',
    });
    expect(posts).toEqual([]);
  });

  it('drops spaces around each level', async () => {
    const { outlook, posts } = graph();

    await expect(outlook.createFolder('Inbox / Projects / 2026')).resolves.toMatchObject({
      name: 'Inbox/Projects/2026',
    });
    expect(posts).toEqual([
      { path: '/v1.0/me/mailFolders/folder-projects/childFolders', body: { displayName: '2026' } },
    ]);
  });

  it('rejects a missing parent with a system name', async () => {
    const { outlook, posts } = graph();

    await expect(outlook.createFolder('SentItems/2025')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"SentItems" is a system folder. Choose another name.',
    });
    expect(posts).toEqual([]);
  });

  it.each(['Projects/', 'Projects//2026'])('rejects the empty level in %j', async (name) => {
    const { outlook, posts } = graph();

    await expect(outlook.createFolder(name)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(posts).toEqual([]);
  });
});

describe('OutlookProvider folder deletion', () => {
  interface FakeFolder {
    id: string;
    displayName: string;
    parentId?: string;
    totalItemCount?: number;
    isHidden?: boolean;
  }

  function graph(extra: FakeFolder[] = []) {
    const tree: FakeFolder[] = [
      ...folders.map(({ id, displayName }) => ({ id, displayName })),
      { id: 'folder-projects', displayName: 'Projects', parentId: 'folder-inbox' },
      { id: 'folder-trash-child', displayName: 'Deleted Project', parentId: 'folder-trash' },
      ...extra,
    ];
    const deletes: string[] = [];
    const childCount = (id: string) => tree.filter((child) => child.parentId === id).length;
    const children = (parentId?: string) =>
      tree
        .filter((folder) => folder.parentId === parentId)
        .map((folder) => ({
          id: folder.id,
          displayName: folder.displayName,
          isHidden: folder.isHidden ?? false,
          childFolderCount: childCount(folder.id),
          unreadItemCount: 0,
        }));
    const refuseDelete = vi.fn((_id: string): Response | undefined => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const single = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)$/);
      const singleId = single ? decodeURIComponent(single[1]!) : undefined;
      const stored = tree.find((folder) => folder.id === singleId);
      if (method === 'DELETE' && singleId) {
        const refused = refuseDelete(singleId);
        if (refused) return refused;
        if (!stored) return json({ error: { code: 'ErrorItemNotFound', message: 'private gone' } }, 404);
        deletes.push(singleId);
        tree.splice(tree.indexOf(stored), 1);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/v1.0/me/mailFolders' && url.searchParams.has('includeHiddenFolders')) {
        return json({ value: children(undefined) });
      }
      const childMatch = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)\/childFolders$/);
      if (childMatch) return json({ value: children(decodeURIComponent(childMatch[1]!)) });
      if (stored && url.searchParams.get('$select')?.includes('totalItemCount')) {
        return json({
          id: stored.id,
          totalItemCount: stored.totalItemCount ?? 0,
          childFolderCount: childCount(stored.id),
        });
      }
      const known = folderResponse(url);
      if (known) return known;
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    return { outlook: provider(fetchMock), tree, deletes, refuseDelete, fetchMock };
  }

  it('deletes an empty folder by name or ID, and the next listing leaves it out', async () => {
    const { outlook, deletes } = graph([
      { id: 'folder-receipts', displayName: 'Receipts' },
      { id: 'folder-old', displayName: 'Old' },
    ]);
    await outlook.listFolders();

    await expect(outlook.deleteFolder('receipts')).resolves.toMatchObject({ id: 'folder-receipts', name: 'Receipts' });
    await expect(outlook.deleteFolder('folder-old')).resolves.toMatchObject({ id: 'folder-old', name: 'Old' });
    expect(deletes).toEqual(['folder-receipts', 'folder-old']);
    // The folder cache was cleared, so a move no longer finds the folder.
    await expect(outlook.modify(['message-1'], { move: 'Receipts' })).rejects.toMatchObject({ code: 'not_found' });
    const names = (await outlook.listFolders()).map((folder) => folder.name);
    expect(names).not.toContain('Receipts');
  });

  it('deletes a subfolder named by its path', async () => {
    const { outlook, deletes } = graph();

    await expect(outlook.deleteFolder('Inbox/Projects')).resolves.toMatchObject({ id: 'folder-projects' });
    expect(deletes).toEqual(['folder-projects']);
  });

  it('refuses a folder that still has messages, counted right before the delete', async () => {
    const { outlook, tree, deletes } = graph([{ id: 'folder-receipts', displayName: 'Receipts' }]);
    await outlook.listFolders();
    // Mail arrives after the folder list was cached.
    tree.find((folder) => folder.id === 'folder-receipts')!.totalItemCount = 12;

    await expect(outlook.deleteFolder('Receipts')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Receipts" still has 12 messages. Move or trash them first.',
    });
    expect(deletes).toEqual([]);
  });

  it('refuses a folder with subfolders', async () => {
    const { outlook, deletes } = graph([
      { id: 'folder-clients', displayName: 'Clients' },
      { id: 'folder-acme', displayName: 'Acme', parentId: 'folder-clients' },
    ]);

    await expect(outlook.deleteFolder('Clients')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Clients" has subfolders. Delete them first.',
    });
    expect(deletes).toEqual([]);
  });

  it.each([
    'Inbox',
    'inbox',
    'Sent Items',
    'sentitems',
    'Deleted Items',
    'Junk Email',
    'Archive',
    'Flagged',
    'all',
    'starred',
  ])('refuses the system folder %s', async (name) => {
    const { outlook, deletes } = graph();

    await expect(outlook.deleteFolder(name)).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining("is a system folder and can't be deleted."),
    });
    expect(deletes).toEqual([]);
  });

  it('deletes a user folder whose name is a role word, beside the system folder for that role', async () => {
    const { outlook, deletes } = graph([{ id: 'folder-user-spam', displayName: 'Spam' }]);

    await expect(outlook.deleteFolder('Spam')).resolves.toMatchObject({ id: 'folder-user-spam' });
    await expect(outlook.deleteFolder('junkemail')).rejects.toMatchObject({
      message: expect.stringContaining("is a system folder and can't be deleted."),
    });
    expect(deletes).toEqual(['folder-user-spam']);
  });

  it('says when the subfolders are hidden from folder lists', async () => {
    const { outlook, deletes } = graph([
      { id: 'folder-clients', displayName: 'Clients' },
      { id: 'folder-hidden', displayName: 'Sync data', parentId: 'folder-clients', isHidden: true },
    ]);

    await expect(outlook.deleteFolder('Clients')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Clients" has subfolders that Outlook hides from folder lists. Delete them in Outlook first.',
    });
    expect(deletes).toEqual([]);
  });

  it('refuses a folder already in Deleted Items', async () => {
    const { outlook, deletes } = graph();

    await expect(outlook.deleteFolder('Deleted Items/Deleted Project')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Deleted Items/Deleted Project" is already in Deleted Items.',
    });
    expect(deletes).toEqual([]);
  });

  it('reports a missing folder as not found, including one deleted after the listing', async () => {
    const { outlook, tree, refuseDelete } = graph([{ id: 'folder-receipts', displayName: 'Receipts' }]);

    await expect(outlook.deleteFolder('Missing')).rejects.toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no folder named "Missing".',
    });
    refuseDelete.mockImplementationOnce(() => {
      tree.splice(
        tree.findIndex((folder) => folder.id === 'folder-receipts'),
        1,
      );
      return json({ error: { code: 'ErrorItemNotFound', message: 'private gone' } }, 404);
    });
    const error = await outlook.deleteFolder('Receipts').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({ code: 'not_found', message: 'This mailbox has no folder named "Receipts".' });
  });

  it('explains a delete that Graph refuses with a conflict', async () => {
    const { outlook, refuseDelete } = graph([{ id: 'folder-receipts', displayName: 'Receipts' }]);
    refuseDelete.mockImplementationOnce(() =>
      json({ error: { code: 'ErrorFolderExists', message: 'private exists' } }, 409),
    );

    const error = await outlook.deleteFolder('Receipts').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({
      code: 'invalid_request',
      message: 'Outlook would not delete the folder "Receipts". Delete it in Outlook instead.',
    });
  });

  it('explains a folder Graph refuses to delete without its error text', async () => {
    const { outlook, refuseDelete } = graph([
      { id: 'folder-outbox', displayName: 'Outbox' },
      { id: 'folder-locked', displayName: 'Locked' },
    ]);
    refuseDelete.mockImplementation((id) =>
      id === 'folder-outbox'
        ? json({ error: { code: 'ErrorDeleteDistinguishedFolder', message: 'private distinguished' } }, 400)
        : json({ error: { code: 'ErrorAccessDenied', message: 'private denied' } }, 403),
    );

    await expect(outlook.deleteFolder('Outbox')).rejects.toMatchObject({
      code: 'invalid_request',
      message:
        'Outlook would not delete the folder "Outbox". It may be a folder Outlook keeps for its own use, such as Outbox or Conversation History.',
    });
    const denied = await outlook.deleteFolder('Locked').catch((caught: unknown) => caught);
    expect(denied).toBeInstanceOf(FolderNameError);
    expect(denied).toMatchObject({ code: 'permission_denied' });
    expect((denied as Error).message).not.toContain('private');
  });
});

describe('OutlookProvider category changes', () => {
  type Category = { id: string; displayName: string; color: string };

  function categoryMailbox(
    initial: Category[],
    respond?: (method: string, url: URL, body: unknown, categories: Category[]) => Response | undefined,
  ) {
    const categories = [...initial];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const custom = respond?.(method, url, body, categories);
      if (custom) return custom;
      if (url.pathname === '/v1.0/me/outlook/masterCategories' && method === 'GET') return json({ value: categories });
      if (url.pathname === '/v1.0/me/outlook/masterCategories' && method === 'POST') {
        const created = { id: `category-${categories.length + 1}`, ...(body as Omit<Category, 'id'>) };
        categories.push(created);
        return json(created, 201);
      }
      const match = url.pathname.match(/^\/v1\.0\/me\/outlook\/masterCategories\/([^/]+)$/);
      if (match && method === 'DELETE') {
        const index = categories.findIndex((category) => category.id === decodeURIComponent(match[1]!));
        if (index < 0) return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
        categories.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    return { outlook: provider(fetchMock), fetchMock, categories };
  }

  function writes(fetchMock: typeof fetch) {
    return (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET',
    );
  }

  it('adds a category without a color and returns it as categories are listed', async () => {
    const { outlook, fetchMock } = categoryMailbox([]);
    await expect(outlook.createLabel('  Customers  ')).resolves.toEqual({
      id: 'category-1',
      name: 'Customers',
      color: { preset: 'none' },
    });
    const [[, init]] = writes(fetchMock) as Array<[unknown, RequestInit]>;
    expect(JSON.parse(String(init.body))).toEqual({ displayName: 'Customers', color: 'none' });
    await expect(outlook.listLabels()).resolves.toEqual([
      { id: 'category-1', name: 'Customers', color: { preset: 'none' } },
    ]);
  });

  it('returns an existing category with the name, in any case, without adding one', async () => {
    const { outlook, fetchMock } = categoryMailbox([{ id: 'category-1', displayName: 'Customers', color: 'preset7' }]);
    await expect(outlook.createLabel('customers')).resolves.toEqual({
      id: 'category-1',
      name: 'Customers',
      color: { preset: 'preset7' },
    });
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('returns a category another app added after the listing instead of failing', async () => {
    let listed = 0;
    const { outlook } = categoryMailbox([], (method, url, _body, categories) => {
      if (url.pathname !== '/v1.0/me/outlook/masterCategories') return undefined;
      if (method === 'GET' && listed++ === 1)
        categories.push({ id: 'category-9', displayName: 'Customers', color: 'preset3' });
      if (method === 'POST') return json({ error: { code: 'ErrorFolderExists', message: 'exists' } }, 409);
      return undefined;
    });
    await expect(outlook.createLabel('Customers')).resolves.toMatchObject({ id: 'category-9', name: 'Customers' });
  });

  it('explains a category name Outlook refuses without repeating the provider message', async () => {
    const { outlook } = categoryMailbox([], (method, url) =>
      method === 'POST' && url.pathname === '/v1.0/me/outlook/masterCategories'
        ? json({ error: { code: 'ErrorInvalidRequest', message: 'private provider detail' } }, 400)
        : undefined,
    );
    const error = await outlook.createLabel('Bad,Name').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({
      code: 'invalid_request',
      message:
        'Outlook would not create the category "Bad,Name". The name may use characters or a length Outlook doesn\'t allow.',
    });
    expect((error as Error).message).not.toContain('private provider detail');
  });

  it('rejects an empty name or control characters before calling Outlook', async () => {
    const { outlook, fetchMock } = categoryMailbox([]);
    await expect(outlook.createLabel('   ')).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'The category name is empty.',
    });
    await expect(outlook.createLabel('Bad\u0007')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for MailboxSettings.ReadWrite when a connection can only read categories', async () => {
    const denied = (method: string, url: URL) =>
      method !== 'GET' && url.pathname.startsWith('/v1.0/me/outlook/masterCategories')
        ? json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403)
        : undefined;
    const { outlook } = categoryMailbox([{ id: 'category-1', displayName: 'Customers', color: 'preset7' }], denied);
    const message =
      "This Outlook connection can't change categories. Reauthorize the account to grant MailboxSettings.ReadWrite.";
    await expect(outlook.createLabel('Vendors')).rejects.toMatchObject({ code: 'permission_denied', message });
    await expect(outlook.deleteLabel('Customers')).rejects.toMatchObject({ code: 'permission_denied', message });
    await expect(outlook.createLabel('Vendors')).rejects.toBeInstanceOf(FolderNameError);
  });

  it("asks for MailboxSettings.ReadWrite when a connection can't read categories either", async () => {
    const { outlook, fetchMock } = categoryMailbox([], (_method, url) =>
      url.pathname.startsWith('/v1.0/me/outlook/masterCategories')
        ? json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403)
        : undefined,
    );
    const message =
      "This Outlook connection can't change categories. Reauthorize the account to grant MailboxSettings.ReadWrite.";
    await expect(outlook.createLabel('Vendors')).rejects.toMatchObject({ code: 'permission_denied', message });
    await expect(outlook.deleteLabel('Customers')).rejects.toMatchObject({ code: 'permission_denied', message });
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('deletes a category by name or ID and returns it as it was listed', async () => {
    const { outlook, categories, fetchMock } = categoryMailbox([
      { id: 'category-1', displayName: 'Customers', color: 'preset7' },
      { id: 'category/2', displayName: 'Vendors', color: 'preset1' },
    ]);
    await expect(outlook.deleteLabel('customers')).resolves.toEqual({
      id: 'category-1',
      name: 'Customers',
      color: { preset: 'preset7' },
    });
    await expect(outlook.deleteLabel('category/2')).resolves.toMatchObject({ id: 'category/2', name: 'Vendors' });
    expect(categories).toEqual([]);
    expect(writes(fetchMock).map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/v1.0/me/outlook/masterCategories/category-1',
      '/v1.0/me/outlook/masterCategories/category%2F2',
    ]);
  });

  it('reports a missing category as not found, including one deleted after the listing', async () => {
    const { outlook, fetchMock } = categoryMailbox(
      [{ id: 'category-1', displayName: 'Customers', color: 'preset7' }],
      (method) =>
        method === 'DELETE' ? json({ error: { code: 'ErrorItemNotFound', message: 'gone' } }, 404) : undefined,
    );
    await expect(outlook.deleteLabel('Vendors')).rejects.toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no category named "Vendors".',
    });
    expect(writes(fetchMock)).toHaveLength(0);
    await expect(outlook.deleteLabel('Customers')).rejects.toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no category named "Customers".',
    });
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it('does not resend a category change after a server error', async () => {
    const { outlook, fetchMock } = categoryMailbox(
      [{ id: 'category-1', displayName: 'Customers', color: 'preset7' }],
      (method) =>
        method !== 'GET' ? json({ error: { code: 'ServiceUnavailable', message: 'busy' } }, 503) : undefined,
    );
    await expect(outlook.createLabel('Vendors')).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(outlook.deleteLabel('Customers')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(writes(fetchMock)).toHaveLength(2);
  });
});

describe('OutlookProvider folder renaming', () => {
  interface FakeFolder {
    id: string;
    displayName: string;
    parentId?: string;
  }

  function graph(extra: FakeFolder[] = []) {
    const tree: FakeFolder[] = [
      ...folders.map(({ id, displayName }) => ({ id, displayName })),
      { id: 'folder-projects', displayName: 'Projects', parentId: 'folder-inbox' },
      { id: 'folder-trash-child', displayName: 'Deleted Project', parentId: 'folder-trash' },
      ...extra,
    ];
    const patches: Array<{ id: string; body: unknown }> = [];
    const children = (parentId?: string) =>
      tree
        .filter((folder) => folder.parentId === parentId)
        .map((folder) => ({
          id: folder.id,
          displayName: folder.displayName,
          isHidden: false,
          childFolderCount: tree.filter((child) => child.parentId === folder.id).length,
          unreadItemCount: 0,
        }));
    const refusePatch = vi.fn((_id: string): Response | undefined => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const single = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)$/);
      const singleId = single ? decodeURIComponent(single[1]!) : undefined;
      const stored = tree.find((folder) => folder.id === singleId);
      if (method === 'PATCH' && singleId) {
        const refused = refusePatch(singleId);
        if (refused) return refused;
        if (!stored) return json({ error: { code: 'ErrorItemNotFound', message: 'private gone' } }, 404);
        const body = JSON.parse(String(init?.body)) as { displayName: string };
        patches.push({ id: singleId, body });
        stored.displayName = body.displayName;
        return json({ id: stored.id, displayName: stored.displayName });
      }
      if (url.pathname === '/v1.0/me/mailFolders' && url.searchParams.has('includeHiddenFolders')) {
        return json({ value: children(undefined) });
      }
      const childMatch = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)\/childFolders$/);
      if (childMatch) return json({ value: children(decodeURIComponent(childMatch[1]!)) });
      if (stored && url.searchParams.get('$select')?.includes('displayName')) {
        return json({ id: stored.id, displayName: stored.displayName });
      }
      const known = folderResponse(url);
      if (known) return known;
      return json({ error: { code: 'ErrorItemNotFound', message: 'missing' } }, 404);
    }) as unknown as typeof fetch;
    return { outlook: provider(fetchMock), tree, patches, refusePatch };
  }

  it('renames a folder by name or ID and keeps its ID', async () => {
    const { outlook, patches } = graph([
      { id: 'folder-receipts', displayName: 'Receipts' },
      { id: 'folder-old', displayName: 'Old' },
    ]);
    await outlook.listFolders();

    await expect(outlook.renameFolder('receipts', ' Invoices ')).resolves.toMatchObject({
      folder: { id: 'folder-receipts', name: 'Invoices' },
      previous: { id: 'folder-receipts', name: 'Receipts' },
    });
    await expect(outlook.renameFolder('folder-old', 'Older')).resolves.toMatchObject({
      folder: { id: 'folder-old', name: 'Older' },
      previous: { id: 'folder-old', name: 'Old' },
    });
    expect(patches).toEqual([
      { id: 'folder-receipts', body: { displayName: 'Invoices' } },
      { id: 'folder-old', body: { displayName: 'Older' } },
    ]);
    // The folder cache was cleared, so the next listing has the new names.
    const names = (await outlook.listFolders()).map((folder) => folder.name);
    expect(names).toContain('Invoices');
    expect(names).not.toContain('Receipts');
  });

  it('keeps a subfolder under its parent, and its own subfolders follow', async () => {
    const { outlook, patches } = graph([{ id: 'folder-2025', displayName: '2025', parentId: 'folder-projects' }]);

    await expect(outlook.renameFolder('Inbox/Projects', 'Work')).resolves.toMatchObject({
      folder: { id: 'folder-projects', name: 'Inbox/Work' },
      previous: { id: 'folder-projects', name: 'Inbox/Projects' },
    });
    expect(patches).toEqual([{ id: 'folder-projects', body: { displayName: 'Work' } }]);
    expect((await outlook.listFolders()).map((folder) => folder.name)).toContain('Inbox/Work/2025');
  });

  it('renames a folder whose own name contains a slash', async () => {
    const { outlook } = graph([{ id: 'folder-slash', displayName: 'A/B', parentId: 'folder-projects' }]);

    await expect(outlook.renameFolder('folder-slash', 'C')).resolves.toMatchObject({
      folder: { id: 'folder-slash', name: 'Inbox/Projects/C' },
      previous: { id: 'folder-slash', name: 'Inbox/Projects/A/B' },
    });
  });

  it('refuses a name another folder has, ignoring case, but allows a change of case', async () => {
    const { outlook, patches, refusePatch } = graph([
      { id: 'folder-receipts', displayName: 'Receipts' },
      { id: 'folder-invoices', displayName: 'Invoices' },
    ]);

    await expect(outlook.renameFolder('Receipts', 'invoices')).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'A folder named "Invoices" already exists. Choose another name.',
    });
    expect(patches).toEqual([]);
    await expect(outlook.renameFolder('Invoices', 'INVOICES')).resolves.toMatchObject({
      folder: { id: 'folder-invoices', name: 'INVOICES' },
    });
    // Graph also knows folders it hides from folder lists.
    refusePatch.mockReturnValueOnce(json({ error: { code: 'ErrorFolderExists', message: 'private exists' } }, 409));
    const error = await outlook.renameFolder('Receipts', 'Hidden').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({ message: 'A folder named "Hidden" already exists. Choose another name.' });
  });

  it('returns the folder unchanged when the name is the one it has', async () => {
    const { outlook, patches } = graph([{ id: 'folder-receipts', displayName: 'Receipts' }]);

    const result = await outlook.renameFolder('Receipts', 'Receipts');

    expect(result.folder).toEqual(result.previous);
    expect(result.folder).toMatchObject({ id: 'folder-receipts', name: 'Receipts' });
    expect(patches).toEqual([]);
  });

  it('refuses system folders, folders in Deleted Items, role names and names with a slash', async () => {
    const { outlook, patches } = graph([{ id: 'folder-receipts', displayName: 'Receipts' }]);

    for (const folder of ['inbox', 'Sent Items', 'folder-trash', 'starred', 'sentitems', 'Archive']) {
      await expect(outlook.renameFolder(folder, 'Mine')).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining("is a system folder and can't be renamed"),
      });
    }
    await expect(outlook.renameFolder('folder-trash-child', 'Mine')).rejects.toMatchObject({
      message: '"Deleted Items/Deleted Project" is in Deleted Items, so it can\'t be renamed.',
    });
    for (const name of ['Inbox', 'trash', 'SentItems', 'junkemail']) {
      await expect(outlook.renameFolder('Receipts', name)).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining('is a system folder. Choose another name.'),
      });
    }
    await expect(outlook.renameFolder('Receipts', 'Money/Receipts')).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('can\'t contain "/"'),
    });
    for (const name of ['', '  ']) {
      await expect(outlook.renameFolder('Receipts', name)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(patches).toEqual([]);
  });

  it('reports a folder that does not exist, or is gone by the time it is renamed', async () => {
    const { outlook, refusePatch } = graph([{ id: 'folder-receipts', displayName: 'Receipts' }]);

    await expect(outlook.renameFolder('Missing', 'Found')).rejects.toMatchObject({
      code: 'not_found',
      message: 'This mailbox has no folder named "Missing".',
    });
    refusePatch.mockReturnValueOnce(json({ error: { code: 'ErrorItemNotFound', message: 'private gone' } }, 404));
    const error = await outlook.renameFolder('Receipts', 'Invoices').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({ code: 'not_found' });
  });

  it('says so without Graph text when Outlook refuses the rename', async () => {
    const { outlook, refusePatch } = graph([{ id: 'folder-receipts', displayName: 'Receipts' }]);

    refusePatch.mockReturnValueOnce(json({ error: { code: 'ErrorInvalidRequest', message: 'private reason' } }, 400));
    const invalid = (await outlook.renameFolder('Receipts', 'Bad:Name').catch((caught: unknown) => caught)) as Error;
    expect(invalid).toBeInstanceOf(FolderNameError);
    expect(invalid).toMatchObject({ code: 'invalid_request' });
    expect(invalid.message).toContain('Outlook would not rename the folder "Receipts" to "Bad:Name".');
    expect(invalid.message).not.toContain('private');

    refusePatch.mockReturnValueOnce(json({ error: { code: 'ErrorAccessDenied', message: 'private denied' } }, 403));
    const denied = (await outlook.renameFolder('Receipts', 'Invoices').catch((caught: unknown) => caught)) as Error;
    expect(denied).toMatchObject({ code: 'permission_denied' });
    expect(denied.message).not.toContain('private');
  });
});
