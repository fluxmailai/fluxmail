import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify, type TomlTable } from 'smol-toml';
import type { LogDestination, LogLevel } from './logging.js';
import { withFileLock } from './storage/fileLock.js';

export type ConfigSource =
  | 'default'
  | 'toml'
  | 'environment'
  | 'environment-file'
  | 'generated'
  | 'stored'
  | 'built-in';

export interface DeploymentConfig {
  dataDir: string;
  dbPath: string;
  encryptionKey: Buffer;
  port: number;
  publicUrl: string;
  publicUrlConfigured: boolean;
  trustProxy: boolean;
  oauthPort: number;
  oauthHost: string;
  maxAttachmentBytes: number;
  logLevel: LogLevel;
  logDestination: LogDestination;
  licenseServerUrl: string;
  configFile: string;
  environment: NodeJS.ProcessEnv;
  sources: Record<DeploymentSettingName, ConfigSource>;
}

export type DeploymentSettingName =
  | 'dataDir'
  | 'dbPath'
  | 'encryptionKey'
  | 'port'
  | 'publicUrl'
  | 'trustProxy'
  | 'oauthPort'
  | 'oauthHost'
  | 'maxAttachmentBytes'
  | 'logLevel'
  | 'logDestination'
  | 'licenseServerUrl';

export interface DeploymentReferenceEntry {
  canonicalName: string;
  env: string;
  toml?: string;
  type: 'boolean' | 'integer' | 'path' | 'secret' | 'string' | 'url';
  validation: string;
  defaultValue: string;
  description: string;
  secret?: boolean;
  documented?: boolean;
  restartRequired: true;
}

export const DEPLOYMENT_REFERENCE = {
  dataDir: {
    canonicalName: 'deployment.data_dir',
    env: 'FLUXMAIL_DATA_DIR',
    type: 'path',
    validation: 'Filesystem path',
    defaultValue: '~/.fluxmail (/data in Docker)',
    description: 'Directory for the SQLite database, deployment configuration, and generated encryption key.',
    restartRequired: true,
  },
  dbPath: {
    canonicalName: 'storage.database_path',
    env: 'FLUXMAIL_DB_PATH',
    toml: 'storage.database_path',
    type: 'path',
    validation: 'Non-empty filesystem path',
    defaultValue: '<data dir>/fluxmail.db',
    description: 'Override the SQLite database path.',
    restartRequired: true,
  },
  encryptionKey: {
    canonicalName: 'deployment.encryption_key',
    env: 'FLUXMAIL_ENCRYPTION_KEY',
    type: 'secret',
    validation: 'Exactly 64 hexadecimal characters',
    defaultValue: 'generated automatically',
    description: 'A 64-character hexadecimal key used to encrypt credentials and instance secrets.',
    secret: true,
    restartRequired: true,
  },
  port: {
    canonicalName: 'server.port',
    env: 'FLUXMAIL_PORT',
    toml: 'server.port',
    type: 'integer',
    validation: 'Integer from 1 through 65535',
    defaultValue: '8977',
    description: 'HTTP server port.',
    restartRequired: true,
  },
  publicUrl: {
    canonicalName: 'server.public_url',
    env: 'FLUXMAIL_PUBLIC_URL',
    toml: 'server.public_url',
    type: 'url',
    validation: 'HTTP or HTTPS URL without credentials, query, or fragment',
    defaultValue: 'http://localhost:<FLUXMAIL_PORT>',
    description:
      'Public base URL used for HTTP APIs, hosted OAuth callbacks, and MCP client sign-in. MCP OAuth requires HTTPS or a loopback address.',
    restartRequired: true,
  },
  trustProxy: {
    canonicalName: 'server.trust_proxy',
    env: 'FLUXMAIL_TRUST_PROXY',
    toml: 'server.trust_proxy',
    type: 'boolean',
    validation: 'Boolean',
    defaultValue: 'false',
    description: 'Trust forwarded protocol and client address headers from a reverse proxy.',
    restartRequired: true,
  },
  oauthPort: {
    canonicalName: 'oauth.local.port',
    env: 'FLUXMAIL_OAUTH_PORT',
    toml: 'oauth.local.port',
    type: 'integer',
    validation: 'Integer from 1 through 65535',
    defaultValue: '8976',
    description: 'Port for the local OAuth callback listener.',
    restartRequired: true,
  },
  oauthHost: {
    canonicalName: 'oauth.local.host',
    env: 'FLUXMAIL_OAUTH_HOST',
    toml: 'oauth.local.host',
    type: 'string',
    validation: 'Non-empty bind host or address',
    defaultValue: '127.0.0.1',
    description: 'Bind address for the local OAuth callback listener.',
    restartRequired: true,
  },
  maxAttachmentBytes: {
    canonicalName: 'server.max_attachment_mb',
    env: 'FLUXMAIL_MAX_ATTACHMENT_MB',
    toml: 'server.max_attachment_mb',
    type: 'integer',
    validation: 'Integer from 1 through 25',
    defaultValue: '10',
    description: 'Largest decoded attachment returned through MCP or REST, from 1 through 25 MB.',
    restartRequired: true,
  },
  logLevel: {
    canonicalName: 'logging.level',
    env: 'FLUXMAIL_LOG_LEVEL',
    toml: 'logging.level',
    type: 'string',
    validation: 'info, warn, error, or off',
    defaultValue: 'info',
    description: 'Minimum severity retained by the bounded local logger.',
    restartRequired: true,
  },
  logDestination: {
    canonicalName: 'logging.destination',
    env: 'FLUXMAIL_LOG_DESTINATION',
    toml: 'logging.destination',
    type: 'string',
    validation: 'both, file, or console',
    defaultValue: 'both',
    description: 'Write local logs to both the rotating file and console, or choose file or console.',
    restartRequired: true,
  },
  licenseServerUrl: {
    canonicalName: 'licensing.server_url',
    env: 'FLUXMAIL_LICENSE_SERVER_URL',
    toml: 'licensing.server_url',
    type: 'url',
    validation: 'HTTP or HTTPS URL',
    defaultValue: 'https://fluxmail.ai',
    description: 'License validation service override used for development and testing.',
    documented: false,
    restartRequired: true,
  },
} as const satisfies Record<DeploymentSettingName, DeploymentReferenceEntry>;

