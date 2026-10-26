import { mkdirSync } from 'node:fs';
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_GOOGLE_CLIENT_SECRET } from './accounts/defaultGoogleOAuth.js';
import { DEFAULT_MICROSOFT_CLIENT_ID, DEFAULT_MICROSOFT_TENANT_ID } from './accounts/defaultMicrosoftOAuth.js';
import { DEFAULT_LICENSE_SERVER_URL } from './licensing/client.js';
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEPLOYMENT_REFERENCE,
  HARD_MAX_ATTACHMENT_BYTES,
  configTomlPath,
  deploymentToml,
  ensureDeploymentEncryptionKey,
  expandHome,
  readSecretEnvironment,
  resolveDataDirectory,
  resolveDeploymentConfig,
  writeDeploymentConfig,
  type ConfigSource,
  type DeploymentConfig,
  type DeploymentSettingName,
} from './deploymentConfig.js';
import { InstanceConfigStore, type StoredMicrosoftOAuthApp } from './instanceConfig.js';
import type { LogDestination, LogLevel } from './logging.js';
import type { FluxmailDb } from './storage/db.js';

export {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  HARD_MAX_ATTACHMENT_BYTES,
  configTomlPath,
  deploymentToml,
  ensureDeploymentEncryptionKey,
  expandHome,
  resolveDeploymentConfig,
  writeDeploymentConfig,
  type ConfigSource,
  type DeploymentConfig,
  type DeploymentSettingName,
};

export interface ConfigReferenceEntry {
  defaultValue: string;
  description: string;
  secret?: boolean;
  documented?: boolean;
  envFile?: boolean;
  category: 'deployment' | 'instance';
  toml?: string;
}

export type SettingMutability = 'immediate' | 'pre-database' | 'restart';

export interface SettingRegistryEntry {
  canonicalName: string;
  env: string;
  toml?: string;
  type: 'boolean' | 'integer' | 'path' | 'secret' | 'string' | 'url';
  validation: string;
  defaultValue: string;
  sensitive: boolean;
  mutability: SettingMutability;
  environmentRequiresRestart?: boolean;
  description: string;
  category: 'deployment' | 'instance';
  primaryStorage?: 'Data directory marker' | 'Encrypted SQLite' | 'External';
  envFile?: boolean;
  documented?: boolean;
}

const INSTANCE_SETTING_REGISTRY = {
  'oauth.google.client_id': {
    canonicalName: 'oauth.google.client_id',
    env: 'GOOGLE_CLIENT_ID',
    type: 'string',
    validation: 'Non-empty and paired with a Google client secret',
    defaultValue: 'Fluxmail Desktop OAuth app',
    sensitive: false,
    mutability: 'immediate',
    environmentRequiresRestart: true,
    description: 'Override the built-in Google OAuth client ID.',
    category: 'instance',
  },
  'oauth.google.client_secret': {
    canonicalName: 'oauth.google.client_secret',
    env: 'GOOGLE_CLIENT_SECRET',
    type: 'secret',
    validation: 'Non-empty and paired with a Google client ID',
    defaultValue: 'Fluxmail Desktop OAuth app',
    sensitive: true,
    mutability: 'immediate',
    environmentRequiresRestart: true,
    description: 'Override the built-in Google OAuth client secret. Required with GOOGLE_CLIENT_ID.',
    category: 'instance',
    envFile: true,
  },
  'oauth.microsoft.client_id': {
    canonicalName: 'oauth.microsoft.client_id',
    env: 'MICROSOFT_CLIENT_ID',
    type: 'string',
    validation: 'Non-empty when any Microsoft override is present',
    defaultValue: 'Fluxmail Self-Hosted Entra app',
    sensitive: false,
    mutability: 'immediate',
    environmentRequiresRestart: true,
    description: 'Override the built-in Microsoft Entra application client ID.',
    category: 'instance',
  },
  'oauth.microsoft.client_secret': {
    canonicalName: 'oauth.microsoft.client_secret',
    env: 'MICROSOFT_CLIENT_SECRET',
    type: 'secret',
    validation: 'Non-empty when configured',
    defaultValue: 'required for hosted Outlook connections',
    sensitive: true,
    mutability: 'immediate',
    environmentRequiresRestart: true,
    description: 'Microsoft Entra application client secret.',
    category: 'instance',
    envFile: true,
  },
  'oauth.microsoft.tenant_id': {
    canonicalName: 'oauth.microsoft.tenant_id',
    env: 'MICROSOFT_TENANT_ID',
    type: 'string',
    validation: 'Non-empty tenant ID or verified domain',
    defaultValue: 'common',
    sensitive: false,
    mutability: 'immediate',
    environmentRequiresRestart: true,
    description: 'Microsoft Entra tenant ID or verified domain.',
    category: 'instance',
  },
  'license.key': {
    canonicalName: 'license.key',
    env: 'FLUXMAIL_LICENSE_KEY',
    type: 'secret',
    validation: 'Fluxmail license key',
    defaultValue: 'none',
    sensitive: true,
    mutability: 'immediate',
    environmentRequiresRestart: true,
    description: 'Paid-plan license key, normally stored with fluxmail license activate.',
    category: 'instance',
    envFile: true,
  },
  'telemetry.enabled': {
    canonicalName: 'telemetry.enabled',
    env: 'FLUXMAIL_TELEMETRY',
    type: 'boolean',
    validation: '0, 1, false, true, no, off, or on',
    defaultValue: '1',
    sensitive: false,
    mutability: 'pre-database',
    description: 'Set to 0 to turn off anonymous CLI, MCP, and REST usage telemetry.',
    category: 'instance',
    primaryStorage: 'Data directory marker',
  },
  'telemetry.do_not_track': {
    canonicalName: 'telemetry.do_not_track',
    env: 'DO_NOT_TRACK',
    type: 'boolean',
    validation: 'Truthy value disables telemetry',
    defaultValue: 'unset',
    sensitive: false,
    mutability: 'pre-database',
    description: 'Set to 1 to turn off anonymous usage telemetry.',
    category: 'instance',
    primaryStorage: 'Data directory marker',
  },
} as const satisfies Record<string, SettingRegistryEntry>;

