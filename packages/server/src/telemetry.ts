import { PostHog } from 'posthog-node';
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import path from 'node:path';
import {
  FAILURE_IO_CODES,
  FAILURE_PHASES,
  FAILURE_REASONS,
  MAIL_PROVIDERS,
  type ProviderFailure,
} from '@fluxmail/core';
import { VERSION } from './version.js';

// PostHog project tokens are public ingestion identifiers. This is the same
// project and first-party proxy used by fluxmail.ai.
const POSTHOG_PROJECT_TOKEN = 'phc_t9WdWpoONslidKRejBKMYG8FLjLo0tR84U8lFKE4MlN';
const POSTHOG_HOST = 'https://t.fluxmail.ai';
const POSTHOG_REQUEST_TIMEOUT_MS = 500;
const POSTHOG_SHUTDOWN_TIMEOUT_MS = 1_000;

export type TelemetryProperties = Record<string, boolean | number | string | undefined>;

export const OPERATION_TELEMETRY_EVENT = 'operation completed';

export type ProductSurface = 'cli' | 'mcp' | 'rest';
export type OperationOutcome = 'success' | 'error';

export interface OperationTelemetry {
  productSurface: ProductSurface;
  operation: string;
  outcome: OperationOutcome;
  durationMs: number;
  errorCode?: string;
  /** The error behind a failed operation. Only allowlisted failure detail is read from it. */
  error?: unknown;
  transport?: string;
  properties?: TelemetryProperties;
}

/** Provider failure properties, which also appear on the matching `$exception`. */
const FAILURE_PROPERTY_KEYS = ['provider', 'failure_reason', 'failure_phase', 'provider_http_status', 'io_code'];

function allowed<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * Read the provider failure detail attached to an error. Every value is checked
 * against a fixed list, so nothing from the provider's message or response is sent.
 */
export function failureProperties(error: unknown): TelemetryProperties {
  const failure = (error as { failure?: ProviderFailure } | undefined)?.failure;
  if (!failure || typeof failure !== 'object') return {};
  const status = failure.httpStatus;
  const ioCode = failure.ioCode;
  const properties: TelemetryProperties = {
    provider: allowed(MAIL_PROVIDERS, failure.provider),
    failure_reason: allowed(FAILURE_REASONS, failure.reason),
    failure_phase: allowed(FAILURE_PHASES, failure.phase),
    provider_http_status:
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
    io_code: ioCode === undefined ? undefined : (allowed(FAILURE_IO_CODES, ioCode) ?? 'other'),
  };
  return Object.fromEntries(Object.entries(properties).filter((entry) => entry[1] !== undefined));
}

export interface Telemetry {
  capture(event: string, properties?: TelemetryProperties): void;
  /** Keep shutdown open until an in-flight operation records its final event. */
  beginActivity?(): () => void;
  shutdown(): Promise<void>;
}

/** Capture one user-visible operation without accepting request or response payloads. */
export function captureOperation(telemetry: Telemetry | undefined, operation: OperationTelemetry): void {
  const properties = { ...operation.properties };
  for (const key of ['product_surface', 'operation', 'outcome', 'duration_ms', 'error_code', 'transport']) {
    delete properties[key];
  }
  const failure = operation.outcome === 'error' ? failureProperties(operation.error) : {};
  try {
    telemetry?.capture(OPERATION_TELEMETRY_EVENT, {
      ...properties,
      product_surface: operation.productSurface,
      operation: operation.operation,
      outcome: operation.outcome,
      duration_ms: Math.max(0, Math.round(operation.durationMs)),
      ...(operation.errorCode ? { error_code: operation.errorCode } : {}),
      ...(operation.transport ? { transport: operation.transport } : {}),
      ...failure,
    });
  } catch {
    // An injected telemetry client must not affect the operation.
  }
}

interface PostHogClient {
  capture(options: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
    disableGeoip?: boolean;
  }): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

interface PostHogFetchOptions {
  method?: string;
  headers: Record<string, string>;
  body?: string | Blob;
  signal?: AbortSignal;
}

interface PostHogFetchResponse {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}

interface PostHogTransport {
  fetch(url: string, options: PostHogFetchOptions): Promise<PostHogFetchResponse>;
  destroy(): void;
}

function acceptedTelemetryResponse(text = ''): PostHogFetchResponse {
  return {
    status: 200,
    text: async () => text,
    json: async () => {
      try {
        return text ? (JSON.parse(text) as unknown) : {};
      } catch {
        return {};
      }
    },
    headers: { get: () => null },
  };
}

