import { OAuth2Client } from 'googleapis-common';
import { describe, expect, it, vi } from 'vitest';
import { GMAIL_CAPABILITIES, GmailProvider } from '../src/gmailProvider.js';

it('advertises portable Gmail search and archive support', () => {
  expect(GMAIL_CAPABILITIES.search).toMatchObject({
    folderRoles: { archive: 'available' },
    nativeQuery: { syntax: 'gmail', availability: 'available' },
  });
  expect(GMAIL_CAPABILITIES.search.filters).toEqual(expect.arrayContaining(['read', 'starred', 'hasAttachment']));
  expect(GMAIL_CAPABILITIES.searchContext).toBe(true);
});

interface ProviderInternals {
  listSendAs: GmailProvider['listSendAs'];
  gmail: {
    users: {
      settings: {
        sendAs: {
          list: () => Promise<{
            data: {
              sendAs?: Array<{
                sendAsEmail?: string;
                isPrimary?: boolean;
                displayName?: string;
                replyToAddress?: string;
                verificationStatus?: string;
              }>;
            };
          }>;
        };
      };
    };
  };
  resolveSenderName: () => Promise<string | null>;
}

function providerWith(
  auth: OAuth2Client,
  sendAs: Array<{
    sendAsEmail?: string;
    isPrimary?: boolean;
    displayName?: string;
    replyToAddress?: string;
    verificationStatus?: string;
  }>,
  displayName?: string,
): ProviderInternals {
  const provider = new GmailProvider({
    accountId: 'acct_1',
    email: 'me@example.com',
    ...(displayName ? { displayName } : {}),
    auth,
  });
  const internals = provider as unknown as ProviderInternals;
  internals.gmail = {
    users: {
      settings: {
        sendAs: { list: vi.fn().mockResolvedValue({ data: { sendAs } }) },
      },
    },
  };
  return internals;
}