export const SETTING_REGISTRY: Record<string, SettingRegistryEntry> = {
  ...Object.fromEntries(
    Object.values(DEPLOYMENT_REFERENCE).map((entry) => [
      entry.canonicalName,
      {
        canonicalName: entry.canonicalName,
        env: entry.env,
        ...('toml' in entry && entry.toml ? { toml: entry.toml } : {}),
        type: entry.type,
        validation: entry.validation,
        defaultValue: entry.defaultValue,
        sensitive: 'secret' in entry && entry.secret === true,
        mutability: 'restart' as const,
        description: entry.description,
        category: 'deployment' as const,
        ...('secret' in entry && entry.secret ? { envFile: true } : {}),
        ...('documented' in entry && entry.documented === false ? { documented: false } : {}),
      },
    ]),
  ),
  ...INSTANCE_SETTING_REGISTRY,
};

export const CONFIG_REFERENCE = Object.fromEntries(
  Object.values(SETTING_REGISTRY).map((entry) => [
    entry.env,
    {
      defaultValue: entry.defaultValue,
      description: entry.description,
      category: entry.category,
      ...(entry.sensitive ? { secret: true } : {}),
      ...(entry.envFile ? { envFile: true } : {}),
      ...(entry.toml ? { toml: entry.toml } : {}),
      ...(entry.documented === false ? { documented: false } : {}),
    },
  ]),
) as Record<string, ConfigReferenceEntry>;

export interface FluxmailConfig {
  dataDir: string;
  dbPath: string;
  encryptionKey: Buffer;
  port: number;
  publicUrl: string;
  publicUrlConfigured?: boolean;
  trustProxy?: boolean;
  oauthPort: number;
  oauthHost: string;
  maxAttachmentBytes: number;
  logLevel: LogLevel;
  logDestination: LogDestination;
  licenseKey?: string;
  licenseKeyFromEnvironment?: boolean;
  licenseServerUrl: string;
  google?: {
    clientId: string;
    clientSecret: string;
  };
  microsoft?: {
    clientId: string;
    clientSecret?: string;
    tenantId: string;
  };
}

export interface FluxmailStoreLocation {
  dataDir: string;
  dbPath: string;
  deployment?: DeploymentConfig;
}

export type OAuthAppSource = 'built-in' | 'stored' | 'environment' | 'environment-file';