/** Keep pooled analytics sockets under our control so shutdown can close them. */
function createPostHogTransport(): PostHogTransport {
  const httpAgent = new HttpAgent({ keepAlive: true });
  const httpsAgent = new HttpsAgent({ keepAlive: true });

  return {
    async fetch(url, options) {
      try {
        const target = new URL(url);
        const send =
          target.protocol === 'https:' ? httpsRequest : target.protocol === 'http:' ? httpRequest : undefined;
        if (!send) return acceptedTelemetryResponse();

        const body =
          options.body instanceof Blob
            ? Buffer.from(await options.body.arrayBuffer())
            : options.body === undefined
              ? undefined
              : Buffer.from(options.body);

        return await new Promise((resolve, reject) => {
          const request = send(
            target,
            {
              method: options.method,
              headers: options.headers,
              signal: options.signal,
              agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer | string) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              response.once('error', reject);
              response.once('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const status = response.statusCode ?? 0;
                if (status < 200 || status >= 400) return resolve(acceptedTelemetryResponse(text));
                resolve({
                  status,
                  text: async () => text,
                  json: async () => JSON.parse(text) as unknown,
                  headers: {
                    get(name) {
                      const value = response.headers[name.toLowerCase()];
                      return Array.isArray(value) ? value.join(', ') : (value ?? null);
                    },
                  },
                });
              });
            },
          );
          request.once('error', reject);
          request.end(body);
        });
      } catch {
        // The SDK logs batch delivery failures to stderr. Telemetry is best
        // effort, so absorb transport failures before they reach the SDK.
        return acceptedTelemetryResponse();
      }
    },
    destroy() {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

const TELEMETRY_ID_PATTERN = /^[a-f0-9]{32}$/;

function readTelemetryId(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const id = readFileSync(file, 'utf8').trim();
  return TELEMETRY_ID_PATTERN.test(id) ? id : undefined;
}

export function publishTelemetryId(file: string, candidateFile: string, candidateId: string): string {
  try {
    linkSync(candidateFile, file);
    return candidateId;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const existingId = readTelemetryId(file);
    if (existingId) return existingId;

    // Preserve self-repair for a corrupt ID file. Normal first-run races never
    // reach this path because the linked candidate is complete before publishing.
    writeFileSync(file, `${candidateId}\n`, { mode: 0o600 });
    return candidateId;
  }
}

function loadTelemetryId(dataDir: string): string {
  const file = path.join(dataDir, 'telemetry.id');
  const id = randomBytes(16).toString('hex');
  const candidateFile = `${file}.${process.pid}.${id}.tmp`;
  writeFileSync(candidateFile, `${id}\n`, { flag: 'wx', mode: 0o600 });
  try {
    return publishTelemetryId(file, candidateFile, id);
  } finally {
    rmSync(candidateFile, { force: true });
  }
}

function telemetryDisabledFile(dataDir: string): string {
  return path.join(dataDir, 'telemetry.disabled');
}

export function telemetryOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.FLUXMAIL_TELEMETRY?.toLowerCase();
  return setting === '0' || setting === 'false' || setting === 'no' || setting === 'off' || isTruthy(env.DO_NOT_TRACK);
}

export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return telemetryOptedOut(env) || env.NODE_ENV === 'test' || env.VITEST !== undefined;
}

export function telemetryDisabledInAnyEnvironment(...environments: NodeJS.ProcessEnv[]): boolean {
  return environments.some((environment) => telemetryDisabled(environment));
}

export function isTelemetryEnabled(dataDir: string, env?: NodeJS.ProcessEnv): boolean {
  return !existsSync(telemetryDisabledFile(dataDir)) && !telemetryDisabled(env ?? process.env);
}

export function setTelemetryEnabled(dataDir: string, enabled: boolean): void {
  const file = telemetryDisabledFile(dataDir);
  if (enabled) rmSync(file, { force: true });
  else writeFileSync(file, 'disabled\n', { mode: 0o600 });
}