describe('GmailProvider list hydration', () => {
  function providerWithMessages(getMessage: ReturnType<typeof vi.fn>) {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
          messages: {
            list: () => Promise<{ data: { messages: Array<{ id: string }> } }>;
            get: typeof getMessage;
          };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: {
          list: vi.fn().mockResolvedValue({
            data: { messages: [{ id: 'live' }, { id: 'deleted' }] },
          }),
          get: getMessage,
        },
      },
    };
    return provider;
  }

  it('skips a message deleted after the list response', async () => {
    const getMessage = vi.fn().mockImplementation(({ id }: { id: string }) => {
      if (id === 'deleted') {
        return Promise.reject(Object.assign(new Error('not found'), { code: 404 }));
      }
      return Promise.resolve({
        data: {
          id,
          threadId: 'thread_1',
          internalDate: '1751976000000',
          payload: { headers: [{ name: 'Subject', value: 'Still here' }] },
        },
      });
    });
    const provider = providerWithMessages(getMessage);

    await expect(provider.listMessages({})).resolves.toMatchObject({
      items: [{ id: 'live', subject: 'Still here' }],
    });
  });

  it('still surfaces non-404 hydration failures', async () => {
    const getMessage = vi.fn().mockRejectedValue(Object.assign(new Error('backend error'), { code: 400 }));
    const provider = providerWithMessages(getMessage);

    await expect(provider.listMessages({})).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('filters canonical attachments locally and fills from later Gmail pages', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: { messages: [{ id: 'inline' }], nextPageToken: 'page-2' } })
      .mockResolvedValueOnce({ data: { messages: [{ id: 'file' }] } });
    const get = vi.fn(async ({ id, format }: { id: string; format: string }) => ({
      data: {
        id,
        threadId: id,
        internalDate: '1767225600000',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: id }],
          parts: [
            {
              partId: '1',
              filename: `${id}.png`,
              mimeType: 'image/png',
              headers: [
                {
                  name: 'Content-Disposition',
                  value: id === 'inline' ? 'inline' : 'attachment',
                },
              ],
              body: { attachmentId: `attachment-${id}`, size: 12 },
            },
          ],
        },
      },
      format,
    }));
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: ReturnType<typeof vi.fn> };
          messages: { list: typeof list; get: typeof get };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { list, get },
      },
    };

    const result = await provider.listMessages({ hasAttachment: true }, { pageSize: 1 });
    expect(result.items.map((message) => message.id)).toEqual(['file']);
    expect(result.inspectedCandidates).toBe(2);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ format: 'full' }));
    expect(list.mock.calls[0]?.[0].q).toBeUndefined();
  });

  it('keeps filtered candidate batches large and carries unconsumed ids into the next page', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const ids = Array.from({ length: 100 }, (_, index) => `message-${index}`);
    const list = vi.fn().mockResolvedValue({
      data: { messages: ids.map((id) => ({ id })) },
    });
    const get = vi.fn(async ({ id }: { id: string }) => ({
      data: {
        id,
        threadId: id,
        internalDate: '1767225600000',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: id }],
          parts: [
            {
              partId: '1',
              filename: `${id}.txt`,
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Disposition', value: 'attachment' }],
              body: { attachmentId: `attachment-${id}`, size: 12 },
            },
          ],
        },
      },
    }));
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: ReturnType<typeof vi.fn> };
          messages: { list: typeof list; get: typeof get };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { list, get },
      },
    };

    const first = await provider.listMessages({ hasAttachment: true }, { pageSize: 25 });
    const second = await provider.listMessages(
      { hasAttachment: true },
      { pageSize: 25, pageToken: first.nextPageToken },
    );
    const third = await provider.listMessages(
      { hasAttachment: true },
      { pageSize: 25, pageToken: second.nextPageToken },
    );
    const fourth = await provider.listMessages(
      { hasAttachment: true },
      { pageSize: 25, pageToken: third.nextPageToken },
    );

    expect(first.items.map((message) => message.id)).toEqual(ids.slice(0, 25));
    expect(second.items.map((message) => message.id)).toEqual(ids.slice(25, 50));
    expect(third.items.map((message) => message.id)).toEqual(ids.slice(50, 75));
    expect(fourth.items.map((message) => message.id)).toEqual(ids.slice(75));
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 100 }));
    expect(first.nextPageToken).toBeTruthy();
    expect(second.nextPageToken).toBeTruthy();
    expect(third.nextPageToken).toBeTruthy();
    expect(fourth.nextPageToken).toBeUndefined();
  });

  it('continues after date filtering reaches the Gmail scan limit', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const ids = Array.from({ length: 1_001 }, (_, index) => `message-${index + 1}`);
    const list = vi.fn(async ({ maxResults, pageToken }: { maxResults: number; pageToken?: string }) => {
      const offset = pageToken ? Number(pageToken.slice('page-'.length)) : 0;
      const messages = ids.slice(offset, offset + maxResults).map((id) => ({ id }));
      const nextOffset = offset + messages.length;
      return {
        data: {
          messages,
          ...(nextOffset < ids.length ? { nextPageToken: `page-${nextOffset}` } : {}),
        },
      };
    });
    const get = vi.fn(async ({ id }: { id: string }) => ({
      data: {
        id,
        threadId: id,
        internalDate: String(
          Date.parse(id === 'message-1001' ? '2026-01-02T12:00:00.000Z' : '2026-01-03T00:00:00.000Z'),
        ),
        payload: { headers: [{ name: 'Subject', value: id }] },
      },
    }));
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: ReturnType<typeof vi.fn> };
          messages: { list: typeof list; get: typeof get };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { list, get },
      },
    };
    const query = { after: '2026-01-01', before: '2026-01-03' };

    const first = await provider.listMessages(query, { pageSize: 1 });
    const second = await provider.listMessages(query, { pageSize: 1, pageToken: first.nextPageToken });

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
    expect(list).toHaveBeenCalledTimes(11);
    expect(get).toHaveBeenCalledTimes(1_001);
  });

  it('fetches one full body for an accepted result when search context is requested', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const get = vi.fn(({ format }: { format: string }) =>
      Promise.resolve({
        data: {
          id: 'message-1',
          threadId: 'thread-1',
          internalDate: '1767225600000',
          snippet: 'Opening preview',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'Subject', value: 'Invoice' }],
            ...(format === 'full'
              ? { body: { data: Buffer.from('Opening line\nInvoice [ORDER_ID] is ready.').toString('base64url') } }
              : {}),
          },
        },
      }),
    );
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: ReturnType<typeof vi.fn> };
          messages: { list: ReturnType<typeof vi.fn>; get: typeof get };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { list: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'message-1' }] } }), get },
      },
    };

    const page = await provider.listMessages(
      { text: 'invoice [ORDER_ID]' },
      { includeSnippet: true, includeSearchContext: true },
    );

    expect(page.items[0]).toMatchObject({
      snippet: 'Opening preview',
      searchContext: { status: 'matched', excerpt: 'Invoice [ORDER_ID] is ready.' },
    });
    expect(get.mock.calls.map(([input]) => input.format)).toEqual(['metadata', 'full']);
  });

  it('loads search context for a chunk of results concurrently', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const ids = ['message-1', 'message-2', 'message-3'];
    const pendingFull: Array<() => void> = [];
    const get = vi.fn(({ id, format }: { id: string; format: string }) => {
      const data = {
        id,
        threadId: id,
        internalDate: '1767225600000',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: id }],
          ...(format === 'full' ? { body: { data: Buffer.from(`Invoice for ${id}`).toString('base64url') } } : {}),
        },
      };
      if (format !== 'full') return Promise.resolve({ data });
      return new Promise((resolve) => pendingFull.push(() => resolve({ data })));
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: ReturnType<typeof vi.fn> };
          messages: { list: ReturnType<typeof vi.fn>; get: typeof get };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { list: vi.fn().mockResolvedValue({ data: { messages: ids.map((id) => ({ id })) } }), get },
      },
    };

    const pageRequest = provider.listMessages({ text: 'invoice' }, { includeSearchContext: true });
    await vi.waitFor(() => expect(pendingFull).toHaveLength(ids.length));
    for (const resolve of pendingFull) resolve();
    const page = await pageRequest;

    expect(page.items.map((message) => message.searchContext)).toEqual(
      ids.map((id) => ({ status: 'matched', excerpt: `Invoice for ${id}` })),
    );
  });

  it('reuses a full MIME response when local attachment filtering already required it', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        id: 'message-1',
        threadId: 'thread-1',
        internalDate: '1767225600000',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: 'Invoice' }],
          parts: [
            {
              partId: '1',
              mimeType: 'text/plain',
              body: { data: Buffer.from('Invoice [ORDER_ID] is ready.').toString('base64url') },
            },
            {
              partId: '2',
              filename: 'receipt.pdf',
              mimeType: 'application/pdf',
              headers: [{ name: 'Content-Disposition', value: 'attachment' }],
              body: { attachmentId: 'attachment-1', size: 12 },
            },
          ],
        },
      },
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: ReturnType<typeof vi.fn> };
          messages: { list: ReturnType<typeof vi.fn>; get: typeof get };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { list: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'message-1' }] } }), get },
      },
    };

    const page = await provider.listMessages(
      { text: 'invoice [ORDER_ID]', hasAttachment: true },
      { includeSearchContext: true },
    );

    expect(page.items[0]?.searchContext).toEqual({
      status: 'matched',
      excerpt: 'Invoice [ORDER_ID] is ready.',
    });
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ format: 'full' }));
  });

  it('keeps Gmail metadata when optional search-context enrichment fails', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          id: 'message-1',
          threadId: 'thread-1',
          internalDate: '1767225600000',
          payload: { headers: [{ name: 'Subject', value: 'Invoice' }] },
        },
      })
      .mockRejectedValueOnce(Object.assign(new Error('private body failure'), { code: 404 }));
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: ReturnType<typeof vi.fn> };
          messages: { list: ReturnType<typeof vi.fn>; get: typeof get };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { list: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'message-1' }] } }), get },
      },
    };

    const page = await provider.listMessages({ text: 'invoice' }, { includeSearchContext: true });

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
});

