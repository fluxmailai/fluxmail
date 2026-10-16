import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EmailError, type EmailErrorCode, type ProviderFailure } from '@fluxmail/core';
import { resolveDataDir } from './config.js';
import { createContext } from './context.js';
import { createApp } from './http/app.js';
import { CliStartupError } from './cliStartupDiagnostics.js';
import { OPERATION_TELEMETRY_EVENT, type Telemetry, type TelemetryProperties } from './telemetry.js';

export interface LocalInstanceProfile {
  kind: 'local';
}

export interface RemoteInstanceProfile {
  kind: 'remote';
  serverUrl: string;
}

export type InstanceProfile = LocalInstanceProfile | RemoteInstanceProfile;

export interface CliInstanceConfig {
  active?: string;
  instances: Record<string, InstanceProfile>;
}

export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
  warnings?: string[];
}

const EMAIL_ERROR_CODES = new Set<EmailErrorCode>([
  'auth_expired',
  'rate_limited',
  'not_found',
  'invalid_request',
  'idempotency_conflict',
  'provider_unavailable',
  'entitlement_exceeded',
  'permission_denied',
  'unsupported_capability',
]);

const SAFE_INSTANCE_API_TELEMETRY_CODES = new Set([
  'https_required',
  'idempotency_conflict',
  'idempotency_in_progress',
  'internal',
  'invalid_response',
  'request_failed',
  'request_timeout',
  'request_too_large',
  'setup_required',
  'unauthorized',
  'unsupported_media_type',
]);
const SAFE_CONNECTION_STAGES = new Set([
  'cli_validation',
  'connection_request',
  'server_validation',
  'provider_check',
  'account_persist',
  'oauth_prepare',
  'complete',
]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let requestDeadlineMs = 30_000;

export function setRequestDeadlineMs(value: number): void {
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw new EmailError('invalid_request', '--timeout must be between 1 and 300 seconds.');
  }
  requestDeadlineMs = value;
}

export class InstanceApiError extends Error {
  failure?: ProviderFailure;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly data?: Record<string, unknown>,
    readonly requestId?: string,
    readonly connectionStage?: string,
  ) {
    super(message);
    this.name = 'InstanceApiError';
  }
}

function requestTimeoutError(): InstanceApiError {
  return new InstanceApiError(
    'request_timeout',
    'The request timed out. Check the operation status before retrying a send.',
    0,
  );
}

export function instanceResponseError(
  code: string,
  message: string,
  status: number,
  data?: Record<string, unknown>,
  requestId?: string,
  connectionStage?: string,
): Error {
  const safeRequestId = requestId && (!connectionStage || UUID_V4_PATTERN.test(requestId)) ? requestId : undefined;
  const safeConnectionStage =
    connectionStage && SAFE_CONNECTION_STAGES.has(connectionStage) ? connectionStage : undefined;
  if (EMAIL_ERROR_CODES.has(code as EmailErrorCode)) {
    return Object.assign(new EmailError(code as EmailErrorCode, message, data), {
      status,
      requestId: safeRequestId,
      connectionStage: safeConnectionStage,
    });
  }
  return new InstanceApiError(code, message, status, data, safeRequestId, safeConnectionStage);
}

/** Provider failure detail reported by local requests, keyed by their response or envelope. */
const localFailures = new WeakMap<object, ProviderFailure>();

/** The provider failure a local request recorded for this response or JSON envelope. */
export function localFailure(value: object): ProviderFailure | undefined {
  return localFailures.get(value);
}

/** Attach the provider failure recorded for a local response to the error built from it. */
export function withLocalFailure<E extends Error>(error: E, response: Response): E {
  const failure = localFailures.get(response);
  if (failure) (error as { failure?: ProviderFailure }).failure = failure;
  return error;
}

/**
 * Keep the provider failure detail from an in-process request so the CLI can
 * report it on its own event. Nothing is sent from here.
 */
function localFailureRecorder(): { telemetry: Telemetry; failure(): ProviderFailure | undefined } {
  let recorded: TelemetryProperties | undefined;
  return {
    telemetry: {
      capture(event, properties) {
        if (event === OPERATION_TELEMETRY_EVENT && properties?.outcome === 'error') recorded = properties;
      },
      shutdown: async () => {},
    },
    failure() {
      if (!recorded) return undefined;
      const failure = {
        provider: recorded.provider,
        reason: recorded.failure_reason,
        phase: recorded.failure_phase,
        httpStatus: recorded.provider_http_status,
        ioCode: recorded.io_code,
      } as ProviderFailure;
      return Object.values(failure).some((value) => value !== undefined) ? failure : undefined;
    },
  };
}

export function apiRequestId(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'requestId' in error && typeof error.requestId === 'string'
    ? error.requestId
    : undefined;
}

/** A person stopped an interactive prompt. This is not a Fluxmail failure. */
export class CliCanceledError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CliCanceledError';
  }
}

