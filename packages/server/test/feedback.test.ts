import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { EmailError } from '@fluxmail/core';
import { feedbackCloudOrigin, submitFeedback } from '../src/feedback.js';
import { VERSION } from '../src/version.js';
import { buildMcpServer, type BuildMcpServerOptions } from '../src/mcp/buildServer.js';
import type { EmailService } from '../src/service/emailService.js';
import { customPermissionPolicy, permissionPolicyForProfile } from '../src/permissions.js';

const message =
  '  Synthetic private input: person@example.invalid /Users/private/mail token-secret.\nKeep this exact text.  ';
const privateValues = ['person@example.invalid', '/Users/private/mail', 'token-secret'];
const data = { feedbackId: 'report-1', message, category: 'other', product: 'self_hosted', version: VERSION };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const intake = () => vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data }, { status: 201 }));

async function connect(options: BuildMcpServerOptions = {}) {
  const enforceQuota = vi.fn(() => {
    throw new EmailError('entitlement_exceeded', 'Lapsed license');
  });
  const mail = vi.fn(() => {
    throw new Error('Mail must not be accessed');
  });
  const service = new Proxy(
    { enforceQuota },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : mail) },
  );
  const server = buildMcpServer(service as unknown as EmailService, {
    permissions: customPermissionPolicy([]),
    ...options,
  });
  const client = new Client({ name: 'feedback-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, enforceQuota, mail };
}

describe('feedback MCP tool', () => {
  it.each([customPermissionPolicy([]), permissionPolicyForProfile('read-only')])(
    'is discoverable without write permissions and works after a license lapses',
    async (permissions) => {
      const fetch = intake();
      vi.stubGlobal('fetch', fetch);
      const capture = vi.fn();
      const { client, enforceQuota, mail } = await connect({
        permissions,
        telemetry: { capture, shutdown: async () => {} },
      });
      const tool = (await client.listTools()).tools.find((t) => t.name === 'send_feedback')!;
      expect(tool.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false, required: ['message'] });
      expect(tool.inputSchema.properties?.category).toMatchObject({
        default: 'other',
        type: 'string',
        enum: ['bug', 'feature', 'other'],
      });
      const result = await client.callTool({ name: 'send_feedback', arguments: { message } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ data });
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ data }, null, 2) }]);
      expect(enforceQuota).not.toHaveBeenCalled();
      expect(mail).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe('https://cloud.fluxmail.ai/api/feedback');
      expect(JSON.parse(init!.body as string)).toEqual({
        message,
        category: 'other',
        product: 'self_hosted',
        version: VERSION,
      });
      expect(init).toMatchObject({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        credentials: 'omit',
      });
      expect(capture).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({ operation: 'send_feedback', product_surface: 'mcp', outcome: 'success' }),
      );
      const events = JSON.stringify(capture.mock.calls);
      for (const privateValue of [...privateValues, 'report-1', 'cloud.fluxmail.ai'])
        expect(events).not.toContain(privateValue);
    },
  );

  it.each([
    {},
    { message: null },
    { message: '' },
    { message: ' \n\t' },
    { message: 'a\0b' },
    { message: 'a'.repeat(4001) },
    { message, category: null },
    { message, category: 'invalid' },
    { message, endpoint: 'https://private.example' },
    { message, accountId: 'private-mailbox' },
    { message, attachment: 'private' },
  ])('rejects invalid or extra arguments before making a request: %j', async (args) => {
    const fetch = intake();
    vi.stubGlobal('fetch', fetch);
    const { client } = await connect();
    const result = await client.callTool({ name: 'send_feedback', arguments: args });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records safe error telemetry and keeps remote secrets out of results and logs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('https://secret:password@private.example private message')),
    );
    const capture = vi.fn();
    const error = vi.fn();
    const { client } = await connect({
      telemetry: { capture, shutdown: async () => {} },
      logger: { info: vi.fn(), warn: vi.fn(), error, flush: async () => {}, close: async () => {} },
    });
    const result = await client.callTool({ name: 'send_feedback', arguments: { message } });
    expect(result.isError).toBe(true);
    expect(capture).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({ operation: 'send_feedback', outcome: 'error', error_code: 'provider_unavailable' }),
    );
    const output = JSON.stringify([result, capture.mock.calls, error.mock.calls]);
    for (const secret of [...privateValues, 'password', 'private.example', 'private message'])
      expect(output).not.toContain(secret);
  });

  it('honors the administrator restriction without outbound requests', async () => {
    const fetch = intake();
    vi.stubGlobal('fetch', fetch);
    const { client } = await connect({ feedback: { enabled: false } });
    const result = await client.callTool({ name: 'send_feedback', arguments: { message } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('permission_denied');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes MCP cancellation through to the intake request', async () => {
    let started!: () => void;
    let canceled!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = new Promise<void>((resolve) => {
      canceled = resolve;
    });
    const fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          started();
          init.signal.addEventListener(
            'abort',
            () => {
              canceled();
              reject(init.signal.reason);
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const { client } = await connect();
    const controller = new AbortController();
    const result = client.callTool({ name: 'send_feedback', arguments: { message } }, { signal: controller.signal });
    const assertion = expect(result).rejects.toThrow();
    await start;
    controller.abort();
    await assertion;
    await cancel;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('submits independently of disabled telemetry', async () => {
    const fetch = intake();
    vi.stubGlobal('fetch', fetch);
    const { client } = await connect({ telemetry: undefined });
    expect((await client.callTool({ name: 'send_feedback', arguments: { message } })).structuredContent).toEqual({
      data,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('feedback intake client', () => {
  it.each([
    ['bug', 'bug'],
    ['feature', 'feature'],
    [undefined, 'other'],
  ] as const)('submits category %s', async (category, expected) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: { ...data, category: expected } }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    expect(
      await submitFeedback({ message, ...(category ? { category } : {}) }, { cloudOrigin: 'http://localhost:3000' }),
    ).toEqual({ ...data, category: expected });
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:3000/api/feedback');
  });

  it.each([
    [400, 'invalid_request'],
    [413, 'invalid_request'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
    [302, 'provider_unavailable'],
  ] as const)('maps HTTP %s without response text or retrying', async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(new Response('private response with credentials', { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(submitFeedback({ message })).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { data: { ...data, message: 'changed' } },
    { data: { ...data, category: 'bug' } },
    { data: { ...data, unexpected: 'private' } },
  ])('rejects malformed or mismatched success responses', async (response) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(response, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await expect(submitFeedback({ message })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects an oversized success response without exposing its contents', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('private'.repeat(5000), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await expect(submitFeedback({ message })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('bounds JSON-escaped request bytes', async () => {
    const fetch = vi.fn(async (_url, init) =>
      Response.json({ data: { feedbackId: 'report-1', ...JSON.parse(init.body) } }, { status: 201 }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(submitFeedback({ message: '\u0001'.repeat(4000) })).resolves.toMatchObject({
      message: '\u0001'.repeat(4000),
    });
    // 4000 characters expand to at most 24 KiB here, below the intake limit.
    expect(Buffer.byteLength(fetch.mock.calls[0]![1]!.body as string)).toBeLessThanOrEqual(32 * 1024);
  });

  it('aborts a pending request on cancellation and timeout without retrying', async () => {
    // AbortSignal.timeout uses native timers; spy only its deadline so cancellation remains deterministic.
    const timeout = new AbortController();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    for (const reason of ['cancellation', 'timeout']) {
      const cancellation = new AbortController();
      const result = submitFeedback({ message }, {}, cancellation.signal);
      const assertion = expect(result).rejects.toMatchObject({ code: 'provider_unavailable' });
      if (reason === 'cancellation') cancellation.abort();
      else timeout.abort();
      await assertion;
    }
    expect(deadline).toHaveBeenCalledWith(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    deadline.mockRestore();
  });

  it('does not send a request already canceled', async () => {
    const fetch = intake();
    vi.stubGlobal('fetch', fetch);
    await expect(submitFeedback({ message }, {}, AbortSignal.abort())).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?key=secret',
    'file:///tmp/intake',
  ])('rejects non-origin configuration %s', (origin) => {
    expect(() => feedbackCloudOrigin(origin)).toThrow('FLUXMAIL_FEEDBACK_CLOUD_ORIGIN');
  });
});