describe('GmailProvider labels', () => {
  it('lists user labels with colors while keeping them available as folders', async () => {
    const gmailLabels = [
      { id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 2 },
      {
        id: 'Label_1',
        name: 'Projects',
        type: 'user',
        messagesUnread: 1,
        color: { backgroundColor: '#16a766', textColor: '#ffffff' },
      },
    ];
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      gmail: { users: { labels: { list: ReturnType<typeof vi.fn> } } };
    };
    internals.gmail = {
      users: { labels: { list: vi.fn().mockResolvedValue({ data: { labels: gmailLabels } }) } },
    };

    await expect(provider.listLabels()).resolves.toEqual([
      {
        id: 'Label_1',
        name: 'Projects',
        color: { background: '#16a766', text: '#ffffff' },
      },
    ]);
    await expect(provider.listFolders()).resolves.toContainEqual({
      id: 'Label_1',
      name: 'Projects',
      unreadCount: 1,
    });
  });
});

describe('GmailProvider getDraft', () => {
  function providerWithDraftsGet(draftsGet: ReturnType<typeof vi.fn>) {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
          drafts: { get: typeof draftsGet };
          messages: { get: ReturnType<typeof vi.fn> };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        drafts: { get: draftsGet },
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg_1',
              threadId: 'thread_1',
              internalDate: '1751976000000',
              payload: { headers: [{ name: 'Subject', value: 'Later' }] },
            },
          }),
        },
      },
    };
    return provider;
  }

  it('fetches a draft and stamps the draft id on the message', async () => {
    const draftsGet = vi.fn().mockResolvedValue({ data: { id: 'draft_1', message: { id: 'msg_1' } } });
    const provider = providerWithDraftsGet(draftsGet);

    await expect(provider.getDraft('draft_1')).resolves.toMatchObject({
      id: 'msg_1',
      draftId: 'draft_1',
      subject: 'Later',
    });
    expect(draftsGet).toHaveBeenCalledWith({ userId: 'me', id: 'draft_1' });
  });

  it('maps a missing draft to not_found', async () => {
    const draftsGet = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
    const provider = providerWithDraftsGet(draftsGet);

    await expect(provider.getDraft('gone')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('GmailProvider sender name', () => {
  it('lists only the primary and verified aliases with provider metadata', async () => {
    const provider = providerWith(new OAuth2Client(), [
      { sendAsEmail: 'me@example.com', isPrimary: true, displayName: 'Primary' },
      {
        sendAsEmail: 'sales@example.com',
        displayName: 'Sales',
        replyToAddress: 'replies@example.com',
        verificationStatus: 'accepted',
      },
      { sendAsEmail: 'pending@example.com', verificationStatus: 'pending' },
    ]);

    await expect(provider.listSendAs()).resolves.toEqual([
      { email: 'me@example.com', name: 'Primary', isPrimary: true, source: 'provider' },
      {
        email: 'sales@example.com',
        name: 'Sales',
        replyTo: 'replies@example.com',
        isPrimary: false,
        source: 'provider',
      },
    ]);
  });

  it('uses the primary Gmail send-as display name when configured', async () => {
    const auth = new OAuth2Client();
    const request = vi.spyOn(auth, 'request');
    const provider = providerWith(auth, [{ isPrimary: true, displayName: 'Gmail Name' }], 'Stored Name');

    await expect(provider.resolveSenderName()).resolves.toBe('Gmail Name');
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the current Google profile name for existing accounts without a stored name', async () => {
    const auth = new OAuth2Client();
    vi.spyOn(auth, 'request').mockResolvedValue({ data: { name: 'Richard Chu' } } as never);
    const provider = providerWith(auth, [{ isPrimary: true, displayName: '' }]);

    await expect(provider.resolveSenderName()).resolves.toBe('Richard Chu');
  });

  it('uses the stored name when profile lookup fails', async () => {
    const auth = new OAuth2Client();
    vi.spyOn(auth, 'request').mockRejectedValue(new Error('userinfo unavailable'));
    const provider = providerWith(auth, [], 'Stored Name');

    await expect(provider.resolveSenderName()).resolves.toBe('Stored Name');
  });

  it('does not cache the fallback name across a transient lookup failure', async () => {
    const auth = new OAuth2Client();
    vi.spyOn(auth, 'request').mockRejectedValue(new Error('userinfo unavailable'));
    const provider = providerWith(auth, [{ isPrimary: true, displayName: 'Gmail Name' }], 'Stored Name');
    const sendAsList = provider.gmail.users.settings.sendAs.list as ReturnType<typeof vi.fn>;
    sendAsList.mockRejectedValueOnce(Object.assign(new Error('backend error'), { code: 400 }));

    await expect(provider.resolveSenderName()).resolves.toBe('Stored Name');
    await expect(provider.resolveSenderName()).resolves.toBe('Gmail Name');
  });
});

describe('GmailProvider modify', () => {
  function providerWithBatchModify(deleteMessage = vi.fn().mockResolvedValue({ data: {} })) {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const batchModify = vi.fn().mockResolvedValue({ data: {} });
    const internals = provider as unknown as {
      gmail: {
        users: {
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
          messages: { batchModify: typeof batchModify; delete: typeof deleteMessage };
        };
      };
    };
    internals.gmail = {
      users: {
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        messages: { batchModify, delete: deleteMessage },
      },
    };
    return { provider, batchModify, deleteMessage };
  }

  it('moving to the inbox removes Spam without also removing Inbox', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    await provider.modify(['m1'], { move: 'inbox' });
    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] },
    });
  });

  it('permanently deletes when the token has full Gmail access', async () => {
    const { provider, deleteMessage } = providerWithBatchModify();

    await provider.modify(['m1'], 'delete');

    expect(deleteMessage).toHaveBeenCalledWith({ userId: 'me', id: 'm1' });
  });

  it('explains the Trash alternative when the token has insufficient scope', async () => {
    const deleteMessage = vi.fn().mockRejectedValue({
      response: {
        status: 403,
        data: {
          error: {
            message: 'Request had insufficient authentication scopes.',
            details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
          },
        },
      },
    });
    const { provider, batchModify } = providerWithBatchModify(deleteMessage);

    await expect(provider.modify(['m1'], 'delete')).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringContaining('Move the messages to the trash instead'),
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it('preserves other Gmail permission errors during permanent deletion', async () => {
    const deleteMessage = vi.fn().mockRejectedValue({
      response: {
        status: 403,
        data: { error: { message: 'Gmail API access is disabled', errors: [{ reason: 'domainPolicy' }] } },
      },
    });
    const { provider } = providerWithBatchModify(deleteMessage);

    await expect(provider.modify(['m1'], 'delete')).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: expect.not.stringContaining('Move the messages to the trash instead'),
    });
  });

  it('moving to archive removes Inbox and Spam instead of creating an "archive" label', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    await provider.modify(['m1'], { move: 'archive' });
    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], removeLabelIds: ['INBOX', 'SPAM'] },
    });
  });

  it('moving to Spam adds Spam and removes Inbox', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    await provider.modify(['m1'], { move: 'spam' });
    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
    });
  });

  it('rejects moving to "all"', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    await expect(provider.modify(['m1'], { move: 'all' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it.each(['sent', 'drafts', 'starred', 'trash'])('rejects moving to the reserved system role "%s"', async (role) => {
    const { provider, batchModify } = providerWithBatchModify();
    await expect(provider.modify(['m1'], { move: role })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it.each(['inbox', 'sent', 'draft', 'drafts', 'trash', 'spam', 'starred'])(
    'rejects manually changing the system "%s" label',
    async (label) => {
      const { provider, batchModify } = providerWithBatchModify();
      await expect(provider.modify(['m1'], { addLabels: [label] })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(batchModify).not.toHaveBeenCalled();
    },
  );

  it("chunks label modifications at Gmail's 1000-message limit", async () => {
    const { provider, batchModify } = providerWithBatchModify();
    const ids = Array.from({ length: 1001 }, (_, index) => `m${index}`);

    await provider.modify(ids, 'markRead');

    expect(batchModify).toHaveBeenCalledTimes(2);
    expect(batchModify.mock.calls[0]?.[0].requestBody.ids).toHaveLength(1000);
    expect(batchModify.mock.calls[1]?.[0].requestBody.ids).toEqual(['m1000']);
  });

  it('rejects modifications with more than 100 distinct labels', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    const labels = Array.from({ length: 101 }, (_, index) => `label-${index}`);

    await expect(provider.modify(['m1'], { addLabels: labels })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(batchModify).not.toHaveBeenCalled();
  });

  it('treats removing an unknown label as a no-op', async () => {
    const { provider, batchModify } = providerWithBatchModify();

    await expect(provider.modify(['m1'], { removeLabels: ['missing'] })).resolves.toBeUndefined();
    expect(batchModify).not.toHaveBeenCalled();
  });
});

describe('GmailProvider send', () => {
  function providerWithSend(send: ReturnType<typeof vi.fn>) {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      senderName: string | null;
      gmail: { users: { messages: { send: typeof send } } };
    };
    internals.senderName = null;
    internals.gmail = { users: { messages: { send } } };
    return provider;
  }

  it('does not retry a send that fails with a 5xx (Gmail may have already delivered it)', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('backend error'), { code: 500 }));
    const provider = providerWithSend(send);

    await expect(
      provider.send({ to: [{ email: 'bob@example.com' }], subject: 'Hi', body: { text: 'hello' } }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a send rejected with 429 before processing', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limit'), { code: 429 }))
      .mockResolvedValue({ data: { id: 'sent_1', threadId: 'thread_1' } });
    const provider = providerWithSend(send);

    await expect(
      provider.send({ to: [{ email: 'bob@example.com' }], subject: 'Hi', body: { text: 'hello' } }),
    ).resolves.toEqual({ id: 'sent_1', threadId: 'thread_1' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('allows a message addressed only through Bcc', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'sent_1', threadId: 'thread_1' } });
    const provider = providerWithSend(send);

    await expect(
      provider.send({ bcc: [{ email: 'hidden@example.com' }], subject: 'Hi', body: { text: 'hello' } }),
    ).resolves.toEqual({ id: 'sent_1', threadId: 'thread_1' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('uses a verified alias and its Reply-To address in the MIME message', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'sent_1', threadId: 'thread_1' } });
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          settings: { sendAs: { list: ReturnType<typeof vi.fn> } };
          messages: { send: typeof send };
        };
      };
    };
    internals.gmail = {
      users: {
        settings: {
          sendAs: {
            list: vi.fn().mockResolvedValue({
              data: {
                sendAs: [
                  { sendAsEmail: 'me@example.com', isPrimary: true },
                  {
                    sendAsEmail: 'sales@example.com',
                    displayName: 'Sales',
                    replyToAddress: 'replies@example.com',
                    verificationStatus: 'accepted',
                  },
                ],
              },
            }),
          },
        },
        messages: { send },
      },
    };

    await provider.send({
      from: 'sales@example.com',
      to: [{ email: 'customer@example.com' }],
      body: { text: 'Hello' },
    });

    const raw = Buffer.from(send.mock.calls[0]![0].requestBody.raw, 'base64url').toString();
    expect(raw).toContain('From: Sales <sales@example.com>');
    expect(raw).toContain('Reply-To: replies@example.com');
  });

  it('rejects a message with no recipients in any header', async () => {
    const send = vi.fn();
    const provider = providerWithSend(send);

    await expect(provider.send({ subject: 'Hi', body: { text: 'hello' } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('GmailProvider draft creation', () => {
  it('does not retry a create that fails with a 5xx', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('backend error'), { code: 500 }));
    const internals = provider as unknown as {
      senderName: string | null;
      gmail: { users: { drafts: { create: typeof create } } };
    };
    internals.senderName = null;
    internals.gmail = { users: { drafts: { create } } };

    await expect(
      provider.createDraft({ to: [{ email: 'bob@example.com' }], subject: 'Hi', body: { text: 'hello' } }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('GmailProvider draft updates', () => {
  it('keeps a reply draft on its thread when the update omits replyToMessageId', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const update = vi.fn().mockResolvedValue({ data: { id: 'draft_1', message: { id: 'msg_2' } } });
    const internals = provider as unknown as {
      senderName: string | null;
      gmail: {
        users: {
          drafts: {
            get: ReturnType<typeof vi.fn>;
            update: typeof update;
            list: ReturnType<typeof vi.fn>;
          };
          messages: { get: ReturnType<typeof vi.fn> };
          labels: { list: ReturnType<typeof vi.fn> };
        };
      };
    };
    internals.senderName = null;
    internals.gmail = {
      users: {
        drafts: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'draft_1',
              message: {
                id: 'msg_1',
                threadId: 'thread_9',
                payload: {
                  headers: [
                    { name: 'In-Reply-To', value: '<orig@mail.example.com>' },
                    { name: 'References', value: '<root@mail.example.com> <orig@mail.example.com>' },
                  ],
                },
              },
            },
          }),
          update,
          list: vi.fn().mockResolvedValue({
            data: { drafts: [{ id: 'draft_1', message: { id: 'msg_2' } }] },
          }),
        },
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg_2',
              threadId: 'thread_9',
              labelIds: ['DRAFT'],
              internalDate: '1751976000000',
              payload: { headers: [{ name: 'Subject', value: 'Updated' }] },
            },
          }),
        },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
      },
    };

    await provider.updateDraft('draft_1', {
      to: [{ email: 'ann@example.com' }],
      subject: 'Updated',
      body: { text: 'new body' },
    });

    expect(internals.gmail.users.drafts.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'draft_1',
      format: 'metadata',
    });
    const request = update.mock.calls[0]?.[0];
    expect(request.requestBody.message.threadId).toBe('thread_9');
    const raw = Buffer.from(request.requestBody.message.raw, 'base64url').toString();
    expect(raw).toContain('In-Reply-To: <orig@mail.example.com>');
    expect(raw).toContain('References: <root@mail.example.com> <orig@mail.example.com>');
  });
});