const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_STALE_MS = 30_000;
const BYTES_PER_MEGABYTE = 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * BYTES_PER_MEGABYTE;
export const HARD_MAX_ATTACHMENT_BYTES = 25 * BYTES_PER_MEGABYTE;

export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return value;
}

export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FLUXMAIL_DATA_DIR;
  return configured ? expandHome(configured) : path.join(homedir(), '.fluxmail');
}

function readToml(file: string): TomlTable {
  if (!existsSync(file)) return {};
  let parsed: TomlTable;
  try {
    parsed = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateTomlKeys(parsed, file);
  return parsed;
}

const ALLOWED_TOML_KEYS = new Set([
  'storage',
  'storage.database_path',
  'server',
  'server.port',
  'server.public_url',
  'server.trust_proxy',
  'server.max_attachment_mb',
  'oauth',
  'oauth.local',
  'oauth.local.host',
  'oauth.local.port',
  'logging',
  'logging.level',
  'logging.destination',
  'licensing',
  'licensing.server_url',
]);

const TOML_TABLE_KEYS = new Set(['storage', 'server', 'oauth', 'oauth.local', 'logging', 'licensing']);

function isTomlTable(value: unknown): value is TomlTable {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function validateTomlKeys(table: TomlTable, file: string, prefix = ''): void {
  for (const [key, value] of Object.entries(table)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (!ALLOWED_TOML_KEYS.has(dotted)) throw new Error(`Unknown setting "${dotted}" in ${file}`);
    const nested = isTomlTable(value);
    if (TOML_TABLE_KEYS.has(dotted) && !nested) throw new Error(`"${dotted}" must be a TOML table in ${file}`);
    if (nested) validateTomlKeys(value, file, dotted);
  }
}

function tomlValue(table: TomlTable, dotted: string): unknown {
  let value: unknown = table;
  for (const part of dotted.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function sourceValue(
  env: NodeJS.ProcessEnv,
  table: TomlTable,
  setting: DeploymentSettingName,
): { value: unknown; source: ConfigSource } {
  const reference: DeploymentReferenceEntry = DEPLOYMENT_REFERENCE[setting];
  if (env[reference.env] !== undefined) return { value: env[reference.env], source: 'environment' };
  const tomlName = reference.toml;
  const fromToml = tomlName ? tomlValue(table, tomlName) : undefined;
  if (fromToml !== undefined) return { value: fromToml, source: 'toml' };
  return { value: undefined, source: 'default' };
}

function stringValue(name: string, input: unknown, fallback: string): string {
  if (input === undefined) return fallback;
  if (typeof input !== 'string') throw new Error(`${name} must be a string`);
  return input;
}

function pathValue(name: string, input: unknown, fallback: string): string {
  return nonEmptyStringValue(name, input, fallback);
}

function nonEmptyStringValue(name: string, input: unknown, fallback: string): string {
  const value = stringValue(name, input, fallback);
  if (!value.trim()) throw new Error(`${name} cannot be empty.`);
  return value;
}

function portValue(name: string, input: unknown, fallback: number): number {
  if (input === undefined) return fallback;
  const value = typeof input === 'number' ? input : Number(input);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${String(input)}"`);
  }
  return value;
}

function booleanValue(name: string, input: unknown, fallback: boolean): boolean {
  if (input === undefined) return fallback;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
  }
  throw new Error(`${name} must be 0, 1, false, or true, got "${String(input)}"`);
}

function maxAttachmentValue(input: unknown): number {
  if (input === undefined) return DEFAULT_MAX_ATTACHMENT_BYTES;
  const value = typeof input === 'number' ? input : Number(input);
  const maximum = HARD_MAX_ATTACHMENT_BYTES / BYTES_PER_MEGABYTE;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`FLUXMAIL_MAX_ATTACHMENT_MB must be an integer between 1 and ${maximum}, got "${String(input)}"`);
  }
  return value * BYTES_PER_MEGABYTE;
}

