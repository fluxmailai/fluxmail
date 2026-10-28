import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EmailError } from '@fluxmail/core';
import {
  deploymentToml,
  deploymentTomlValuesFromEnvironment,
  ensureDeploymentEncryptionKey,
  resolveDataDirectory,
  resolveDeploymentConfig,
  writeDeploymentConfig,
} from './deploymentConfig.js';
import { InstanceConfigStore, type StoredMicrosoftOAuthApp } from './instanceConfig.js';
import { DEFAULT_LICENSE_SERVER_URL } from './licensing/client.js';
import {
  IncompatibleStoreError,
  inspectStoreEncryptionKey,
  inspectStoreCompatibility,
  openDb,
  type FluxmailDb,
} from './storage/db.js';
import { withFileLock } from './storage/fileLock.js';
import { setTelemetryEnabled, telemetryOptedOut } from './telemetry.js';

const CONFIG_MIGRATION_LOCK_TIMEOUT_MS = 5 * 60_000;
const CONFIG_MIGRATION_LOCK_STALE_MS = 30 * 60_000;

const DEPLOYMENT_SETTING_NAMES = [
  'FLUXMAIL_DB_PATH',
  'FLUXMAIL_PORT',
  'FLUXMAIL_PUBLIC_URL',
  'FLUXMAIL_TRUST_PROXY',
  'FLUXMAIL_OAUTH_PORT',
  'FLUXMAIL_OAUTH_HOST',
  'FLUXMAIL_MAX_ATTACHMENT_MB',
  'FLUXMAIL_LICENSE_SERVER_URL',
  'FLUXMAIL_FEEDBACK_ENABLED',
  'FLUXMAIL_FEEDBACK_CLOUD_ORIGIN',
] as const;

const MIGRATION_SETTING_NAMES = new Set([
  ...DEPLOYMENT_SETTING_NAMES,
  'FLUXMAIL_DATA_DIR',
  'FLUXMAIL_ENCRYPTION_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'FLUXMAIL_LICENSE_KEY',
  'FLUXMAIL_TELEMETRY',
  'DO_NOT_TRACK',
]);

function unquoteEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' ? parsed : value.slice(1, -1);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function parseEnvValue(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return unquoteEnvValue(raw);
  }
  const quoted = raw.match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s+#/);
  if (quoted?.[1]) return unquoteEnvValue(quoted[1]);
  const comment = raw.search(/\s#/);
  return comment === -1 ? raw : raw.slice(0, comment).trimEnd();
}

export function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;
    const key = trimmed
      .slice(0, equals)
      .trim()
      .replace(/^export\s+/, '');
    if (key) out[key] = parseEnvValue(trimmed.slice(equals + 1).trim());
  }
  return out;
}

export function recognizedMigrationSettings(values: Record<string, string>): string[] {
  return Object.keys(values)
    .filter((name) => MIGRATION_SETTING_NAMES.has(name))
    .sort();
}

