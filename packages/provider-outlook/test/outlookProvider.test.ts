import { describe, expect, it, vi } from 'vitest';
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