export interface OAuthAppStatus {
  google: {
    clientId: string;
    clientSecretConfigured: true;
    source: OAuthAppSource;
    mutable: boolean;
  };
  outlook: {
    clientId: string;
    tenantId: string;
    clientSecretConfigured: boolean;
    source: OAuthAppSource;
    mutable: boolean;
  };
}

export class EnvironmentControlledSettingError extends Error {
  readonly code = 'environment_controlled';
}

function readOptionalSecretEnvironment(env: NodeJS.ProcessEnv, name: string): ReturnType<typeof readSecretEnvironment> {
  return readSecretEnvironment(env, name, { blank: 'unset' });
}

type EnvironmentSource = 'environment' | 'environment-file';

interface EnvironmentOverride<T> {
  value?: T;
  source?: EnvironmentSource;
  controlled: boolean;
}

function environmentGoogle(env: NodeJS.ProcessEnv): EnvironmentOverride<{
  clientId: string;
  clientSecret: string;
}> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const secret = readOptionalSecretEnvironment(env, 'GOOGLE_CLIENT_SECRET');
  const controlled = Boolean(clientId) || secret.value !== undefined;
  if (!controlled) return { controlled: false };
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is required when Google OAuth environment overrides are used.');
  if (!secret.value) {
    throw new Error('GOOGLE_CLIENT_SECRET or GOOGLE_CLIENT_SECRET_FILE is required with GOOGLE_CLIENT_ID.');
  }
  return {
    value: { clientId, clientSecret: secret.value },
    source: secret.source === 'environment-file' ? 'environment-file' : 'environment',
    controlled: true,
  };
}

function environmentMicrosoft(env: NodeJS.ProcessEnv): EnvironmentOverride<StoredMicrosoftOAuthApp> {
  const clientId = env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = readOptionalSecretEnvironment(env, 'MICROSOFT_CLIENT_SECRET');
  const tenantId = env.MICROSOFT_TENANT_ID?.trim();
  const controlled = Boolean(clientId) || Boolean(tenantId) || clientSecret.value !== undefined;
  if (!controlled) return { controlled: false };
  if (!clientId) {
    throw new Error('MICROSOFT_CLIENT_ID is required when Microsoft OAuth environment overrides are used.');
  }
  return {
    value: {
      clientId,
      tenantId: tenantId || 'common',
      ...(clientSecret.value ? { clientSecret: clientSecret.value } : {}),
    },
    source: clientSecret.source === 'environment-file' ? 'environment-file' : 'environment',
    controlled: true,
  };
}

function environmentLicense(env: NodeJS.ProcessEnv): EnvironmentOverride<string> {
  const configured = readOptionalSecretEnvironment(env, 'FLUXMAIL_LICENSE_KEY');
  return { value: configured.value?.trim(), source: configured.source, controlled: configured.value !== undefined };
}

const BUILT_IN_MICROSOFT_OAUTH_APP = {
  clientId: DEFAULT_MICROSOFT_CLIENT_ID,
  tenantId: DEFAULT_MICROSOFT_TENANT_ID,
} as const satisfies StoredMicrosoftOAuthApp;

function baseConfigFromDeployment(deployment: DeploymentConfig): FluxmailConfig {
  return {
    dataDir: deployment.dataDir,
    dbPath: deployment.dbPath,
    encryptionKey: deployment.encryptionKey,
    port: deployment.port,
    publicUrl: deployment.publicUrl,
    publicUrlConfigured: deployment.publicUrlConfigured,
    trustProxy: deployment.trustProxy,
    oauthPort: deployment.oauthPort,
    oauthHost: deployment.oauthHost,
    maxAttachmentBytes: deployment.maxAttachmentBytes,
    logLevel: deployment.logLevel,
    logDestination: deployment.logDestination,
    licenseServerUrl: deployment.licenseServerUrl,
  };
}

function configFromDeployment(deployment: DeploymentConfig): FluxmailConfig {
  const google = environmentGoogle(deployment.environment);
  const microsoft = environmentMicrosoft(deployment.environment);
  const license = environmentLicense(deployment.environment);
  return {
    ...baseConfigFromDeployment(deployment),
    google: google.value ?? { clientId: DEFAULT_GOOGLE_CLIENT_ID, clientSecret: DEFAULT_GOOGLE_CLIENT_SECRET },
    microsoft: microsoft.value ?? { ...BUILT_IN_MICROSOFT_OAUTH_APP },
    ...(license.value ? { licenseKey: license.value, licenseKeyFromEnvironment: true } : {}),
  };
}