function optionalValue(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

interface InstanceMigrationValues {
  google?: { clientId: string; clientSecret: string };
  microsoft?: StoredMicrosoftOAuthApp;
  licenseKey?: string;
}

function instanceMigrationValues(values: Record<string, string>): InstanceMigrationValues {
  const googleClientId = values.GOOGLE_CLIENT_ID?.trim() || undefined;
  const googleClientSecret = optionalValue(values.GOOGLE_CLIENT_SECRET);
  if ((googleClientId || googleClientSecret) && (!googleClientId || !googleClientSecret)) {
    throw new EmailError('invalid_request', 'Google OAuth import requires both client ID and client secret.');
  }

  const microsoftClientId = values.MICROSOFT_CLIENT_ID?.trim() || undefined;
  const microsoftClientSecret = optionalValue(values.MICROSOFT_CLIENT_SECRET);
  const microsoftTenantId = values.MICROSOFT_TENANT_ID?.trim() || undefined;
  if ((microsoftClientId || microsoftClientSecret || microsoftTenantId) && !microsoftClientId) {
    throw new EmailError('invalid_request', 'Microsoft OAuth import requires a client ID.');
  }

  const licenseKey = values.FLUXMAIL_LICENSE_KEY?.trim() || undefined;
  const result: InstanceMigrationValues = {};
  if (googleClientId && googleClientSecret) {
    result.google = { clientId: googleClientId, clientSecret: googleClientSecret };
  }
  if (microsoftClientId) {
    result.microsoft = {
      clientId: microsoftClientId,
      tenantId: microsoftTenantId || 'common',
      ...(microsoftClientSecret ? { clientSecret: microsoftClientSecret } : {}),
    };
  }
  if (licenseKey) result.licenseKey = licenseKey;
  return result;
}

function importedEncryptionKey(values: Record<string, string>): string | undefined {
  const key = values.FLUXMAIL_ENCRYPTION_KEY?.trim() || undefined;
  if (key && !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new EmailError('invalid_request', 'FLUXMAIL_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
  }
  return key?.toLowerCase();
}

function migrationDeploymentEnvironment(values: Record<string, string>, dataDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, FLUXMAIL_DATA_DIR: dataDir };
  for (const name of DEPLOYMENT_SETTING_NAMES) {
    if (values[name] !== undefined) environment[name] = values[name];
  }
  if (
    process.env.FLUXMAIL_ENCRYPTION_KEY === undefined &&
    process.env.FLUXMAIL_ENCRYPTION_KEY_FILE === undefined &&
    values.FLUXMAIL_ENCRYPTION_KEY !== undefined
  ) {
    environment.FLUXMAIL_ENCRYPTION_KEY = values.FLUXMAIL_ENCRYPTION_KEY;
  }
  return environment;
}

function closeDb(db: FluxmailDb): void {
  (db as unknown as { $client: { close(): void } }).$client.close();
}

function importInstanceValues(store: InstanceConfigStore, values: InstanceMigrationValues, db: FluxmailDb): void {
  const sqlite = (
    db as unknown as {
      $client: { transaction<T>(operation: () => T): () => T };
    }
  ).$client;
  sqlite.transaction(() => {
    if (values.google) store.setGoogle(values.google);
    if (values.microsoft) store.setMicrosoft(values.microsoft);
    if (values.licenseKey) store.setLicenseKey(values.licenseKey);
  })();
}

export interface ConfigMigrationResult {
  source: string;
  recognized: string[];
}

function migrateConfigurationValues(
  source: string,
  values: Record<string, string>,
  dataDir: string,
): ConfigMigrationResult {
  const recognized = recognizedMigrationSettings(values);
  const deploymentValues = deploymentTomlValuesFromEnvironment(values);
  const hasDeploymentSettings = DEPLOYMENT_SETTING_NAMES.some((name) => values[name] !== undefined);
  const instanceValues = instanceMigrationValues(values);
  const hasInstanceSettings = Boolean(instanceValues.google || instanceValues.microsoft || instanceValues.licenseKey);
  const encryptionKey = importedEncryptionKey(values);

  const candidate = resolveDeploymentConfig({
    env: migrationDeploymentEnvironment(values, dataDir),
    defaultLicenseServerUrl: DEFAULT_LICENSE_SERVER_URL,
    generateEncryptionKey: false,
  });
  const compatibility = inspectStoreCompatibility(candidate.dbPath, candidate.dataDir);
  if (!compatibility.compatible) throw new IncompatibleStoreError(compatibility);
  if (hasDeploymentSettings && existsSync(candidate.configFile)) {
    throw new EmailError(
      'invalid_request',
      `${candidate.configFile} already exists. Move it aside before importing deployment settings.`,
    );
  }

  const keyFile = path.join(dataDir, 'encryption.key');
  const configFile = candidate.configFile;
  if (
    encryptionKey &&
    (process.env.FLUXMAIL_ENCRYPTION_KEY !== undefined || process.env.FLUXMAIL_ENCRYPTION_KEY_FILE !== undefined) &&
    candidate.encryptionKey.toString('hex') !== encryptionKey
  ) {
    throw new EmailError('invalid_request', 'The imported encryption key does not match the process override.');
  }
  if (encryptionKey && existsSync(keyFile)) {
    const storedKey = readFileSync(keyFile, 'utf8').trim().toLowerCase();
    if (storedKey !== encryptionKey) {
      throw new EmailError(
        'invalid_request',
        `The imported encryption key does not match ${keyFile}. Fluxmail did not change either file.`,
      );
    }
  }
  const encryptionKeyStatus = inspectStoreEncryptionKey(candidate.dbPath, candidate.encryptionKey);
  if (encryptionKeyStatus === 'mismatch') {
    if (!candidate.encryptionKey.length) {
      throw new EmailError(
        'invalid_request',
        'The target database contains encrypted values, but no encryption key was provided. Set FLUXMAIL_ENCRYPTION_KEY or FLUXMAIL_ENCRYPTION_KEY_FILE, or include FLUXMAIL_ENCRYPTION_KEY in the migration file.',
      );
    }
    throw new EmailError(
      'invalid_request',
      `The configured encryption key does not match the encrypted data in ${candidate.dbPath}. Fluxmail did not change any files.`,
    );
  }

  const keyExistedBefore = existsSync(keyFile);
  let createdConfig = false;
  let createdKey = false;
  try {
    if (encryptionKey && !existsSync(keyFile)) {
      writeFileSync(keyFile, `${encryptionKey}\n`, { flag: 'wx', mode: 0o600 });
      createdKey = true;
    }
    if (hasDeploymentSettings) {
      writeDeploymentConfig(configFile, deploymentToml(deploymentValues), { exclusive: true });
      createdConfig = true;
    }
    if (hasInstanceSettings) {
      const deployment = ensureDeploymentEncryptionKey(candidate);
      if (!keyExistedBefore && deployment.sources.encryptionKey === 'generated') createdKey = true;
      const db = openDb(deployment.dbPath, { dataDir });
      try {
        importInstanceValues(new InstanceConfigStore(db, deployment.encryptionKey), instanceValues, db);
      } finally {
        closeDb(db);
      }
    }
  } catch (error) {
    if (createdConfig) rmSync(configFile, { force: true });
    if (createdKey) rmSync(keyFile, { force: true });
    throw error;
  }

  if (telemetryOptedOut(values)) setTelemetryEnabled(dataDir, false);
  return { source, recognized };
}

export function migrateConfigurationFile(sourceFile: string): ConfigMigrationResult {
  const source = path.resolve(sourceFile);
  const values = parseEnvContent(readFileSync(source, 'utf8'));
  const dataDir = resolveDataDirectory({
    ...process.env,
    ...(values.FLUXMAIL_DATA_DIR !== undefined ? { FLUXMAIL_DATA_DIR: values.FLUXMAIL_DATA_DIR } : {}),
  });
  return withFileLock(
    path.join(dataDir, '.config-migration.lock'),
    {
      timeoutMs: CONFIG_MIGRATION_LOCK_TIMEOUT_MS,
      staleMs: CONFIG_MIGRATION_LOCK_STALE_MS,
      description: `configuration migration in ${dataDir}`,
    },
    () => migrateConfigurationValues(source, values, dataDir),
  );
}
