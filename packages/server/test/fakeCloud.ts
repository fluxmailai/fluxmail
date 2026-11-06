import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  ResourceTemplate,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { z } from 'zod';

type ToolResult = { data: unknown } | { raw: Record<string, unknown> };
type ToolHandler = (args: Record<string, unknown>) => ToolResult;

export interface FakeCloudOptions {
  accessTokenLifetimeSeconds?: number;
  /** Delays refresh responses so parallel callers overlap. */
  refreshDelayMs?: number;
  /** Names another authorization server in the protected resource metadata. */
  authorizationServer?: string;
}

/**
 * A stand-in for Fluxmail Cloud's protocol surface: the OAuth routes and rules
 * in fluxmail-web's agent-oauth.ts, and /mcp served the way its mail/tools.ts
 * serves it. Agent keys and tokens only work on /mcp.
 */
export async function startFakeCloud(options: FakeCloudOptions = {}) {
  const state = {
    registrations: [] as Array<Record<string, unknown>>,
    authorizations: [] as URLSearchParams[],
    refreshes: [] as string[],
    revocations: [] as string[],
    calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    resourceReads: [] as string[],
    replayed: false,
    accessTokens: new Set<string>(),
    refreshTokens: new Map<string, 'active' | 'rotated'>(),
    apiKeys: new Set(['fm_valid_key']),
    hiddenTools: new Set<string>(),
    nextHttpFailure: undefined as { status: number; code: string; message: string } | undefined,
    /** Answers server/discover like a server without the 2026 protocol. */
    rejectDiscovery: false,
    /** Makes attachment reads throw like Cloud's resource handler, with only a message. */
    attachmentFailure: undefined as string | undefined,
    /** Delays every tool call. */
    toolDelayMs: 0,
    handshakes: 0,
    tools: new Map<string, ToolHandler>(),
    /** Input schemas for tools that advertise their arguments. Others accept anything and list none. */
    toolSchemas: new Map<string, z.ZodObject>(),
  };
  const codes = new Map<string, { challenge: string; scope: string }>();
  let issued = 0;

  const app = new Hono();
  let origin = '';
  const resourceMetadata = () => ({
    resource: `${origin}/mcp`,
    authorization_servers: [options.authorizationServer ?? `${origin}/api/auth`],
    bearer_methods_supported: ['header'],
  });
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceMetadata()));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resourceMetadata()));
  app.get('/.well-known/oauth-authorization-server/api/auth', (c) =>
    c.json({
      issuer: `${origin}/api/auth`,
      authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
      token_endpoint: `${origin}/api/auth/oauth2/token`,
      registration_endpoint: `${origin}/api/auth/oauth2/register`,
      revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    }),
  );
  app.post('/api/auth/oauth2/register', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    state.registrations.push(body);
    return c.json({ ...body, client_id: `client_${state.registrations.length}` }, 201);
  });
  // Stands in for the browser's consent page: approval redirects straight back.
  app.get('/api/auth/oauth2/authorize', (c) => {
    const query = new URL(c.req.url).searchParams;
    state.authorizations.push(query);
    const code = randomUUID();
    codes.set(code, { challenge: query.get('code_challenge')!, scope: query.get('scope') ?? '' });
    const redirect = new URL(query.get('redirect_uri')!);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', query.get('state')!);
    redirect.searchParams.set('iss', `${origin}/api/auth`);
    return c.redirect(redirect.href);
  });
  const issueTokens = (scope: string) => {
    issued += 1;
    const accessToken = `header.access${issued}.signature`;
    const refreshToken = `refresh${issued}`;
    state.accessTokens.add(accessToken);
    state.refreshTokens.set(refreshToken, 'active');
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: options.accessTokenLifetimeSeconds ?? 900,
      scope,
    };
  };
  app.post('/api/auth/oauth2/token', async (c) => {
    const fields = new URLSearchParams(await c.req.text());
    if (fields.get('resource') !== `${origin}/mcp`) return c.json({ error: 'invalid_target' }, 400);
    if (fields.get('grant_type') === 'authorization_code') {
      const code = codes.get(fields.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(fields.get('code_verifier') ?? '')
        .digest('base64url');
      if (!code || code.challenge !== challenge) return c.json({ error: 'invalid_grant' }, 400);
      codes.delete(fields.get('code')!);
      return c.json(issueTokens(code.scope));
    }
    const refreshToken = fields.get('refresh_token') ?? '';
    state.refreshes.push(refreshToken);
    if (options.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs));
    const status = state.refreshTokens.get(refreshToken);
    if (status === 'rotated') {
      // Cloud revokes the whole grant when a rotated token comes back.
      state.replayed = true;
      state.refreshTokens.clear();
      state.accessTokens.clear();
    }
    if (status !== 'active') return c.json({ error: 'invalid_grant' }, 400);
    state.refreshTokens.set(refreshToken, 'rotated');
    return c.json(issueTokens('mail.read offline_access'));
  });
  app.post('/api/auth/oauth2/revoke', async (c) => {
    const fields = new URLSearchParams(await c.req.text());
    state.revocations.push(fields.get('token') ?? '');
    return c.json({});
  });

  const mcpServer = () => {
    const server = new McpServer(
      { name: 'fluxmail-cloud', version: '0.1.0' },
      { capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } } },
    );
    server.registerResource(
      'attachment',
      new ResourceTemplate('fluxmail://attachment/{accountId}/{messageId}/{attachmentId}/{filename}', {
        list: undefined,
      }),
      {},
      (uri) => {
        state.resourceReads.push(uri.href);
        if (state.attachmentFailure) throw new Error(state.attachmentFailure);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/pdf',
              blob: Buffer.from('attachment bytes').toString('base64'),
            },
          ],
        };
      },
    );
    for (const [name, handler] of state.tools) {
      if (state.hiddenTools.has(name)) continue;
      const inputSchema = state.toolSchemas.get(name) ?? z.object({}).passthrough();
      server.registerTool(name, { inputSchema }, async (args: Record<string, unknown>) => {
        state.calls.push({ name, args });
        if (state.toolDelayMs) await new Promise((resolve) => setTimeout(resolve, state.toolDelayMs));
        const result = handler(args);
        if ('raw' in result) return result.raw as never;
        return {
          structuredContent: { data: result.data },
          content: [{ type: 'text' as const, text: JSON.stringify({ data: result.data }) }],
        } as never;
      });
    }
    return server;
  };

  app.post('/mcp', async (c) => {
    const authorization = c.req.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!state.accessTokens.has(token) && !state.apiKeys.has(token)) {
      return c.json({ error: { code: 'unauthorized', message: 'Connect with OAuth.' }, requestId: randomUUID() }, 401, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    const failure = state.nextHttpFailure;
    if (failure) {
      state.nextHttpFailure = undefined;
      return c.json(
        { error: { code: failure.code, message: failure.message }, requestId: randomUUID() },
        failure.status as 429,
      );
    }
    const request = c.req.raw;
    const body = (await request.clone().json()) as { id?: number; method?: string };
    if (state.rejectDiscovery && body.method === 'server/discover') {
      return c.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'Method not found' } }, 400);
    }
    if (body.method === 'initialize') state.handshakes += 1;
    const server = mcpServer();
    if (await isLegacyRequest(request, body)) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(request, { parsedBody: body });
    }
    return createMcpHandler(() => server, { legacy: 'reject' }).fetch(request, { parsedBody: body });
  });

  // The SDK checks `instanceof Response`, so the global stays the one fetch returns.
  const listener = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1', overrideGlobalObjects: false });
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return {
    ...state,
    state,
    origin,
    setTool: (name: string, handler: ToolHandler, inputSchema?: z.ZodObject) => {
      state.tools.set(name, handler);
      if (inputSchema) state.toolSchemas.set(name, inputSchema);
    },
    close: () => new Promise<void>((resolve) => listener.close(() => resolve())),
  };
}

export type FakeCloud = Awaited<ReturnType<typeof startFakeCloud>>;
