import { EmailError } from '@fluxmail/core';
import { attachmentUri } from '@fluxmail/core/mcp';
import type { Client } from '@modelcontextprotocol/client';
import { cloudAccessToken, cloudFetch, cloudMcpUrl } from './cliCloudAuth.js';
import {
  currentRequestDeadlineMs,
  InstanceApiError,
  instanceResponseError,
  requestTimeoutError,
} from './cliInstances.js';
import { VERSION } from './version.js';

interface CloudErrorBody {
  error?: { code?: string | number; message?: string; data?: Record<string, unknown> };
  requestId?: string;
}

interface ToolErrorPayload {
  error?: string;
  message?: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

const INVALID_PARAMS = -32602;
const SDK_REQUEST_TIMEOUT = 'REQUEST_TIMEOUT';

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Calls Cloud's MCP endpoint, the only one that accepts both OAuth tokens and agent keys. */
export class CloudClient {
  private connection?: Promise<Client>;
  private lastToken?: string;
  /** The SDK wraps what the transport throws, so the original error is kept for the caller. */
  private transportFailure?: Error;

  constructor(
    readonly instance: string,
    readonly serverUrl: string,
  ) {}

  private async transportStep<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof EmailError || error instanceof InstanceApiError) this.transportFailure = error;
      throw error;
    }
  }

  /** The error to report for a failed SDK call, when it isn't a tool or protocol error. */
  private sdkFailure(error: unknown): Error | undefined {
    if (this.transportFailure) return this.transportFailure;
    // The SDK's own deadline aborts the fetch before cloudFetch's, so it needs the same mapping.
    if ((error as { code?: unknown }).code === SDK_REQUEST_TIMEOUT) return requestTimeoutError();
    return undefined;
  }

  private fetch: typeof fetch = (input, init) => this.transportStep(() => this.request(input, init));

  private request: typeof fetch = async (input, init) => {
    const response = await cloudFetch(this.serverUrl)(input, init);
    if (response.ok || response.status === 401) return response;
    const body = (await response
      .clone()
      .json()
      .catch(() => undefined)) as CloudErrorBody | undefined;
    // JSON-RPC errors use numeric codes and belong to the SDK, which negotiates on them.
    if (typeof body?.error?.code !== 'string') return response;
    throw instanceResponseError(
      body.error.code,
      body.error.message ?? `Fluxmail Cloud returned HTTP ${response.status}.`,
      response.status,
      body.error.data,
      body.requestId,
    );
  };

  private connect(): Promise<Client> {
    this.connection ??= (async () => {
      const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
      const transport = new StreamableHTTPClientTransport(new URL(cloudMcpUrl(this.serverUrl)), {
        fetch: this.fetch,
        authProvider: {
          token: () =>
            this.transportStep(async () => {
              this.lastToken = await cloudAccessToken(this.instance, this.serverUrl);
              return this.lastToken;
            }),
          onUnauthorized: () =>
            this.transportStep(async () => {
              this.lastToken = await cloudAccessToken(this.instance, this.serverUrl, this.lastToken);
            }),
        },
      });
      const client = new Client({ name: 'fluxmail-cli', version: VERSION }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(transport, { timeout: currentRequestDeadlineMs() });
      return client;
    })().catch((error: unknown) => {
      throw this.sdkFailure(error) ?? error;
    });
    return this.connection;
  }

  /**
   * `data` from the tool result. Partly failed modifies and sends that have a
   * delivery operation are errors that still carry data, which callers inspect
   * the same way as a REST response.
   */
  async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const client = await this.connect();
    this.transportFailure = undefined;
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await client.callTool({ name, arguments: args }, { timeout: currentRequestDeadlineMs() });
    } catch (error) {
      const failure = this.sdkFailure(error);
      if (failure) throw failure;
      if ((error as { code?: unknown }).code === INVALID_PARAMS) {
        throw new EmailError(
          'permission_denied',
          'This Fluxmail Cloud connection does not allow this command. Log in again with more permissions.',
        );
      }
      throw error;
    }
    const structured = result.structuredContent as { data?: T } | undefined;
    if (structured?.data !== undefined) return structured.data;
    const block = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === 'text');
    const text = block?.text ?? '';
    if (!result.isError) {
      const parsed = parseJson<{ data?: T }>(text);
      if (parsed?.data !== undefined) return parsed.data;
      throw instanceResponseError('invalid_response', 'Fluxmail Cloud returned no data.', 200);
    }
    const failure = parseJson<ToolErrorPayload>(text);
    throw instanceResponseError(
      failure?.error ?? 'invalid_request',
      failure?.message ?? text ?? 'Fluxmail Cloud rejected the request.',
      0,
      failure?.data,
      failure?.requestId,
    );
  }

  async readAttachment(
    accountId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{ content: Buffer; mimeType?: string }> {
    const client = await this.connect();
    this.transportFailure = undefined;
    // Lookups use the IDs, and the template needs a filename segment.
    const uri = attachmentUri(accountId, messageId, attachmentId, 'attachment');
    let contents: { mimeType?: string; blob?: string; text?: string } | undefined;
    try {
      ({
        contents: [contents],
      } = await client.readResource({ uri }, { timeout: currentRequestDeadlineMs() }));
    } catch (error) {
      const failure = this.sdkFailure(error);
      if (failure) throw failure;
      // Cloud's resource handler reports only a message. The tool reports the same failure with
      // its code, such as not_found or permission_denied, and throws it from callTool.
      await this.callTool('download_attachment', { accountId, messageId, attachmentId });
      // The tool succeeded, so the read failed for a reason that has passed.
      throw instanceResponseError('provider_unavailable', error instanceof Error ? error.message : String(error), 0);
    }
    if (contents?.blob !== undefined) {
      return { content: Buffer.from(contents.blob, 'base64'), mimeType: contents.mimeType };
    }
    if (contents?.text !== undefined) {
      return { content: Buffer.from(contents.text, 'utf8'), mimeType: contents.mimeType };
    }
    throw instanceResponseError('invalid_response', 'Fluxmail Cloud returned no attachment content.', 200);
  }
}