function logLevelValue(input: unknown): LogLevel {
  const value = nonEmptyStringValue('FLUXMAIL_LOG_LEVEL', input, 'info').trim().toLowerCase();
  if (value !== 'info' && value !== 'warn' && value !== 'error' && value !== 'off') {
    throw new Error(`FLUXMAIL_LOG_LEVEL must be info, warn, error, or off, got "${value}"`);
  }
  return value;
}

function logDestinationValue(input: unknown): LogDestination {
  const value = nonEmptyStringValue('FLUXMAIL_LOG_DESTINATION', input, 'both').trim().toLowerCase();
  if (value !== 'both' && value !== 'file' && value !== 'console') {
    throw new Error(`FLUXMAIL_LOG_DESTINATION must be both, file, or console, got "${value}"`);
  }
  return value;
}

function publicUrlValue(input: unknown, port: number): string {
  const value = stringValue('FLUXMAIL_PUBLIC_URL', input, `http://localhost:${port}`).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`FLUXMAIL_PUBLIC_URL must be a valid HTTP or HTTPS URL, got "${value}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`FLUXMAIL_PUBLIC_URL must use HTTP or HTTPS, got "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password) throw new Error('FLUXMAIL_PUBLIC_URL cannot contain embedded credentials');
  if (parsed.search || parsed.hash) throw new Error('FLUXMAIL_PUBLIC_URL cannot contain a query string or fragment');
  return value;
}

export interface DeploymentTomlValues {
  dbPath?: string;
  port?: number;
  publicUrl?: string;
  trustProxy?: boolean;
  oauthPort?: number;
  oauthHost?: string;
  maxAttachmentMb?: number;
  logLevel?: LogLevel;
  logDestination?: LogDestination;
  licenseServerUrl?: string;
}