export function createTelemetry(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  client?: PostHogClient;
}): Telemetry {
  const env = options.env ?? process.env;
  let initialized: { client: PostHogClient; distinctId: string; transport?: PostHogTransport } | undefined;
  let initializationFailed = false;
  let activeActivities = 0;
  let shutdownPromise: Promise<void> | undefined;
  const idleWaiters = new Set<() => void>();
  let closed = false;

  function beginActivity(): () => void {
    if (closed || shutdownPromise) return () => {};
    activeActivities += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activeActivities -= 1;
      if (activeActivities !== 0) return;
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    };
  }

  function waitForIdle(): Promise<void> {
    if (activeActivities === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  function initialize(): typeof initialized {
    if (closed || initializationFailed || !isTelemetryEnabled(options.dataDir, env)) return undefined;
    if (initialized) return initialized;
    let transport: PostHogTransport | undefined;
    try {
      const distinctId = loadTelemetryId(options.dataDir);
      transport = options.client ? undefined : createPostHogTransport();
      const client =
        options.client ??
        new PostHog(env.FLUXMAIL_POSTHOG_KEY ?? POSTHOG_PROJECT_TOKEN, {
          host: env.FLUXMAIL_POSTHOG_HOST ?? POSTHOG_HOST,
          disableGeoip: true,
          flushAt: 20,
          flushInterval: 10_000,
          requestTimeout: POSTHOG_REQUEST_TIMEOUT_MS,
          fetchRetryCount: 0,
          fetch: transport?.fetch,
        });
      initialized = { client, distinctId, transport };
      return initialized;
    } catch {
      transport?.destroy();
      initializationFailed = true;
      return undefined;
    }
  }

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await waitForIdle();
      closed = true;
      if (!initialized) return;
      try {
        await initialized.client.shutdown(POSTHOG_SHUTDOWN_TIMEOUT_MS);
      } catch {
        // Network and analytics failures are intentionally ignored.
      } finally {
        initialized.transport?.destroy();
      }
    })();
    return shutdownPromise;
  };

  return {
    beginActivity,
    capture(event, properties = {}) {
      const telemetry = initialize();
      if (!telemetry) return;
      try {
        const commonProperties = {
          deployment_type: 'self_hosted',
          $process_person_profile: false,
          fluxmail_version: VERSION,
          node_version: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        };
        telemetry.client.capture({
          distinctId: telemetry.distinctId,
          event,
          disableGeoip: true,
          properties: {
            ...Object.fromEntries(Object.entries(properties).filter((entry) => entry[1] !== undefined)),
            ...commonProperties,
          },
        });
        if (
          event === OPERATION_TELEMETRY_EVENT &&
          properties.outcome === 'error' &&
          ['internal', 'provider_unavailable', 'request_timeout', 'uncertain', 'account_failure'].includes(
            String(properties.error_code),
          )
        ) {
          const surface = ['cli', 'mcp', 'rest'].includes(String(properties.product_surface))
            ? String(properties.product_surface)
            : 'unknown';
          const operation =
            typeof properties.operation === 'string' && /^[a-zA-Z0-9_ -]{1,100}$/.test(properties.operation)
              ? properties.operation
              : 'unknown';
          const code = String(properties.error_code);
          telemetry.client.capture({
            distinctId: telemetry.distinctId,
            event: '$exception',
            disableGeoip: true,
            properties: {
              ...commonProperties,
              product_surface: surface,
              operation,
              error_code: code,
              ...Object.fromEntries(
                FAILURE_PROPERTY_KEYS.flatMap((key) => (properties[key] === undefined ? [] : [[key, properties[key]]])),
              ),
              $exception_list: [
                { type: 'FluxmailOperationError', value: code, mechanism: { handled: true, synthetic: true } },
              ],
              $exception_fingerprint: `fluxmail:self_hosted:${surface}:${operation}:${code}`,
              $exception_level: 'error',
              $issue_name: `Fluxmail: ${operation} (${code})`,
            },
          });
        }
      } catch {
        // Telemetry must never affect Fluxmail behavior.
      }
    },
    shutdown,
  };
}

let sharedTelemetry: Telemetry | undefined;

interface EndEventSource {
  once(event: 'end', listener: () => void): unknown;
}

/** Flush queued telemetry when a long-running input stream reaches EOF. */
export function installTelemetryStreamEndHandler(
  stream: EndEventSource,
  shutdown: () => Promise<void> = shutdownTelemetry,
): void {
  stream.once('end', () => {
    // The MCP SDK starts request handlers in microtasks after consuming input.
    // Wait one turn so the final request can register as active before shutdown.
    setImmediate(() => void shutdown().catch(() => {}));
  });
}

export function getTelemetry(dataDir: string, env?: NodeJS.ProcessEnv): Telemetry {
  sharedTelemetry ??= createTelemetry({ dataDir, env });
  return sharedTelemetry;
}

export async function shutdownTelemetry(): Promise<void> {
  const telemetry = sharedTelemetry;
  await telemetry?.shutdown();
  if (sharedTelemetry === telemetry) sharedTelemetry = undefined;
}