export function apiErrorCode(error: unknown): string {
  if (error instanceof EmailError) return error.code;
  if (error instanceof CliCanceledError) return 'canceled';
  if (error instanceof InstanceApiError) {
    return SAFE_INSTANCE_API_TELEMETRY_CODES.has(error.code) ? error.code : 'request_failed';
  }
  return 'internal';
}

interface CliCredentials {
  sessions: Record<string, string>;
}

function cliDirectory(): string {
  return path.join(resolveDataDir(), 'cli');
}

export function instanceConfigPath(): string {
  return path.join(cliDirectory(), 'instances.json');
}

export function credentialPath(): string {
  return path.join(cliDirectory(), 'credentials.json');
}

function readJson<T>(filePath: string, fallback: T, kind: 'instance_config' | 'credentials'): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new CliStartupError(
      'invalid_request',
      `Could not read ${filePath}: ${(error as Error).message}`,
      error instanceof SyntaxError ? `${kind}_invalid_json` : `${kind}_read_failed`,
      (error as NodeJS.ErrnoException).code,
    );
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

export function loadInstanceConfig(): CliInstanceConfig {
  return readJson(instanceConfigPath(), { instances: {} }, 'instance_config');
}

function saveInstanceConfig(config: CliInstanceConfig): void {
  writePrivateJson(instanceConfigPath(), config);
}

function loadCredentials(): CliCredentials {
  return readJson(credentialPath(), { sessions: {} }, 'credentials');
}

function saveCredentials(credentials: CliCredentials): void {
  writePrivateJson(credentialPath(), credentials);
}

function validInstanceName(name: string): string {
  const normalized = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(normalized)) {
    throw new EmailError('invalid_request', 'Instance names may contain letters, numbers, underscores, and hyphens.');
  }
  return normalized;
}