export function deploymentTomlValuesFromEnvironment(env: NodeJS.ProcessEnv): DeploymentTomlValues {
  const values: DeploymentTomlValues = {};
  if (env.FLUXMAIL_DB_PATH !== undefined) {
    values.dbPath = stringValue('FLUXMAIL_DB_PATH', env.FLUXMAIL_DB_PATH, '');
  }
  if (env.FLUXMAIL_PORT !== undefined) {
    values.port = portValue('FLUXMAIL_PORT', env.FLUXMAIL_PORT, 8977);
  }
  if (env.FLUXMAIL_PUBLIC_URL !== undefined) {
    values.publicUrl = publicUrlValue(env.FLUXMAIL_PUBLIC_URL, values.port ?? 8977);
  }
  if (env.FLUXMAIL_TRUST_PROXY !== undefined) {
    values.trustProxy = booleanValue('FLUXMAIL_TRUST_PROXY', env.FLUXMAIL_TRUST_PROXY, false);
  }
  if (env.FLUXMAIL_OAUTH_PORT !== undefined) {
    values.oauthPort = portValue('FLUXMAIL_OAUTH_PORT', env.FLUXMAIL_OAUTH_PORT, 8976);
  }
  if (env.FLUXMAIL_OAUTH_HOST !== undefined) {
    values.oauthHost = stringValue('FLUXMAIL_OAUTH_HOST', env.FLUXMAIL_OAUTH_HOST, '127.0.0.1');
  }
  if (env.FLUXMAIL_MAX_ATTACHMENT_MB !== undefined) {
    values.maxAttachmentMb = maxAttachmentValue(env.FLUXMAIL_MAX_ATTACHMENT_MB) / BYTES_PER_MEGABYTE;
  }
  if (env.FLUXMAIL_LOG_LEVEL !== undefined) {
    values.logLevel = logLevelValue(env.FLUXMAIL_LOG_LEVEL);
  }
  if (env.FLUXMAIL_LOG_DESTINATION !== undefined) {
    values.logDestination = logDestinationValue(env.FLUXMAIL_LOG_DESTINATION);
  }
  if (env.FLUXMAIL_LICENSE_SERVER_URL !== undefined) {
    values.licenseServerUrl = stringValue('FLUXMAIL_LICENSE_SERVER_URL', env.FLUXMAIL_LICENSE_SERVER_URL, '');
  }
  return values;
}

export function readSecretEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { blank?: 'error' | 'unset' } = {},
): { value?: string; source?: 'environment' | 'environment-file' } {
  const configuredDirect = env[name];
  const direct =
    options.blank === 'unset' && configuredDirect !== undefined && !configuredDirect.trim()
      ? undefined
      : configuredDirect;
  const file = env[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) {
    throw new Error(`Set only one of ${name} and ${name}_FILE`);
  }
  if (direct !== undefined) {
    if (!direct) throw new Error(`${name} cannot be empty`);
    return { value: direct, source: 'environment' };
  }
  if (file !== undefined) {
    if (!path.isAbsolute(file)) throw new Error(`${name}_FILE must be an absolute path`);
    let value: string;
    try {
      value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (error) {
      throw new Error(`Could not read ${name}_FILE: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!value) throw new Error(`${name}_FILE points to an empty file`);
    return { value, source: 'environment-file' };
  }
  return {};
}

function decodeEncryptionKey(value: string, message: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(message);
  return Buffer.from(value, 'hex');
}

function tryRestrictPermissions(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // The subsequent read or write reports actionable permission failures.
  }
}

function trySyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolveEncryptionKey(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  generateIfMissing: boolean,
): { value: Buffer; source: ConfigSource } {
  const configured = readSecretEnvironment(env, 'FLUXMAIL_ENCRYPTION_KEY');
  if (configured.value) {
    return {
      value: decodeEncryptionKey(
        configured.value,
        'FLUXMAIL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)',
      ),
      source: configured.source!,
    };
  }
  const keyPath = path.join(dataDir, 'encryption.key');
  if (existsSync(keyPath)) {
    tryRestrictPermissions(keyPath);
    return {
      value: decodeEncryptionKey(readFileSync(keyPath, 'utf8').trim(), `Corrupt encryption key at ${keyPath}`),
      source: 'stored',
    };
  }
  if (!generateIfMissing) return { value: Buffer.alloc(0), source: 'default' };
  return withFileLock(
    path.join(dataDir, '.encryption-key.lock'),
    {
      timeoutMs: CONFIG_LOCK_TIMEOUT_MS,
      staleMs: CONFIG_LOCK_STALE_MS,
      description: `the encryption key at ${keyPath}`,
    },
    () => {
      if (existsSync(keyPath)) {
        tryRestrictPermissions(keyPath);
        return {
          value: decodeEncryptionKey(readFileSync(keyPath, 'utf8').trim(), `Corrupt encryption key at ${keyPath}`),
          source: 'stored' as const,
        };
      }
      const value = randomBytes(32);
      const temporary = path.join(dataDir, `.encryption.key.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, `${value.toString('hex')}\n`, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, keyPath);
        trySyncDirectory(dataDir);
        return { value, source: 'generated' as const };
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        rmSync(temporary, { force: true });
      }
    },
  );
}

export function configTomlPath(dataDir: string): string {
  return path.join(dataDir, 'config.toml');
}

