import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliProgram, runCli } from '../src/cli.js';
import { cliExitCode } from '../src/cliOutput.js';
import { saveRemoteInstance, saveSessionToken } from '../src/cliInstances.js';

interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: unknown;
}

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200): Response {
  return new Response(JSON.stringify({ data, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setupRemote(
  responder: (request: RecordedRequest) => Response | Promise<Response> = (request) =>
    request.url.pathname.endsWith('/messages/actions')
      ? envelope({ action: 'markRead', succeededIds: ['msg_1'], failed: [], uncertainIds: [] })
      : request.url.pathname.endsWith('/send') || request.url.pathname.endsWith('/forward')
        ? envelope({
            operationId: 'dop_1',
            accountId: 'acct_1',
            kind: 'send',
            status: 'succeeded',
            result: { id: 'sent_1', threadId: 'thread_1' },
          })
        : envelope({ ok: true }),
  accounts: Array<{
    id: string;
    email: string;
    provider: string;
    ownerMemberId: string;
    sharedWithAll: boolean;
    grantedMemberIds: string[];
  }> = [
    {
      id: 'acct_1',
      email: 'one@example.com',
      provider: 'gmail',
      ownerMemberId: 'member_1',
      sharedWithAll: false,
      grantedMemberIds: [],
    },
    {
      id: 'acct_2',
      email: 'two@example.com',
      provider: 'outlook',
      ownerMemberId: 'member_1',
      sharedWithAll: false,
      grantedMemberIds: [],
    },
  ],
): { dataDir: string; requests: RecordedRequest[] } {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fluxmail-cli-mail-'));
  vi.stubEnv('FLUXMAIL_DATA_DIR', dataDir);
  saveRemoteInstance('work', 'https://mail.example.com');
  saveSessionToken('work', 'fms_private_session');
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const recorded: RecordedRequest = {
        url: new URL(String(input)),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      };
      requests.push(recorded);
      if (recorded.url.pathname === '/api/v1/accounts') {
        return envelope(accounts);
      }
      if (recorded.url.pathname === '/api/v1/me') return envelope({ id: 'member_1' });
      return responder(recorded);
    }),
  );
  return { dataDir, requests };
}

async function run(
  args: string[],
  telemetry?: { capture: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> },
) {
  await createCliProgram(telemetry ? { telemetry } : {}).parseAsync([
    'node',
    'fluxmail',
    '--instance',
    'work',
    '--mail-account',
    'acct_1',
    ...args,
  ]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('CLI email commands', () => {
  it('assigns stable exit categories', () => {
    expect(cliExitCode('invalid_request')).toBe(2);
    expect(cliExitCode('not_found')).toBe(2);
    expect(cliExitCode('uncertain')).toBe(3);
    expect(cliExitCode('permission_denied')).toBe(4);
    expect(cliExitCode('rate_limited')).toBe(5);
    expect(cliExitCode('internal')).toBe(1);
  });

  it('reports an invalid root format as a structured input error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runCli(['node', 'fluxmail', '--format', 'bad', 'status']);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('keeps partial bulk outcomes in JSON and exits with category 3', async () => {
    setupRemote(() =>
      envelope({
        action: 'markRead',
        succeededIds: ['m1'],
        failed: [{ messageId: 'm2', code: 'not_found' }],
        uncertainIds: ['m3'],
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['emails', 'modify', 'mark-read', 'm1', 'm2', 'm3']);
    expect(process.exitCode).toBe(3);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      data: { succeededIds: ['m1'], failed: [{ messageId: 'm2', code: 'not_found' }], uncertainIds: ['m3'] },
    });
  });

  it('wraps management output in the selected scripting format', async () => {
    setupRemote();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createCliProgram().parseAsync(['node', 'fluxmail', 'instances', 'list']);
    const json = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(json.data).toEqual(expect.arrayContaining([expect.stringContaining('NAME')]));
    log.mockClear();
    await createCliProgram().parseAsync(['node', 'fluxmail', '--format', 'ndjson', 'instances', 'list']);
    expect(log.mock.calls.every(([line]) => JSON.parse(String(line)).type === 'item')).toBe(true);
  });

  it('lists messages through REST and preserves pagination metadata and warnings', async () => {
    const { requests } = setupRemote(() =>
      envelope([{ id: 'private-message' }], { meta: { nextPageToken: 'private-next' }, warnings: ['renew soon'] }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['emails', 'list', '--folder', 'inbox', '--read', 'false', '--page-size', '10']);

    const request = requests.at(-1)!;
    expect(request.url.pathname).toBe('/api/v1/accounts/acct_1/messages');
    expect(request.url.searchParams.get('folder')).toBe('inbox');
    expect(request.url.searchParams.get('read')).toBe('false');
    expect(request.url.searchParams.get('pageSize')).toBe('10');
    expect(request.headers.get('authorization')).toBe('Bearer fms_private_session');
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      data: [{ id: 'private-message' }],
      meta: { nextPageToken: 'private-next' },
      warnings: ['renew soon'],
    });
  });

  it('follows listing pages up to the selected ceiling', async () => {
    const { requests } = setupRemote((request) =>
      request.url.searchParams.has('pageToken')
        ? envelope([{ id: 'm3' }], { meta: { exhausted: true } })
        : envelope([{ id: 'm1' }, { id: 'm2' }], { meta: { nextPageToken: 'next-1', exhausted: false } }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['emails', 'list', '--all', '--max-results', '3', '--page-size', '2']);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.searchParams.get('pageToken')).toBe('next-1');
    expect(requests[1]?.url.searchParams.get('pageSize')).toBe('1');
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    });
  });

  it('retries a listing page after a provider timeout without losing earlier pages', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let failures = 2;
    const { requests } = setupRemote((request) => {
      if (!request.url.searchParams.has('pageToken')) {
        return envelope([{ id: 'm1' }], { meta: { nextPageToken: 'next-1', exhausted: false } });
      }
      if (failures-- > 0) {
        return envelope(undefined, { error: { code: 'provider_unavailable', message: 'deadline' } }, 503);
      }
      return envelope([{ id: 'm2' }], { meta: { exhausted: true } });
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const listing = run(['emails', 'list', '--all']);
      await vi.runAllTimersAsync();
      await listing;
    } finally {
      vi.useRealTimers();
    }

    expect(requests.map((request) => request.url.searchParams.get('pageToken'))).toEqual([
      null,
      'next-1',
      'next-1',
      'next-1',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ data: [{ id: 'm1' }, { id: 'm2' }] });
  });

  it('stops retrying a listing page after three attempts or a non-transient error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let code = 'provider_unavailable';
    const { requests } = setupRemote(() =>
      envelope(undefined, { error: { code, message: 'failed' } }, code === 'invalid_request' ? 400 : 503),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const timedOut = run(['emails', 'list', '--all']);
      await vi.runAllTimersAsync();
      await timedOut;
      expect(requests).toHaveLength(3);
      expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toMatchObject({
        error: { code: 'provider_unavailable' },
      });

      requests.length = 0;
      code = 'invalid_request';
      const rejected = run(['emails', 'list', '--all']);
      await vi.runAllTimersAsync();
      await rejected;
      expect(requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards every list and search filter with REST parameter names', async () => {
    const { requests } = setupRemote();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const filters = [
      '--folder',
      'Projects & Reports',
      '--from',
      'ann+filter@example.com',
      '--to',
      'team@example.com',
      '--subject',
      'Quarterly & annual',
      '--read',
      'false',
      '--starred',
      'true',
      '--has-attachment',
      'true',
      '--after',
      '2026-01-02',
      '--before',
      '2026-07-18',
      '--raw-provider-query',
      'has:yellow-star',
      '--page-size',
      '73',
      '--page-token',
      'opaque+/=token',
    ];
    await run(['emails', 'list', '--text', 'customer invoice', ...filters]);
    await run(['emails', 'search', 'exact search text', ...filters.slice(0, 18), ...filters.slice(20)]);

    const [listed, searched] = requests.filter((request) => request.url.pathname.endsWith('/messages'));
    expect(Object.fromEntries(listed!.url.searchParams)).toEqual({
      folder: 'Projects & Reports',
      text: 'customer invoice',
      from: 'ann+filter@example.com',
      to: 'team@example.com',
      subject: 'Quarterly & annual',
      after: '2026-01-02',
      before: '2026-07-18',
      rawProviderQuery: 'has:yellow-star',
      pageSize: '73',
      pageToken: 'opaque+/=token',
      read: 'false',
      starred: 'true',
      hasAttachment: 'true',
    });
    expect(Object.fromEntries(searched!.url.searchParams)).toEqual({
      folder: 'Projects & Reports',
      from: 'ann+filter@example.com',
      to: 'team@example.com',
      subject: 'Quarterly & annual',
      after: '2026-01-02',
      before: '2026-07-18',
      pageSize: '73',
      pageToken: 'opaque+/=token',
      read: 'false',
      starred: 'true',
      hasAttachment: 'true',
      query: 'exact search text',
    });
  });

  it('prints typed search warnings to stderr while preserving the query for REST', async () => {
    const { requests } = setupRemote(() =>
      envelope([], {
        meta: {
          diagnostics: [
            {
              code: 'possible_operator_typo',
              severity: 'warning',
              message: 'Did you mean from:?',
              suggestion: 'from',
            },
          ],
        },
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await run(['emails', 'search', 'form:ann@example.com']);

    expect(error).toHaveBeenCalledWith('Search warning: Did you mean from:?');
    expect(requests.at(-1)?.url.searchParams.get('query')).toBe('form:ann@example.com');
  });

  it('accepts a typed query that begins with the negative attachment operator', async () => {
    const { requests } = setupRemote();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['emails', 'search', '-has:attachment quarterly']);

    expect(requests.at(-1)?.url.searchParams.get('query')).toBe('-has:attachment quarterly');
  });

  it('posts grouped searches and exits nonzero when one account fails', async () => {
    const { requests } = setupRemote((request) => {
      if (request.url.pathname !== '/api/v1/messages/search') return envelope([]);
      if ((request.body as { query?: string } | undefined)?.query === 'subject:complete') {
        return envelope([{ accountId: 'acct_1', data: [], meta: { exhausted: true } }], {
          meta: { exhausted: true },
        });
      }
      return envelope(
        [
          { accountId: 'acct_1', data: [], meta: { exhausted: true } },
          {
            accountId: 'acct_2',
            error: { code: 'provider_unavailable', message: 'Search timed out.', exhausted: false },
          },
        ],
        { meta: { exhausted: false } },
      );
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };

    await run(['emails', 'search-batch', 'subject:complete', '--account', 'acct_1'], telemetry);

    await run(
      [
        'emails',
        'search-batch',
        'subject:report',
        '--account',
        'acct_1',
        '--account',
        'acct_2',
        '--folder',
        'inbox',
        '--include-snippet',
        'true',
        '--include-search-context',
        'true',
      ],
      telemetry,
    );

    const request = requests.at(-1)!;
    expect(request.url.pathname).toBe('/api/v1/messages/search');
    expect(request.method).toBe('POST');
    expect(request.body).toEqual({
      accounts: [{ accountId: 'acct_1' }, { accountId: 'acct_2' }],
      query: 'subject:report',
      folder: 'inbox',
      includeSnippet: true,
      includeSearchContext: true,
    });
    expect(process.exitCode).toBe(3);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'cli',
        operation: 'emails search-batch',
        outcome: 'error',
        error_code: 'partial_failure',
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'cli',
        operation: 'emails search-batch',
        outcome: 'success',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('subject:report');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('subject:complete');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('acct_1');
  });

  it('resolves a global account selector by email', async () => {
    const { requests } = setupRemote();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createCliProgram().parseAsync([
      'node',
      'fluxmail',
      '--instance',
      'work',
      '--mail-account',
      'TWO@example.com',
      'folders',
      'list',
    ]);

    expect(requests.at(-1)?.url.pathname).toBe('/api/v1/accounts/acct_2/folders');
  });

  it('uses an explicit account ID without account discovery requests', async () => {
    const { requests } = setupRemote();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['drafts', 'create', '--body', 'draft']);

    expect(requests.map((request) => request.url.pathname)).toEqual(['/api/v1/accounts/acct_1/drafts']);
  });

  it('requires account selection when more than one account is accessible', async () => {
    setupRemote();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createCliProgram().parseAsync(['node', 'fluxmail', '--instance', 'work', 'labels', 'list']);

    expect(process.exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Multiple accounts are available'));
  });

  it('keeps API key mailbox scopes separate from the mail selector', async () => {
    const { requests } = setupRemote(() =>
      envelope({ id: 'key_1', name: 'Scoped key', permissionProfile: 'full', key: 'fmk_private' }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createCliProgram().parseAsync([
      'node',
      'fluxmail',
      '--instance',
      'work',
      'apikey',
      'create',
      '--name',
      'Scoped key',
      '--account',
      'acct_1',
    ]);

    const request = requests.at(-1)!;
    expect(request.url.pathname).toBe('/api/v1/me/api-keys');
    expect(request.body).toMatchObject({ accountIds: ['acct_1'] });
  });

  it('infers one accessible account and reports when none are available', async () => {
    const one = setupRemote(undefined, [
      {
        id: 'acct_only',
        email: 'only@example.com',
        provider: 'imap',
        ownerMemberId: 'member_1',
        sharedWithAll: false,
        grantedMemberIds: [],
      },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createCliProgram().parseAsync(['node', 'fluxmail', '--instance', 'work', 'folders', 'list']);
    expect(one.requests.at(-1)?.url.pathname).toBe('/api/v1/accounts/acct_only/folders');

    vi.unstubAllGlobals();
    const empty = setupRemote(undefined, []);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createCliProgram().parseAsync(['node', 'fluxmail', '--instance', 'work', 'folders', 'list']);
    expect(process.exitCode).toBe(2);
    expect(empty.requests).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No email accounts are available'));
  });

  it('does not infer an administrator-visible private mailbox', async () => {
    const { requests } = setupRemote(undefined, [
      {
        id: 'acct_owned',
        email: 'owned@example.com',
        provider: 'gmail',
        ownerMemberId: 'member_1',
        sharedWithAll: false,
        grantedMemberIds: [],
      },
      {
        id: 'acct_private',
        email: 'private@example.com',
        provider: 'outlook',
        ownerMemberId: 'member_2',
        sharedWithAll: false,
        grantedMemberIds: [],
      },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createCliProgram().parseAsync(['node', 'fluxmail', '--instance', 'work', 'folders', 'list']);

    expect(requests.at(-1)?.url.pathname).toBe('/api/v1/accounts/acct_owned/folders');
  });

  it('builds a send request with addresses, files, MIME types, scheduling, and idempotency', async () => {
    const { dataDir, requests } = setupRemote();
    const bodyPath = path.join(dataDir, 'body.txt');
    const attachmentPath = path.join(dataDir, 'report.txt');
    writeFileSync(bodyPath, 'Hello from a file');
    writeFileSync(attachmentPath, 'private attachment');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await run([
      'emails',
      'send',
      '--from',
      'sales@example.com',
      '--to',
      'Ann <ann@example.com>',
      '--subject',
      'Status',
      '--body-file',
      bodyPath,
      '--attach',
      attachmentPath,
      '--send-at',
      '2026-08-01T12:00:00Z',
      '--idempotency-key',
      'scheduled-send-key',
    ]);

    const request = requests.at(-1)!;
    expect(request.url.pathname).toBe('/api/v1/accounts/acct_1/send');
    expect(request.method).toBe('POST');
    expect(request.headers.get('idempotency-key')).toBe('scheduled-send-key');
    expect(request.body).toMatchObject({
      from: 'sales@example.com',
      to: [{ name: 'Ann', email: 'ann@example.com' }],
      subject: 'Status',
      body: { text: 'Hello from a file' },
      sendAt: '2026-08-01T12:00:00Z',
      attachments: [
        {
          filename: 'report.txt',
          mimeType: 'text/plain',
          content: Buffer.from('private attachment').toString('base64'),
        },
      ],
    });
  });

  it('builds HTML replies with all recipient fields and an unknown MIME fallback', async () => {
    const { dataDir, requests } = setupRemote();
    const htmlPath = path.join(dataDir, 'body.html');
    const attachmentPath = path.join(dataDir, 'payload.unknown-fluxmail-extension');
    writeFileSync(htmlPath, '<p>Private reply</p>');
    writeFileSync(attachmentPath, 'opaque bytes');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await run([
      'drafts',
      'create',
      '--from',
      'support@example.com',
      '--to',
      'Ann <ann@example.com>',
      '--cc',
      'copy@example.com',
      '--bcc',
      'blind@example.com',
      '--subject',
      'Reply subject',
      '--html-file',
      htmlPath,
      '--reply-to',
      'msg/private',
      '--reply-all',
      '--attach',
      attachmentPath,
    ]);

    expect(requests.at(-1)?.body).toEqual({
      from: 'support@example.com',
      to: [{ name: 'Ann', email: 'ann@example.com' }],
      cc: [{ email: 'copy@example.com' }],
      bcc: [{ email: 'blind@example.com' }],
      subject: 'Reply subject',
      body: { html: '<p>Private reply</p>' },
      attachments: [
        {
          filename: 'payload.unknown-fluxmail-extension',
          mimeType: 'application/octet-stream',
          content: Buffer.from('opaque bytes').toString('base64'),
        },
      ],
      replyToMessageId: 'msg/private',
      replyAll: true,
    });
  });

  it('builds forwarding options and preserves an explicit idempotency key', async () => {
    const { requests } = setupRemote();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await run([
      'emails',
      'forward',
      'msg/with space',
      '--from',
      'billing@example.com',
      '--to',
      'ann@example.com',
      '--cc',
      'copy@example.com',
      '--comment',
      'Private comment',
      '--no-attachments',
      '--idempotency-key',
      'forward-retry-key',
    ]);

    const request = requests.at(-1)!;
    expect(request.url.pathname).toBe('/api/v1/accounts/acct_1/messages/msg%2Fwith%20space/forward');
    expect(request.headers.get('idempotency-key')).toBe('forward-retry-key');
    expect(request.body).toEqual({
      from: 'billing@example.com',
      to: [{ email: 'ann@example.com' }],
      cc: [{ email: 'copy@example.com' }],
      comment: 'Private comment',
      includeAttachments: false,
    });
  });

  it('supports exact JSON bodies and rejects conflicts with body flags', async () => {
    const { dataDir, requests } = setupRemote();
    const inputPath = path.join(dataDir, 'send.json');
    writeFileSync(inputPath, JSON.stringify({ draftId: 'draft_1' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await run(['emails', 'send', '--input', inputPath, '--idempotency-key', 'explicit-key']);
    expect(requests.at(-1)).toMatchObject({
      body: { draftId: 'draft_1' },
    });
    expect(requests.at(-1)?.headers.get('idempotency-key')).toBe('explicit-key');

    const requestCount = requests.length;
    await run(['emails', 'send', '--input', inputPath, '--subject', 'conflict']);
    expect(process.exitCode).toBe(2);
    expect(requests).toHaveLength(requestCount);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--input cannot be combined'));

    await run(['emails', 'send', '--draft', 'draft_1', '--from', 'sales@example.com']);
    expect(process.exitCode).toBe(2);
    expect(requests).toHaveLength(requestCount);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--draft cannot be combined'));
  });

  it('maps every modification action and its action-specific options', async () => {
    const { requests } = setupRemote();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const actions = [
      ['mark-read', 'markRead'],
      ['mark-unread', 'markUnread'],
      ['star', 'star'],
      ['unstar', 'unstar'],
      ['archive', 'archive'],
      ['trash', 'trash'],
      ['untrash', 'untrash'],
      ['delete', 'delete'],
    ] as const;

    for (const [cliAction, restAction] of actions) {
      await run(['emails', 'modify', cliAction, 'msg_1', 'msg_2']);
      expect(requests.at(-1)?.body).toEqual({ messageIds: ['msg_1', 'msg_2'], action: restAction });
    }
    await run(['emails', 'modify', 'move', 'msg_1', '--folder', 'Projects']);
    expect(requests.at(-1)?.body).toEqual({ messageIds: ['msg_1'], action: 'move', folder: 'Projects' });
    await run(['emails', 'modify', 'add-labels', 'msg_1', '--label', 'Customer', '--label', 'Blue']);
    expect(requests.at(-1)?.body).toEqual({
      messageIds: ['msg_1'],
      action: 'addLabels',
      labels: ['Customer', 'Blue'],
    });
    await run(['emails', 'modify', 'remove-labels', 'msg_1', '--label', 'Customer']);
    expect(requests.at(-1)?.body).toEqual({
      messageIds: ['msg_1'],
      action: 'removeLabels',
      labels: ['Customer'],
    });
  });

  it('accepts REST JSON for modifications and rejects invalid flag combinations before HTTP', async () => {
    const { dataDir, requests } = setupRemote();
    const inputPath = path.join(dataDir, 'modify.json');
    writeFileSync(inputPath, JSON.stringify({ messageIds: ['msg_1'], action: 'archive' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await run(['emails', 'modify', '--input', inputPath]);
    expect(requests.at(-1)?.body).toEqual({ messageIds: ['msg_1'], action: 'archive' });

    const requestCount = requests.length;
    await run(['emails', 'modify', 'archive', 'msg_1', '--input', inputPath]);
    expect(process.exitCode).toBe(2);
    expect(requests).toHaveLength(requestCount);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--input cannot be combined'));
  });

  it('rejects conflicting body sources and invalid addresses before HTTP', async () => {
    const { dataDir, requests } = setupRemote();
    const bodyPath = path.join(dataDir, 'body.txt');
    const htmlPath = path.join(dataDir, 'body.html');
    writeFileSync(bodyPath, 'file body');
    writeFileSync(htmlPath, '<p>file body</p>');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await run(['drafts', 'create', '--body', 'inline', '--body-file', bodyPath]);
    expect(process.exitCode).toBe(2);
    await run(['drafts', 'create', '--html', '<p>inline</p>', '--html-file', htmlPath]);
    expect(process.exitCode).toBe(2);
    await run(['drafts', 'create', '--to', 'not an address', '--body', 'test']);
    expect(process.exitCode).toBe(2);

    expect(requests).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--body and --body-file'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--html and --html-file'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not parse email address'));
  });

  it('covers every REST email operation with a resource command', async () => {
    const { dataDir, requests } = setupRemote((request) => {
      if (request.url.pathname.endsWith('/attachments/att_1')) {
        return new Response(Buffer.from('downloaded'), {
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': '10' },
        });
      }
      if (request.url.pathname.endsWith('/messages/actions')) {
        return envelope({ action: 'addLabels', succeededIds: ['msg_1'], failed: [], uncertainIds: [] });
      }
      return envelope({ ok: true });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const outputPath = path.join(dataDir, 'download.txt');
    const cases: Array<{ args: string[]; method: string; path: string }> = [
      { args: ['folders', 'list'], method: 'GET', path: '/api/v1/accounts/acct_1/folders' },
      { args: ['labels', 'list'], method: 'GET', path: '/api/v1/accounts/acct_1/labels' },
      { args: ['emails', 'list'], method: 'GET', path: '/api/v1/accounts/acct_1/messages' },
      {
        args: ['emails', 'search', 'quarterly report'],
        method: 'GET',
        path: '/api/v1/accounts/acct_1/messages',
      },
      { args: ['emails', 'get', 'msg_1'], method: 'GET', path: '/api/v1/accounts/acct_1/messages/msg_1' },
      { args: ['threads', 'get', 'thread_1'], method: 'GET', path: '/api/v1/accounts/acct_1/threads/thread_1' },
      {
        args: ['drafts', 'create', '--body', 'draft'],
        method: 'POST',
        path: '/api/v1/accounts/acct_1/drafts',
      },
      {
        args: ['drafts', 'update', 'draft_1', '--body', 'updated'],
        method: 'PUT',
        path: '/api/v1/accounts/acct_1/drafts/draft_1',
      },
      {
        args: ['drafts', 'delete', 'draft_1'],
        method: 'DELETE',
        path: '/api/v1/accounts/acct_1/drafts/draft_1',
      },
      {
        args: ['emails', 'send', '--draft', 'draft_1', '--idempotency-key', 'send-resource'],
        method: 'POST',
        path: '/api/v1/accounts/acct_1/send',
      },
      {
        args: ['emails', 'forward', 'msg_1', '--to', 'ann@example.com', '--idempotency-key', 'forward-resource'],
        method: 'POST',
        path: '/api/v1/accounts/acct_1/messages/msg_1/forward',
      },
      {
        args: ['emails', 'modify', 'add-labels', 'msg_1', '--label', 'Customer'],
        method: 'POST',
        path: '/api/v1/accounts/acct_1/messages/actions',
      },
      {
        args: ['scheduled', 'list'],
        method: 'GET',
        path: '/api/v1/accounts/acct_1/scheduled-sends',
      },
      {
        args: ['scheduled', 'cancel', 'schedule_1'],
        method: 'DELETE',
        path: '/api/v1/accounts/acct_1/scheduled-sends/schedule_1',
      },
      {
        args: ['attachments', 'download', 'msg_1', 'att_1', '--output', outputPath],
        method: 'GET',
        path: '/api/v1/accounts/acct_1/messages/msg_1/attachments/att_1',
      },
    ];

    for (const entry of cases) {
      await run(entry.args);
      const request = requests.at(-1)!;
      expect({ method: request.method, path: request.url.pathname }).toEqual({
        method: entry.method,
        path: entry.path,
      });
    }

    const searchRequest = requests.find((request) => request.url.searchParams.get('query') === 'quarterly report');
    expect(searchRequest).toBeTruthy();
    expect(readFileSync(outputPath, 'utf8')).toBe('downloaded');
  });

  it('refuses to overwrite an attachment unless force is supplied', async () => {
    const { dataDir, requests } = setupRemote(() => new Response('replacement'));
    const outputPath = path.join(dataDir, 'existing.txt');
    writeFileSync(outputPath, 'original');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await run(['attachments', 'download', 'msg_1', 'att_1', '--output', outputPath]);

    expect(process.exitCode).toBe(2);
    expect(readFileSync(outputPath, 'utf8')).toBe('original');
    expect(requests).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });

  it('overwrites attachments with force and retains response warnings', async () => {
    const { dataDir, requests } = setupRemote(
      () =>
        new Response('replacement', {
          headers: { 'content-type': 'application/x-fluxmail-test', 'fluxmail-warning': 'License renewal due.' },
        }),
    );
    const outputPath = path.join(dataDir, 'existing.txt');
    writeFileSync(outputPath, 'original');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['attachments', 'download', 'msg_1', 'att_1', '--output', outputPath, '--force']);

    expect(readFileSync(outputPath, 'utf8')).toBe('replacement');
    expect(requests.at(-1)?.url.pathname).toContain('/attachments/att_1');
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      data: {
        output: path.resolve(outputPath),
        mimeType: 'application/x-fluxmail-test',
        sizeBytes: 11,
      },
      warnings: ['License renewal due.'],
    });
  });

  it('preserves safe REST error codes in CLI output', async () => {
    setupRemote(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'rate_limited', message: 'Try later.', requestId: 'request-123' } }),
          {
            status: 429,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await run(['labels', 'list']);

    expect(process.exitCode).toBe(5);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: 'rate_limited', message: 'Try later.', requestId: 'request-123' },
    });
  });

  it('preserves standard REST error codes for attachment downloads', async () => {
    const { dataDir } = setupRemote(
      () =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Attachment missing.' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await run(['attachments', 'download', 'msg_1', 'att_1', '--output', path.join(dataDir, 'missing.txt')]);

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: 'not_found', message: 'Attachment missing.' },
    });
  });

  it('records safe success and REST error telemetry without private input', async () => {
    const privateQuery = 'customer-secret-query';
    const { requests } = setupRemote((request) => {
      if (request.url.searchParams.get('query') === privateQuery) {
        return new Response(
          JSON.stringify({ error: { code: `private-${privateQuery}`, message: 'private provider response' } }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }
      return envelope([]);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };

    await run(['labels', 'list'], telemetry);
    await run(['emails', 'search', privateQuery], telemetry);

    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ product_surface: 'cli', operation: 'labels list', outcome: 'success' }),
    );
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'cli',
        operation: 'emails search',
        outcome: 'error',
        error_code: 'request_failed',
      }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain(privateQuery);
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private provider response');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('acct_1');
    expect(requests.some((request) => request.url.searchParams.get('query') === privateQuery)).toBe(true);
  });

  it('records new lookup and preview operations without private input', async () => {
    const capture = vi.fn();
    const telemetry = { capture, shutdown: vi.fn().mockResolvedValue(undefined) };
    let fail = false;
    setupRemote(() =>
      fail
        ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'private provider text' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        : envelope({ id: 'private-draft', to: [{ email: 'private@example.com' }] }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(['drafts', 'get', 'private-draft'], telemetry);
    await run(['emails', 'preview', '--draft', 'private-draft'], telemetry);
    await run(['emails', 'delivery-status', 'private-operation'], telemetry);
    fail = true;
    await run(['drafts', 'get', 'private-fail'], telemetry);
    await run(['emails', 'preview', '--draft', 'private-draft'], telemetry);
    await run(['emails', 'delivery-status', 'private-operation'], telemetry);
    for (const operation of ['drafts get', 'emails preview', 'emails delivery-status']) {
      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({ product_surface: 'cli', operation, outcome: 'success' }),
      );
    }
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        product_surface: 'cli',
        operation: 'drafts get',
        outcome: 'error',
        error_code: 'not_found',
      }),
    );
    for (const operation of ['emails preview', 'emails delivery-status']) {
      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({ product_surface: 'cli', operation, outcome: 'error', error_code: 'not_found' }),
      );
    }
    const captured = JSON.stringify(capture.mock.calls);
    for (const value of ['private-draft', 'private-operation', 'private@example.com', 'private provider text'])
      expect(captured).not.toContain(value);
  });
});