export function validateRemoteServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmailError('invalid_request', 'Server URL must be a valid absolute URL.');
  }
  if (url.username || url.password) {
    throw new EmailError('invalid_request', 'Server URLs cannot contain credentials.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new EmailError('invalid_request', 'Remote instances require HTTPS except on localhost.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function saveLocalInstance(name = 'local'): void {
  const instanceName = validInstanceName(name);
  const config = loadInstanceConfig();
  config.instances[instanceName] = { kind: 'local' };
  config.active = instanceName;
  saveInstanceConfig(config);
}

export function saveRemoteInstance(name: string, serverUrl: string): void {
  const instanceName = validInstanceName(name);
  const config = loadInstanceConfig();
  config.instances[instanceName] = { kind: 'remote', serverUrl: validateRemoteServerUrl(serverUrl) };
  config.active ??= instanceName;
  saveInstanceConfig(config);
}

export function useInstance(name: string): void {
  const config = loadInstanceConfig();
  if (!config.instances[name]) throw new EmailError('not_found', `No CLI instance named "${name}".`);
  config.active = name;
  saveInstanceConfig(config);
}

export function removeInstance(name: string): void {
  const config = loadInstanceConfig();
  if (!config.instances[name]) throw new EmailError('not_found', `No CLI instance named "${name}".`);
  delete config.instances[name];
  if (config.active === name) config.active = Object.keys(config.instances)[0];
  saveInstanceConfig(config);
  const credentials = loadCredentials();
  delete credentials.sessions[name];
  saveCredentials(credentials);
}

export function resolveInstance(name?: string): { name: string; profile: InstanceProfile; token?: string } {
  const config = loadInstanceConfig();
  const selected = name ?? config.active;
  if (!selected)
    throw new CliStartupError(
      'invalid_request',
      'No CLI instance is configured.\nFor an existing local instance, run "fluxmail --instance local login".\nFor a new local instance, run "fluxmail setup".\nFor a remote instance, run "fluxmail login --server <url>".',
      'instance_not_configured',
    );
  const profile = config.instances[selected];
  if (!profile) throw new CliStartupError('not_found', `No CLI instance named "${selected}".`, 'instance_not_found');
  return { name: selected, profile, token: loadCredentials().sessions[selected] };
}

export function resolveStdioInstance(name?: string): ReturnType<typeof resolveInstance> {
  const config = loadInstanceConfig();
  let selectedName = name;
  if (selectedName === undefined) {
    const activeIsLocal = config.active !== undefined && config.instances[config.active]?.kind === 'local';
    if (activeIsLocal) selectedName = config.active;
    else if (config.instances.local?.kind === 'local') selectedName = 'local';
    else {
      const localNames = Object.keys(config.instances).filter((key) => config.instances[key]?.kind === 'local');
      if (localNames.length > 1) {
        throw new CliStartupError(
          'invalid_request',
          'Multiple local CLI profiles are configured. Run "fluxmail --instance <name> stdio" to choose one.',
          'local_instance_ambiguous',
        );
      }
      selectedName = localNames[0] ?? config.active;
    }
  }
  const selected = resolveInstance(selectedName);
  if (selected.profile.kind !== 'local') {
    throw new CliStartupError(
      'invalid_request',
      'Stdio MCP requires a local instance. Run "fluxmail --instance local login", or use the remote HTTP MCP endpoint with an API key.',
      'local_instance_required',
    );
  }
  return selected;
}

export function saveSessionToken(instanceName: string, token: string): void {
  const credentials = loadCredentials();
  credentials.sessions[instanceName] = token;
  saveCredentials(credentials);
}

export function clearSessionToken(instanceName: string): void {
  const credentials = loadCredentials();
  delete credentials.sessions[instanceName];
  saveCredentials(credentials);
}

export class InstanceClient {
  constructor(
    readonly name: string,
    readonly profile: InstanceProfile,
    private readonly token?: string,
    private readonly requestTimeoutMs?: number,
  ) {}

  async request(pathname: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const deadline = AbortSignal.timeout(this.requestTimeoutMs ?? requestDeadlineMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    if (signal.aborted) throw requestTimeoutError();
    const headers = new Headers(init.headers);
    if (authenticated) {
      if (!this.token) throw new EmailError('permission_denied', `Log in to instance "${this.name}" first.`);
      headers.set('authorization', `Bearer ${this.token}`);
    }
    if (this.profile.kind === 'local') {
      const context = createContext();
      const recorder = localFailureRecorder();
      const requestTask = (async () => {
        try {
          // A local instance handles the request in this process, so the CLI command
          // already reports the outcome. Recording telemetry locally keeps one user
          // action from being counted twice and keeps the rest surface meaning a real
          // HTTP call, while the CLI event still gets the provider failure detail.
          // The logger stays, so local logs still record the failure.
          const response = await createApp({ ...context, telemetry: recorder.telemetry }).request(pathname, {
            ...init,
            headers,
            signal,
          });
          const body = response.body ? await response.arrayBuffer() : null;
          const local = new Response(body?.byteLength ? body : null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          const failure = recorder.failure();
          if (failure) localFailures.set(local, failure);
          return local;
        } finally {
          try {
            await context.registry.close();
          } finally {
            (context.db as unknown as { $client: { close(): void } }).$client.close();
          }
        }
      })();
      let onAbort: (() => void) | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(requestTimeoutError());
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([requestTask, timedOut]);
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    }
    const baseUrl = new URL(`${this.profile.serverUrl}/`);
    const url = new URL(pathname.replace(/^\/+/, ''), baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new EmailError('invalid_request', 'Remote request paths must stay on the configured server.');
    }
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers, signal, redirect: 'manual' });
    } catch (error) {
      if (signal.aborted) throw requestTimeoutError();
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new EmailError(
        'permission_denied',
        'The remote server redirected an authenticated request. Refusing to forward credentials.',
      );
    }
    return response;
  }

  async json<T>(pathname: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    return (await this.jsonEnvelope<T>(pathname, init, authenticated)).data;
  }

  async jsonEnvelope<T>(pathname: string, init: RequestInit = {}, authenticated = true): Promise<ApiEnvelope<T>> {
    const response = await this.request(pathname, init, authenticated);
    let body: {
      data?: T;
      meta?: Record<string, unknown>;
      warnings?: string[];
      error?: {
        code?: string;
        message?: string;
        data?: Record<string, unknown>;
        requestId?: string;
        diagnostics?: { connectionStage?: string };
      };
    };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new InstanceApiError(
        'invalid_response',
        `Instance ${this.name} returned invalid JSON with HTTP ${response.status}.`,
        response.status,
      );
    }
    if (!response.ok) {
      const code = body.error?.code ?? 'request_failed';
      const message = body.error?.message ?? `Request failed with HTTP ${response.status}.`;
      throw withLocalFailure(
        instanceResponseError(
          code,
          message,
          response.status,
          body.error?.data,
          body.error?.requestId,
          body.error?.diagnostics?.connectionStage,
        ),
        response,
      );
    }
    if (!('data' in body)) {
      throw new InstanceApiError('invalid_response', `Instance ${this.name} returned no data.`, response.status);
    }
    const envelope: ApiEnvelope<T> = {
      data: body.data as T,
      ...(body.meta ? { meta: body.meta } : {}),
      ...(body.warnings ? { warnings: body.warnings } : {}),
    };
    // A successful response can still report a partial failure, such as a failed batch group.
    const failure = localFailures.get(response);
    if (failure) localFailures.set(envelope, failure);
    return envelope;
  }
}

export function instanceClient(name?: string, requireToken = true, requestTimeoutMs?: number): InstanceClient {
  const selected = resolveInstance(name);
  if (requireToken && !selected.token)
    throw new EmailError('permission_denied', `Log in to instance "${selected.name}" first.`);
  return new InstanceClient(selected.name, selected.profile, selected.token, requestTimeoutMs);
}
