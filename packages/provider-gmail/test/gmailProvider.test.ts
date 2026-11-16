import { FolderNameError } from '@fluxmail/core';
import { OAuth2Client } from 'googleapis-common';
import { describe, expect, it, vi } from 'vitest';
import { READ_ATTEMPT_TIMEOUT_MS } from '../src/errors.js';
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
  senderName: GmailProvider['senderName'];
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

  it('sends a stalled message fetch again instead of waiting for the search deadline', async () => {
    vi.useFakeTimers();
    try {
      let stalled = false;
      const getMessage = vi.fn().mockImplementation(({ id }: { id: string }, { signal }: { signal: AbortSignal }) => {
        if (id === 'live' && !stalled) {
          stalled = true;
          // Never answers, like a request on a dead keep-alive connection, until the attempt is aborted.
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        return Promise.resolve({
          data: {
            id,
            threadId: 'thread_1',
            internalDate: '1751976000000',
            payload: { headers: [{ name: 'Subject', value: `Message ${id}` }] },
          },
        });
      });
      const provider = providerWithMessages(getMessage);
      const search = new AbortController();

      const result = provider.listMessages({}, { signal: search.signal });
      await vi.advanceTimersByTimeAsync(READ_ATTEMPT_TIMEOUT_MS + 1_000);

      await expect(result).resolves.toMatchObject({
        items: [{ id: 'live', subject: 'Message live' }, { id: 'deleted' }],
      });
      expect(getMessage.mock.calls.filter(([params]) => params.id === 'live')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ format: 'full' }), expect.anything());
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
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 100 }), expect.anything());
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
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ format: 'full' }), expect.anything());
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

  describe('reported for a preview', () => {
    const sendAs = [
      { sendAsEmail: 'me@example.com', isPrimary: true, displayName: 'Gmail Name' },
      { sendAsEmail: 'sales@example.com', displayName: 'Sales', verificationStatus: 'accepted' },
      { sendAsEmail: 'support@example.com', verificationStatus: 'accepted' },
    ];

    it('reports the default sender name a send uses, reusing the cached identities', async () => {
      const auth = new OAuth2Client();
      const request = vi.spyOn(auth, 'request');
      const provider = providerWith(auth, sendAs, 'Stored Name');

      await expect(provider.senderName()).resolves.toBe('Gmail Name');
      await expect(provider.senderName('ME@example.com')).resolves.toBe('Gmail Name');
      expect(provider.gmail.users.settings.sendAs.list).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
    });

    it('reports the name of an explicit send-as identity, and none when it has no name', async () => {
      const provider = providerWith(new OAuth2Client(), sendAs, 'Stored Name');

      await expect(provider.senderName('Sales@example.com')).resolves.toBe('Sales');
      await expect(provider.senderName('support@example.com')).resolves.toBeUndefined();
    });

    it('reports no name when Gmail, the profile and the account have none', async () => {
      const auth = new OAuth2Client();
      vi.spyOn(auth, 'request').mockResolvedValue({ data: {} } as never);
      const provider = providerWith(auth, [{ isPrimary: true }]);

      await expect(provider.senderName()).resolves.toBeUndefined();
    });

    it('rejects when the sender is unknown or its lookup fails, so the caller shows no name', async () => {
      const provider = providerWith(new OAuth2Client(), sendAs);
      await expect(provider.senderName('stranger@example.com')).rejects.toMatchObject({ code: 'invalid_request' });

      const failing = providerWith(new OAuth2Client(), sendAs);
      (failing.gmail.users.settings.sendAs.list as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('bad request'), { code: 400 }),
      );
      await expect(failing.senderName('sales@example.com')).rejects.toBeDefined();
    });

    it('reports no name while a failed lookup leaves the default name unsettled', async () => {
      const auth = new OAuth2Client();
      vi.spyOn(auth, 'request').mockRejectedValue(new Error('userinfo unavailable'));
      const provider = providerWith(auth, [{ isPrimary: true, displayName: 'Gmail Name' }], 'Stored Name');
      const sendAsList = provider.gmail.users.settings.sendAs.list as ReturnType<typeof vi.fn>;
      sendAsList.mockRejectedValueOnce(Object.assign(new Error('bad request'), { code: 400 }));

      // A send right now would fall back to the stored name, but the next one would find Gmail's.
      await expect(provider.senderName()).resolves.toBeUndefined();
      await expect(provider.senderName()).resolves.toBe('Gmail Name');
    });

    it('does not pin the profile name when the send-as lookup failed', async () => {
      const auth = new OAuth2Client();
      vi.spyOn(auth, 'request').mockResolvedValue({ data: { name: 'Profile Name' } } as never);
      const provider = providerWith(auth, [{ isPrimary: true, displayName: 'Gmail Name' }]);
      const sendAsList = provider.gmail.users.settings.sendAs.list as ReturnType<typeof vi.fn>;
      sendAsList.mockRejectedValueOnce(Object.assign(new Error('bad request'), { code: 400 }));

      await expect(provider.resolveSenderName()).resolves.toBe('Profile Name');
      await expect(provider.senderName()).resolves.toBe('Gmail Name');
      await expect(provider.resolveSenderName()).resolves.toBe('Gmail Name');
    });
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

  it('trashes up to four messages at once and stops starting new ones after a failure', async () => {
    const { provider } = providerWithBatchModify();
    let active = 0;
    let peak = 0;
    const trash = vi.fn(async ({ id }: { id: string }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (id === 'm5') throw Object.assign(new Error('not found'), { code: 404 });
      return { data: {} };
    });
    (provider as unknown as { gmail: { users: { messages: { trash: typeof trash } } } }).gmail.users.messages.trash =
      trash;
    const ids = Array.from({ length: 12 }, (_, index) => `m${index}`);

    await provider.modify(ids.slice(0, 5), 'trash');
    expect(trash.mock.calls.map(([request]) => request.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(peak).toBe(4);

    trash.mockClear();
    await expect(provider.modify(ids, 'trash')).rejects.toBeDefined();
    expect(active).toBe(0);
    expect(trash.mock.calls.length).toBeLessThan(ids.length);
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

  it('finds an accented label in either Unicode form instead of creating another', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    const create = vi.fn();
    // A label created on a Mac can store "é" as "e" followed by a combining accent.
    (provider as unknown as { gmail: { users: { labels: unknown } } }).gmail.users.labels = {
      list: vi.fn().mockResolvedValue({
        data: { labels: [{ id: 'Label_7', name: 'Réunions'.normalize('NFD'), type: 'user' }] },
      }),
      create,
    };

    await provider.modify(['m1'], { addLabels: ['réunions'] });

    expect(create).not.toHaveBeenCalled();
    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], addLabelIds: ['Label_7'] },
    });
  });

  it('keeps the exact label when both Unicode forms exist as separate labels', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    const decomposed = 'Réunions'.normalize('NFD');
    (provider as unknown as { gmail: { users: { labels: unknown } } }).gmail.users.labels = {
      list: vi.fn().mockResolvedValue({
        data: {
          labels: [
            { id: 'Label_1', name: 'Réunions', type: 'user' },
            { id: 'Label_2', name: decomposed, type: 'user' },
          ],
        },
      }),
      create: vi.fn(),
    };

    await provider.modify(['m1'], { addLabels: [decomposed] });

    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], addLabelIds: ['Label_2'] },
    });
  });

  it('changes both labels when both Unicode forms exist and both are requested', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    const decomposed = 'Réunions'.normalize('NFD');
    (provider as unknown as { gmail: { users: { labels: unknown } } }).gmail.users.labels = {
      list: vi.fn().mockResolvedValue({
        data: {
          labels: [
            { id: 'Label_1', name: 'Réunions', type: 'user' },
            { id: 'Label_2', name: decomposed, type: 'user' },
          ],
        },
      }),
      create: vi.fn(),
    };

    await provider.modify(['m1'], { addLabels: ['Réunions', decomposed] });
    await provider.modify(['m1'], { removeLabels: [decomposed, 'Réunions'] });

    expect(batchModify).toHaveBeenNthCalledWith(1, {
      userId: 'me',
      requestBody: { ids: ['m1'], addLabelIds: ['Label_1', 'Label_2'] },
    });
    expect(batchModify).toHaveBeenNthCalledWith(2, {
      userId: 'me',
      requestBody: { ids: ['m1'], removeLabelIds: ['Label_2', 'Label_1'] },
    });
  });

  it('creates one label when a new name arrives in both Unicode forms', async () => {
    const { provider, batchModify } = providerWithBatchModify();
    const create = vi.fn().mockResolvedValue({ data: { id: 'Label_9', name: 'Clé' } });
    (provider as unknown as { gmail: { users: { labels: unknown } } }).gmail.users.labels = {
      list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
      create,
    };

    await provider.modify(['m1'], { addLabels: ['Clé', 'Clé'.normalize('NFD'), 'CLÉ'] });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: expect.objectContaining({ name: 'Clé' }) }),
    );
    expect(batchModify).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { ids: ['m1'], addLabelIds: ['Label_9'] },
    });
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
      cachedSenderName: string | null;
      gmail: { users: { messages: { send: typeof send } } };
    };
    internals.cachedSenderName = null;
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
      cachedSenderName: string | null;
      gmail: { users: { drafts: { create: typeof create } } };
    };
    internals.cachedSenderName = null;
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
      cachedSenderName: string | null;
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
    internals.cachedSenderName = null;
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