describe('GmailProvider external body data', () => {
  it('hydrates a text body returned through an attachment id', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const getAttachment = vi.fn().mockResolvedValue({
      data: { data: Buffer.from('large message body').toString('base64url') },
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          messages: {
            get: () => Promise<{ data: object }>;
            attachments: { get: typeof getAttachment };
          };
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
        };
      };
    };
    internals.gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg_1',
              threadId: 'thread_1',
              internalDate: '1751976000000',
              payload: {
                headers: [{ name: 'Subject', value: 'Large body' }],
                mimeType: 'text/plain',
                body: { attachmentId: 'body-attachment-1', size: 50_000 },
              },
            },
          }),
          attachments: { get: getAttachment },
        },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
      },
    };

    await expect(provider.getMessage('msg_1')).resolves.toMatchObject({
      body: { text: 'large message body' },
    });
    expect(getAttachment).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'msg_1',
      id: 'body-attachment-1',
    });
  });
});

describe('GmailProvider attachment limits', () => {
  it('rejects oversized attachment metadata before downloading content', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const download = vi.fn();
    const internals = provider as unknown as {
      gmail: {
        users: {
          messages: {
            get: ReturnType<typeof vi.fn>;
            attachments: { get: typeof download };
          };
        };
      };
    };
    internals.gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              payload: {
                parts: [
                  {
                    partId: '1',
                    filename: 'large.bin',
                    mimeType: 'application/octet-stream',
                    body: { attachmentId: 'a1', size: 11 },
                  },
                ],
              },
            },
          }),
          attachments: { get: download },
        },
      },
    };

    await expect(provider.getAttachment('m1', 'part:1', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'invalid_request',
      data: { sizeBytes: 11, maxBytes: 10 },
    });
    expect(download).not.toHaveBeenCalled();
  });

  it('resolves a stable MIME part id to Gmail current opaque attachment id', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const download = vi.fn().mockResolvedValue({
      data: { data: Buffer.from('current attachment').toString('base64url') },
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          messages: {
            get: ReturnType<typeof vi.fn>;
            attachments: { get: typeof download };
          };
        };
      };
    };
    internals.gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              payload: {
                parts: [
                  {
                    partId: '2',
                    filename: 'report.pdf',
                    mimeType: 'application/pdf',
                    body: { attachmentId: 'fresh-opaque-id', size: 18 },
                  },
                ],
              },
            },
          }),
          attachments: { get: download },
        },
      },
    };

    await expect(provider.getAttachment('m1', 'part:2')).resolves.toMatchObject({
      meta: { id: 'part:2', filename: 'report.pdf' },
      content: Buffer.from('current attachment'),
    });
    expect(download).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'm1',
      id: 'fresh-opaque-id',
    });
  });
});

describe('GmailProvider draft ids', () => {
  it('maps a draft message id to the id required by draft operations', async () => {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
    });
    const internals = provider as unknown as {
      gmail: {
        users: {
          messages: { get: () => Promise<{ data: object }> };
          labels: { list: () => Promise<{ data: { labels: never[] } }> };
          drafts: { list: () => Promise<{ data: { drafts: object[] } }> };
        };
      };
    };
    internals.gmail = {
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg_1',
              threadId: 'thread_1',
              labelIds: ['DRAFT'],
              internalDate: '1751976000000',
              payload: { headers: [{ name: 'Subject', value: 'Saved draft' }] },
            },
          }),
        },
        labels: { list: vi.fn().mockResolvedValue({ data: { labels: [] } }) },
        drafts: {
          list: vi.fn().mockResolvedValue({
            data: { drafts: [{ id: 'draft_1', message: { id: 'msg_1', threadId: 'thread_1' } }] },
          }),
        },
      },
    };

    await expect(provider.getMessage('msg_1')).resolves.toMatchObject({
      id: 'msg_1',
      draftId: 'draft_1',
      flags: { draft: true },
    });
  });
});