export function resolveDataDir(options: { env?: NodeJS.ProcessEnv } = {}): string {
  const dataDir = resolveDataDirectory(options.env);
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function readLoggingSettings(dataDir = resolveDataDir()): { level: LogLevel; destination: LogDestination } {
  const deployment = resolveDeploymentConfig({
    env: { ...process.env, FLUXMAIL_DATA_DIR: dataDir },
    defaultLicenseServerUrl: DEFAULT_LICENSE_SERVER_URL,
    generateEncryptionKey: false,
  });
  return { level: deployment.logLevel, destination: deployment.logDestination };
}

export function resolveStoreLocation(options: { env?: NodeJS.ProcessEnv } = {}): FluxmailStoreLocation {
  const deployment = resolveDeploymentConfig({
    ...options,
    defaultLicenseServerUrl: DEFAULT_LICENSE_SERVER_URL,
    generateEncryptionKey: false,
  });
  return { dataDir: deployment.dataDir, dbPath: deployment.dbPath, deployment };
}

export function loadConfig(storeLocation?: FluxmailStoreLocation): FluxmailConfig {
  const initial = storeLocation?.deployment;
  const deployment = initial
    ? ensureDeploymentEncryptionKey(initial)
    : resolveDeploymentConfig({
        env: {
          ...process.env,
          ...(storeLocation?.dataDir ? { FLUXMAIL_DATA_DIR: storeLocation.dataDir } : {}),
          ...(storeLocation?.dbPath ? { FLUXMAIL_DB_PATH: storeLocation.dbPath } : {}),
        },
        defaultLicenseServerUrl: DEFAULT_LICENSE_SERVER_URL,
        generateEncryptionKey: true,
      });
  return configFromDeployment(deployment);
}

export class ConfigurationService {
  readonly store: InstanceConfigStore;
  readonly config: FluxmailConfig;
  private readonly googleEnvironment: ReturnType<typeof environmentGoogle>;
  private readonly microsoftEnvironment: ReturnType<typeof environmentMicrosoft>;
  private readonly licenseEnvironment: ReturnType<typeof environmentLicense>;
  private currentGoogle!: NonNullable<FluxmailConfig['google']>;
  private currentMicrosoft!: NonNullable<FluxmailConfig['microsoft']>;
  private currentLicenseKey: string | undefined;
  private observedDataVersion = -1;
  private googleSource: OAuthAppSource = 'built-in';
  private microsoftSource: OAuthAppSource = 'built-in';
  private currentLicenseSource: EnvironmentSource | 'stored' | null = null;

  constructor(
    readonly deployment: DeploymentConfig,
    db: FluxmailDb,
  ) {
    this.store = new InstanceConfigStore(db, deployment.encryptionKey);
    this.googleEnvironment = environmentGoogle(deployment.environment);
    this.microsoftEnvironment = environmentMicrosoft(deployment.environment);
    this.licenseEnvironment = environmentLicense(deployment.environment);
    const config = baseConfigFromDeployment(deployment);
    Object.defineProperties(config, {
      google: {
        enumerable: true,
        get: () => {
          this.refreshIfChanged();
          return this.currentGoogle;
        },
      },
      microsoft: {
        enumerable: true,
        get: () => {
          this.refreshIfChanged();
          return this.currentMicrosoft;
        },
      },
      licenseKey: {
        enumerable: true,
        get: () => {
          this.refreshIfChanged();
          return this.currentLicenseKey;
        },
      },
      licenseKeyFromEnvironment: {
        enumerable: true,
        value: this.licenseEnvironment.controlled,
      },
    });
    this.config = config;
    this.reload();
  }

  private refreshIfChanged(): void {
    if (this.store.dataVersion() !== this.observedDataVersion) this.reload();
  }

  reload(): FluxmailConfig {
    while (true) {
      const dataVersion = this.store.dataVersion();
      const storedGoogle = this.googleEnvironment.controlled ? undefined : this.store.google();
      const storedMicrosoft = this.microsoftEnvironment.controlled ? undefined : this.store.microsoft();
      const storedLicense = this.licenseEnvironment.controlled ? undefined : this.store.licenseKey();
      if (this.store.dataVersion() !== dataVersion) continue;

      this.currentGoogle = this.googleEnvironment.value ??
        storedGoogle ?? { clientId: DEFAULT_GOOGLE_CLIENT_ID, clientSecret: DEFAULT_GOOGLE_CLIENT_SECRET };
      this.googleSource = this.googleEnvironment.source ?? (storedGoogle ? 'stored' : 'built-in');
      this.currentMicrosoft = this.microsoftEnvironment.value ?? storedMicrosoft ?? { ...BUILT_IN_MICROSOFT_OAUTH_APP };
      this.microsoftSource = this.microsoftEnvironment.source ?? (storedMicrosoft ? 'stored' : 'built-in');
      this.currentLicenseKey = this.licenseEnvironment.value ?? storedLicense;
      this.currentLicenseSource = this.licenseEnvironment.source ?? (storedLicense ? 'stored' : null);
      this.observedDataVersion = dataVersion;
      return this.config;
    }
  }

  oauthStatus(): OAuthAppStatus {
    this.refreshIfChanged();
    return {
      google: {
        clientId: this.currentGoogle.clientId,
        clientSecretConfigured: true,
        source: this.googleSource,
        mutable: !this.googleEnvironment.controlled,
      },
      outlook: {
        clientId: this.currentMicrosoft.clientId,
        tenantId: this.currentMicrosoft.tenantId,
        clientSecretConfigured: Boolean(this.currentMicrosoft.clientSecret),
        source: this.microsoftSource,
        mutable: !this.microsoftEnvironment.controlled,
      },
    };
  }

  licenseSource(): 'environment' | 'environment-file' | 'stored' | null {
    this.refreshIfChanged();
    return this.currentLicenseSource;
  }

  setGoogle(value: { clientId: string; clientSecret: string }): void {
    if (this.googleEnvironment.controlled) {
      throw new EnvironmentControlledSettingError(
        'Google OAuth is controlled by environment variables and cannot be changed through the API.',
      );
    }
    this.store.setGoogle(value);
    this.reload();
  }

  resetGoogle(): boolean {
    if (this.googleEnvironment.controlled) {
      throw new EnvironmentControlledSettingError(
        'Google OAuth is controlled by environment variables and cannot be changed through the API.',
      );
    }
    const removed = this.store.removeGoogle();
    this.reload();
    return removed;
  }

  setMicrosoft(value: StoredMicrosoftOAuthApp): void {
    if (this.microsoftEnvironment.controlled) {
      throw new EnvironmentControlledSettingError(
        'Microsoft OAuth is controlled by environment variables and cannot be changed through the API.',
      );
    }
    this.pinCurrentMicrosoftOAuthApp();
    this.store.setMicrosoft(value);
    this.reload();
  }

  resetMicrosoft(): boolean {
    if (this.microsoftEnvironment.controlled) {
      throw new EnvironmentControlledSettingError(
        'Microsoft OAuth is controlled by environment variables and cannot be changed through the API.',
      );
    }
    this.pinCurrentMicrosoftOAuthApp();
    const removed = this.store.removeMicrosoft();
    this.reload();
    return removed;
  }

  /**
   * Accounts saved before credentials recorded their Entra app rely on the
   * configured one, so keep them on it before the configuration changes. Those
   * accounts always used a custom app, never the built-in one.
   */
  private pinCurrentMicrosoftOAuthApp(): void {
    this.refreshIfChanged();
    if (this.microsoftSource !== 'built-in') this.store.pinMicrosoftOAuthAppForAccounts(this.currentMicrosoft);
  }

  setLicenseKey(value: string): void {
    if (this.licenseEnvironment.controlled) {
      throw new EnvironmentControlledSettingError(
        'The license is controlled by the environment and cannot be changed through the API.',
      );
    }
    this.store.setLicenseKey(value);
    this.reload();
  }

  removeLicenseKey(): boolean {
    if (this.licenseEnvironment.controlled) {
      throw new EnvironmentControlledSettingError(
        'The license is controlled by the environment and cannot be changed through the API.',
      );
    }
    const removed = this.store.removeLicenseKey();
    this.reload();
    return removed;
  }
}

export function createConfigurationService(deployment: DeploymentConfig, db: FluxmailDb): ConfigurationService {
  return new ConfigurationService(deployment, db);
}