describe('GmailProvider transport hooks', () => {
  function hookedProvider(options: {
    sendRawMessage?: ConstructorParameters<typeof GmailProvider>[0]['sendRawMessage'];
    getAttachmentContent?: ConstructorParameters<typeof GmailProvider>[0]['getAttachmentContent'];
  }) {
    const provider = new GmailProvider({
      accountId: 'acct_1',
      email: 'me@example.com',
      auth: new OAuth2Client(),
      ...options,
    });
    const send = vi.fn();
    const download = vi.fn();
    const internals = provider as unknown as {
      cachedSenderName: string | null;
      gmail: { users: { messages: Record<string, unknown> } };
    };
    internals.cachedSenderName = null;
    internals.gmail = {
      users: {
        messages: {
          send,
          get: vi.fn().mockResolvedValue({
            data: {
              payload: {
                parts: [
                  {
                    partId: '2',
                    filename: 'report.pdf',
                    mimeType: 'application/pdf',
                    body: { attachmentId: 'opaque-id', size: 18 },
                  },
                ],
              },
            },
          }),
          attachments: { get: download },
        },
      },
    };
    return { provider, send, download };
  }

  it('streams a new message through sendRawMessage', async () => {
    let raw = '';
    const sendRawMessage = vi.fn(async (message: import('node:stream').Readable) => {
      for await (const chunk of message) raw += Buffer.from(chunk).toString();
      return { id: 'sent_1', threadId: 'thread_1' };
    });
    const { provider, send } = hookedProvider({ sendRawMessage });

    await expect(
      provider.send({
        to: [{ email: 'bob@example.com' }],
        subject: 'Hi',
        body: { text: 'hello' },
        attachments: [
          { filename: 'a.txt', mimeType: 'text/plain', content: Buffer.from('attached').toString('base64') },
        ],
      }),
    ).resolves.toEqual({ id: 'sent_1', threadId: 'thread_1' });
    expect(send).not.toHaveBeenCalled();
    expect(sendRawMessage).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(raw).toContain('Subject: Hi');
    expect(raw).toContain(Buffer.from('attached').toString('base64'));
  });

  it('downloads attachment content through getAttachmentContent', async () => {
    const getAttachmentContent = vi.fn().mockResolvedValue(Buffer.from('streamed'));
    const { provider, download } = hookedProvider({ getAttachmentContent });

    await expect(provider.getAttachment('m1', 'part:2', { maxBytes: 100 })).resolves.toMatchObject({
      content: Buffer.from('streamed'),
    });
    expect(getAttachmentContent).toHaveBeenCalledWith('m1', 'opaque-id', 100);
    expect(download).not.toHaveBeenCalled();
  });

  it('rejects hooked content above maxBytes', async () => {
    const { provider } = hookedProvider({ getAttachmentContent: vi.fn().mockResolvedValue(Buffer.alloc(20)) });
    await expect(provider.getAttachment('m1', 'part:2', { maxBytes: 19 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('GmailProvider folder creation', () => {
  function providerWithLabels(initial: Array<{ id: string; name: string; type: string }>) {
    const labels = [...initial];
    let next = 1;
    const list = vi.fn(async () => ({ data: { labels: [...labels] } }));
    const create = vi.fn(async ({ requestBody }: { requestBody: { name: string } }) => {
      const label = { id: `Label_${next++}`, name: requestBody.name, type: 'user' };
      labels.push(label);
      return { data: label };
    });
    const provider = new GmailProvider({ accountId: 'acct_1', email: 'me@example.com', auth: new OAuth2Client() });
    (provider as unknown as { gmail: { users: { labels: unknown } } }).gmail = {
      users: { labels: { list, create } },
    } as never;
    return { provider, list, create, labels };
  }

  const system = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' },
    { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
  ];

  it('creates a label and returns it as a folder', async () => {
    const { provider, create } = providerWithLabels(system);

    await expect(provider.createFolder(' Receipts ')).resolves.toEqual({ id: 'Label_1', name: 'Receipts' });
    expect(create).toHaveBeenCalledExactlyOnceWith({ userId: 'me', requestBody: { name: 'Receipts' } });
    await expect(provider.listFolders()).resolves.toContainEqual({ id: 'Label_1', name: 'Receipts' });
  });

  it('creates a nested label under the parent as Gmail spells it', async () => {
    const { provider, create } = providerWithLabels([...system, { id: 'Label_p', name: 'Projects', type: 'user' }]);

    await expect(provider.createFolder('projects / 2026')).resolves.toEqual({ id: 'Label_1', name: 'Projects/2026' });
    expect(create).toHaveBeenCalledExactlyOnceWith({ userId: 'me', requestBody: { name: 'Projects/2026' } });
  });

  it('creates missing parent labels so Gmail nests the new one', async () => {
    const { provider, create } = providerWithLabels([...system, { id: 'Label_p', name: 'Projects', type: 'user' }]);

    await expect(provider.createFolder('Projects/2026/Q1')).resolves.toEqual({
      id: 'Label_2',
      name: 'Projects/2026/Q1',
    });
    expect(create.mock.calls.map(([request]) => request.requestBody.name)).toEqual([
      'Projects/2026',
      'Projects/2026/Q1',
    ]);
  });

  it('returns an existing label in any case without creating it', async () => {
    const { provider, create } = providerWithLabels([...system, { id: 'Label_r', name: 'Receipts', type: 'user' }]);

    await expect(provider.createFolder('RECEIPTS')).resolves.toEqual({ id: 'Label_r', name: 'Receipts' });
    expect(create).not.toHaveBeenCalled();
  });

  it('reads the labels again instead of trusting the cache', async () => {
    const { provider, list, labels } = providerWithLabels(system);
    await provider.createFolder('Receipts');
    // Another client deletes the label within the cache lifetime.
    labels.splice(
      labels.findIndex((label) => label.name === 'Receipts'),
      1,
    );

    await expect(provider.createFolder('Receipts')).resolves.toEqual({ id: 'Label_2', name: 'Receipts' });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('returns the label when Gmail reports the name was taken in the meantime', async () => {
    const { provider, create, labels } = providerWithLabels(system);
    create.mockImplementationOnce(async () => {
      labels.push({ id: 'Label_x', name: 'Receipts', type: 'user' });
      throw { response: { status: 409, data: { error: { message: 'Label name exists or conflicts' } } } };
    });

    await expect(provider.createFolder('Receipts')).resolves.toEqual({ id: 'Label_x', name: 'Receipts' });
  });

  it('rejects a name Gmail reserves', async () => {
    const { provider, create } = providerWithLabels(system);
    create.mockRejectedValueOnce({
      response: { status: 409, data: { error: { message: 'Label name exists or conflicts' } } },
    });

    await expect(provider.createFolder('Chats')).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('reserved or conflicts'),
    });
  });

  it.each(['inbox', 'Draft', 'Important', 'category_social', 'Archive', 'All'])(
    'rejects the system name %s',
    async (name) => {
      const { provider, create } = providerWithLabels(system);

      await expect(provider.createFolder(name)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing parent with a system name', async () => {
    const { provider, create } = providerWithLabels(system);

    await expect(provider.createFolder('Archive/2025')).rejects.toMatchObject({
      code: 'invalid_request',
      message: '"Archive" is a system folder. Choose another name.',
    });
    await expect(provider.createFolder('Inbox/Receipts')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['Projects/', 'Projects//2026', '/Projects'])('rejects the empty level in %j', async (name) => {
    const { provider, create } = providerWithLabels(system);

    await expect(provider.createFolder(name)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a name Gmail refuses without its response text', async () => {
    const { provider, create } = providerWithLabels(system);
    create.mockRejectedValueOnce({ response: { status: 400, data: { error: { message: 'private reason' } } } });

    const error = await provider.createFolder('Bad').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FolderNameError);
    expect(error).toMatchObject({
      code: 'invalid_request',
      message: `Gmail would not create the label "Bad". The name may use characters or a length Gmail doesn't allow.`,
      failure: { provider: 'gmail', httpStatus: 400 },
    });
  });

  it('passes other Gmail failures through', async () => {
    const { provider, create } = providerWithLabels(system);
    create.mockRejectedValue({ response: { status: 500, data: { error: { message: 'Backend error' } } } });

    await expect(provider.createFolder('Receipts')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(create).toHaveBeenCalledTimes(4);
  });
});