export function resolveDeploymentConfig(options: {
  env?: NodeJS.ProcessEnv;
  defaultLicenseServerUrl: string;
  generateEncryptionKey?: boolean;
}): DeploymentConfig {
  const baseEnvironment = options.env ?? process.env;
  const dataDirRaw = baseEnvironment.FLUXMAIL_DATA_DIR;
  const dataDir = resolveDataDirectory(baseEnvironment);
  mkdirSync(dataDir, { recursive: true });

  const environment: NodeJS.ProcessEnv = { ...baseEnvironment };
  const configFile = configTomlPath(dataDir);
  const table = readToml(configFile);
  const sources = {} as Record<DeploymentSettingName, ConfigSource>;
  sources.dataDir = dataDirRaw !== undefined ? 'environment' : 'default';

  const deploymentValue = (setting: DeploymentSettingName): unknown => {
    const resolved = sourceValue(environment, table, setting);
    sources[setting] = resolved.source;
    return resolved.value;
  };

  const dbRaw = pathValue('FLUXMAIL_DB_PATH', deploymentValue('dbPath'), path.join(dataDir, 'fluxmail.db'));
  const portNumber = portValue('FLUXMAIL_PORT', deploymentValue('port'), 8977);
  const publicUrl = deploymentValue('publicUrl');
  const trustProxy = deploymentValue('trustProxy');
  const oauthPort = deploymentValue('oauthPort');
  const oauthHost = deploymentValue('oauthHost');
  const maxAttachment = deploymentValue('maxAttachmentBytes');
  const logLevel = deploymentValue('logLevel');
  const logDestination = deploymentValue('logDestination');
  const licenseServer = deploymentValue('licenseServerUrl');

  const encryption = resolveEncryptionKey(dataDir, environment, options.generateEncryptionKey !== false);
  sources.encryptionKey = encryption.source;

  return {
    dataDir,
    dbPath: expandHome(dbRaw),
    encryptionKey: encryption.value,
    port: portNumber,
    publicUrl: publicUrlValue(publicUrl, portNumber),
    publicUrlConfigured: publicUrl !== undefined,
    trustProxy: booleanValue('FLUXMAIL_TRUST_PROXY', trustProxy, false),
    oauthPort: portValue('FLUXMAIL_OAUTH_PORT', oauthPort, 8976),
    oauthHost: nonEmptyStringValue('FLUXMAIL_OAUTH_HOST', oauthHost, '127.0.0.1'),
    maxAttachmentBytes: maxAttachmentValue(maxAttachment),
    logLevel: logLevelValue(logLevel),
    logDestination: logDestinationValue(logDestination),
    licenseServerUrl: stringValue(
      'FLUXMAIL_LICENSE_SERVER_URL',
      licenseServer,
      options.defaultLicenseServerUrl,
    ).replace(/\/+$/, ''),
    configFile,
    environment,
    sources,
  };
}

export function ensureDeploymentEncryptionKey(deployment: DeploymentConfig): DeploymentConfig {
  if (deployment.encryptionKey.length) return deployment;
  const encryption = resolveEncryptionKey(deployment.dataDir, deployment.environment, true);
  return {
    ...deployment,
    encryptionKey: encryption.value,
    sources: { ...deployment.sources, encryptionKey: encryption.source },
  };
}

export function deploymentToml(values: DeploymentTomlValues = {}): string {
  return stringify({
    storage: values.dbPath ? { database_path: values.dbPath } : {},
    server: {
      port: values.port ?? 8977,
      ...(values.publicUrl ? { public_url: values.publicUrl } : {}),
      trust_proxy: values.trustProxy ?? false,
      max_attachment_mb: values.maxAttachmentMb ?? 10,
    },
    oauth: { local: { host: values.oauthHost ?? '127.0.0.1', port: values.oauthPort ?? 8976 } },
    logging: { level: values.logLevel ?? 'info', destination: values.logDestination ?? 'both' },
    ...(values.licenseServerUrl ? { licensing: { server_url: values.licenseServerUrl } } : {}),
  });
}

export function writeDeploymentConfig(file: string, content: string, options: { exclusive?: boolean } = {}): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.config.toml.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (options.exclusive) {
      try {
        linkSync(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${file} already exists`);
        throw error;
      }
    } else {
      renameSync(temporary, file);
    }
    tryRestrictPermissions(file);
    trySyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
