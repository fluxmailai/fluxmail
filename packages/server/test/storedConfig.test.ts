import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationService,
  deploymentToml,
  expandHome,
  readLoggingSettings,
  resolveDataDir,
  resolveDeploymentConfig,
  writeDeploymentConfig,
} from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { DEFAULT_GOOGLE_CLIENT_ID } from '../src/accounts/defaultGoogleOAuth.js';
import { DEFAULT_MICROSOFT_CLIENT_ID } from '../src/accounts/defaultMicrosoftOAuth.js';
import { accountCredentials, instanceSettings, openDb, oauthTokens } from '../src/storage/db.js';
import { addMember } from '../src/storage/members.js';
import { decryptString } from '../src/storage/crypto.js';

const DEFAULT_LICENSE_SERVER_URL = 'https://fluxmail.ai';
const runFile = promisify(execFile);
const deploymentConfigModuleUrl = new URL('../src/deploymentConfig.ts', import.meta.url).href;

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'fluxmail-config-'));
}

function resolve(dataDir: string, env: NodeJS.ProcessEnv = {}, options: { generateEncryptionKey?: boolean } = {}) {
  return resolveDeploymentConfig({
    env: { FLUXMAIL_DATA_DIR: dataDir, ...env },
    defaultLicenseServerUrl: DEFAULT_LICENSE_SERVER_URL,
    generateEncryptionKey: options.generateEncryptionKey ?? false,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('deployment configuration', () => {
  it('loads typed TOML values and records their source', () => {
    const dir = tempDataDir();
    writeDeploymentConfig(
      path.join(dir, 'config.toml'),
      deploymentToml({
        dbPath: '/tmp/mail.db',
        port: 9000,
        publicUrl: 'https://mail.example.com',
        trustProxy: true,
        oauthHost: '0.0.0.0',
        oauthPort: 9001,
        maxAttachmentMb: 20,
        logLevel: 'error',
        logDestination: 'file',
        licenseServerUrl: 'http://127.0.0.1:9898',
      }),
    );

    const config = resolve(dir);
    expect(config).toMatchObject({
      dbPath: '/tmp/mail.db',
      port: 9000,
      publicUrl: 'https://mail.example.com',
      trustProxy: true,
      oauthHost: '0.0.0.0',
      oauthPort: 9001,
      maxAttachmentBytes: 20 * 1024 * 1024,
      logLevel: 'error',
      logDestination: 'file',
      licenseServerUrl: 'http://127.0.0.1:9898',
    });
    expect(config.sources.port).toBe('toml');
    expect(config.sources.publicUrl).toBe('toml');
    expect(config.sources.logLevel).toBe('toml');
    expect(config.sources.logDestination).toBe('toml');
    expect(config.sources.licenseServerUrl).toBe('toml');
  });

  it('loads feedback settings from TOML and lets environment restrictions take priority', () => {
    const dir = tempDataDir();
    expect(resolve(dir)).toMatchObject({ feedbackEnabled: true, feedbackCloudOrigin: 'https://cloud.fluxmail.ai' });
    writeDeploymentConfig(
      path.join(dir, 'config.toml'),
      deploymentToml({ feedbackEnabled: true, feedbackCloudOrigin: 'http://localhost:3000/' }),
    );
    expect(resolve(dir)).toMatchObject({ feedbackEnabled: true, feedbackCloudOrigin: 'http://localhost:3000' });
    const config = resolve(dir, {
      FLUXMAIL_FEEDBACK_ENABLED: '0',
      FLUXMAIL_FEEDBACK_CLOUD_ORIGIN: 'https://feedback.example',
    });
    expect(config).toMatchObject({ feedbackEnabled: false, feedbackCloudOrigin: 'https://feedback.example' });
    expect(config.sources.feedbackEnabled).toBe('environment');
    expect(config.sources.feedbackCloudOrigin).toBe('environment');
    expect(() => resolve(dir, { FLUXMAIL_FEEDBACK_ENABLED: 'maybe' })).toThrow('FLUXMAIL_FEEDBACK_ENABLED');
    expect(() => resolve(dir, { FLUXMAIL_FEEDBACK_CLOUD_ORIGIN: 'https://user:secret@example.com' })).toThrow(
      'FLUXMAIL_FEEDBACK_CLOUD_ORIGIN',
    );
  });

  it('uses and validates local logging configuration', () => {
    const dir = tempDataDir();
    writeDeploymentConfig(path.join(dir, 'config.toml'), deploymentToml({ logLevel: 'warn', logDestination: 'file' }));
    expect(readLoggingSettings(dir)).toEqual({ level: 'warn', destination: 'file' });

    vi.stubEnv('FLUXMAIL_LOG_LEVEL', 'error');
    vi.stubEnv('FLUXMAIL_LOG_DESTINATION', 'console');
    expect(readLoggingSettings(dir)).toEqual({ level: 'error', destination: 'console' });

    vi.stubEnv('FLUXMAIL_LOG_LEVEL', 'debug');
    expect(() => readLoggingSettings(dir)).toThrow(/FLUXMAIL_LOG_LEVEL/);
    vi.stubEnv('FLUXMAIL_LOG_LEVEL', 'info');
    vi.stubEnv('FLUXMAIL_LOG_DESTINATION', 'network');
    expect(() => readLoggingSettings(dir)).toThrow(/FLUXMAIL_LOG_DESTINATION/);
  });

  it('lets environment values override TOML without mutating process.env', () => {
    const dir = tempDataDir();
    writeDeploymentConfig(path.join(dir, 'config.toml'), deploymentToml({ port: 9000 }));
    const before = process.env.FLUXMAIL_PORT;

    const config = resolve(dir, { FLUXMAIL_PORT: '9100' });

    expect(config.port).toBe(9100);
    expect(config.sources.port).toBe('environment');
    expect(process.env.FLUXMAIL_PORT).toBe(before);
  });

  it('does not load environment files from the working directory', () => {
    const cwd = tempDataDir();
    writeFileSync(
      path.join(cwd, '.env'),
      'FLUXMAIL_PORT=9100\nGOOGLE_CLIENT_ID=dotenv-id\nGOOGLE_CLIENT_SECRET=dotenv-secret\n',
    );
    writeFileSync(path.join(cwd, '.env.local'), 'FLUXMAIL_PORT=9200\n');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    const config = resolve(tempDataDir());

    expect(config.port).toBe(8977);
    expect(config.environment.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.environment.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it('does not read legacy config.env during normal resolution', () => {
    const dataDir = tempDataDir();
    writeFileSync(
      path.join(dataDir, 'config.env'),
      'FLUXMAIL_PORT=9100\nGOOGLE_CLIENT_ID=legacy-id\nGOOGLE_CLIENT_SECRET=legacy-secret\n',
    );

    const config = resolve(dataDir);

    expect(config.port).toBe(8977);
    expect(config.environment.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.environment.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it('resolves the data directory without parsing deployment configuration or encryption secrets', () => {
    const dataDir = tempDataDir();
    writeFileSync(path.join(dataDir, 'config.toml'), 'not valid toml');
    writeFileSync(path.join(dataDir, 'encryption.key'), 'not a valid key');

    expect(resolveDataDir({ env: { FLUXMAIL_DATA_DIR: dataDir } })).toBe(dataDir);
  });

  it('rejects unknown TOML keys and invalid values', () => {
    const unknownDir = tempDataDir();
    writeFileSync(path.join(unknownDir, 'config.toml'), '[server]\nunknown = true\n');
    expect(() => resolve(unknownDir)).toThrow(/Unknown setting "server.unknown"/);

    const invalidDir = tempDataDir();
    writeFileSync(path.join(invalidDir, 'config.toml'), '[server]\nport = "many"\n');
    expect(() => resolve(invalidDir)).toThrow(/integer between 1 and 65535/);
  });

  it.each([
    ['server', 'server = "invalid"\n'],
    ['storage', 'storage = []\n'],
    ['oauth.local', '[oauth]\nlocal = "invalid"\n'],
    ['logging', 'logging = "invalid"\n'],
  ])('rejects a non-table %s section', (section, content) => {
    const dir = tempDataDir();
    writeFileSync(path.join(dir, 'config.toml'), content);
    expect(() => resolve(dir)).toThrow(new RegExp(`"${section}" must be a TOML table`));
  });

  it('rejects blank database paths before opening SQLite', () => {
    expect(() => resolve(tempDataDir(), { FLUXMAIL_DB_PATH: '' })).toThrow(/FLUXMAIL_DB_PATH cannot be empty/);

    const tomlDir = tempDataDir();
    writeFileSync(path.join(tomlDir, 'config.toml'), '[storage]\ndatabase_path = ""\n');
    expect(() => resolve(tomlDir)).toThrow(/FLUXMAIL_DB_PATH cannot be empty/);
  });

  it('rejects blank local OAuth hosts', () => {
    expect(() => resolve(tempDataDir(), { FLUXMAIL_OAUTH_HOST: '' })).toThrow(/FLUXMAIL_OAUTH_HOST cannot be empty/);

    const tomlDir = tempDataDir();
    writeFileSync(path.join(tomlDir, 'config.toml'), '[oauth.local]\nhost = ""\n');
    expect(() => resolve(tomlDir)).toThrow(/FLUXMAIL_OAUTH_HOST cannot be empty/);
  });

  it('supports secret files, removes one terminal newline, and preserves external permissions', () => {
    const dir = tempDataDir();
    const secretFile = path.join(tempDataDir(), 'encryption-secret');
    const hex = 'ab'.repeat(32);
    writeFileSync(secretFile, `${hex}\n`, { mode: 0o644 });
    chmodSync(secretFile, 0o644);

    const config = resolve(dir, { FLUXMAIL_ENCRYPTION_KEY_FILE: secretFile });

    expect(config.encryptionKey.toString('hex')).toBe(hex);
    expect(config.sources.encryptionKey).toBe('environment-file');
    expect(statSync(secretFile).mode & 0o777).toBe(0o644);
  });

  it('rejects conflicting, relative, and empty secret-file inputs', () => {
    const dir = tempDataDir();
    expect(() =>
      resolve(dir, {
        FLUXMAIL_ENCRYPTION_KEY: 'ab'.repeat(32),
        FLUXMAIL_ENCRYPTION_KEY_FILE: '/tmp/key',
      }),
    ).toThrow(/only one/);
    expect(() => resolve(dir, { FLUXMAIL_ENCRYPTION_KEY_FILE: 'relative/key' })).toThrow(/absolute path/);

    const empty = path.join(tempDataDir(), 'empty');
    writeFileSync(empty, '');
    expect(() => resolve(dir, { FLUXMAIL_ENCRYPTION_KEY_FILE: empty })).toThrow(/empty file/);
  });

  it('writes config.toml with owner-only permissions and refuses overwrite', () => {
    const dir = tempDataDir();
    const file = path.join(dir, 'config.toml');
    writeDeploymentConfig(file, deploymentToml(), { exclusive: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => writeDeploymentConfig(file, deploymentToml(), { exclusive: true })).toThrow(/already exists/);
  });

  it('allows only one concurrent exclusive configuration write', async () => {
    const dir = tempDataDir();
    const file = path.join(dir, 'config.toml');
    const start = path.join(dir, 'start');
    const readyPrefix = path.join(dir, 'ready');
    const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { writeDeploymentConfig } from ${JSON.stringify(deploymentConfigModuleUrl)};
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      writeFileSync(process.argv[3] + '.' + process.argv[4], 'ready');
      while (!existsSync(process.argv[2])) Atomics.wait(waitArray, 0, 0, 5);
      try {
        writeDeploymentConfig(process.argv[1], process.argv[5], { exclusive: true });
      } catch (error) {
        if (error instanceof Error && error.message.includes('already exists')) process.exit(2);
        throw error;
      }
    `;
    const writers = Array.from({ length: 8 }, (_, index) =>
      runFile(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        file,
        start,
        readyPrefix,
        String(index),
        `[server]\nport = ${9_000 + index}\n`,
      ]),
    );

    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (readdirSync(dir).filter((name) => name.startsWith('ready.')).length === writers.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ready = readdirSync(dir).filter((name) => name.startsWith('ready.'));
    writeFileSync(start, 'start');
    expect(ready).toHaveLength(writers.length);

    const results = await Promise.allSettled(writers);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toMatch(/^\[server\]\nport = 900[0-7]\n$/);
    expect(existsSync(file)).toBe(true);
  });

  it.each([
    ['FLUXMAIL_PORT', 'not-a-number'],
    ['FLUXMAIL_PORT', '0'],
    ['FLUXMAIL_OAUTH_PORT', '65536'],
    ['FLUXMAIL_MAX_ATTACHMENT_MB', '26'],
  ])('rejects invalid %s values', (name, value) => {
    expect(() => resolve(tempDataDir(), { [name]: value })).toThrow();
  });

  it('validates and normalizes the public URL', () => {
    expect(resolve(tempDataDir(), { FLUXMAIL_PUBLIC_URL: 'https://mail.example.com/' }).publicUrl).toBe(
      'https://mail.example.com',
    );
    for (const value of [
      'not a url',
      'ftp://mail.example.com',
      'https://mail.example.com?tenant=one',
      'https://user:password@mail.example.com',
    ]) {
      expect(() => resolve(tempDataDir(), { FLUXMAIL_PUBLIC_URL: value })).toThrow(/FLUXMAIL_PUBLIC_URL/);
    }
  });

  it('expands a leading home marker in paths', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/.fluxmail')).toBe(path.join(homedir(), '.fluxmail'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('~user/x')).toBe('~user/x');
  });
});

describe('encrypted instance configuration', () => {
  it('uses the built-in Google app and requires complete environment groups', () => {
    const db = openDb(':memory:');
    const service = new ConfigurationService(resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '11'.repeat(32) }), db);
    expect(service.config.google?.clientId).toBe(DEFAULT_GOOGLE_CLIENT_ID);

    expect(
      () =>
        new ConfigurationService(
          resolve(tempDataDir(), {
            FLUXMAIL_ENCRYPTION_KEY: '11'.repeat(32),
            GOOGLE_CLIENT_ID: 'custom-id',
          }),
          openDb(':memory:'),
        ),
    ).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(
      () =>
        new ConfigurationService(
          resolve(tempDataDir(), {
            FLUXMAIL_ENCRYPTION_KEY: '11'.repeat(32),
            GOOGLE_CLIENT_SECRET: 'secret',
          }),
          openDb(':memory:'),
        ),
    ).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('treats blank OAuth and license placeholders as unset', () => {
    const service = new ConfigurationService(
      resolve(tempDataDir(), {
        FLUXMAIL_ENCRYPTION_KEY: '10'.repeat(32),
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        MICROSOFT_CLIENT_ID: '',
        MICROSOFT_CLIENT_SECRET: '',
        FLUXMAIL_LICENSE_KEY: '',
      }),
      openDb(':memory:'),
    );

    expect(service.config.google?.clientId).toBe(DEFAULT_GOOGLE_CLIENT_ID);
    expect(service.config.microsoft).toEqual({ clientId: DEFAULT_MICROSOFT_CLIENT_ID, tenantId: 'common' });
    expect(service.oauthStatus().outlook).toMatchObject({ source: 'built-in', clientSecretConfigured: false });
    expect(service.config.licenseKey).toBeUndefined();
  });

  it('encrypts complete provider groups and license state at rest and applies updates immediately', () => {
    const privateSecret = 'private-google-secret';
    const license = `fluxmail_lic_${'ab'.repeat(20)}`;
    const db = openDb(':memory:');
    const service = new ConfigurationService(resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '22'.repeat(32) }), db);

    service.setGoogle({ clientId: 'google-id', clientSecret: privateSecret });
    service.setMicrosoft({ clientId: 'microsoft-id', tenantId: 'common' });
    service.setLicenseKey(license);

    expect(service.config.google).toEqual({ clientId: 'google-id', clientSecret: privateSecret });
    expect(service.config.microsoft).toEqual({ clientId: 'microsoft-id', tenantId: 'common' });
    expect(service.config.licenseKey).toBe(license);
    const raw = db
      .select()
      .from(instanceSettings)
      .all()
      .map((row) => row.value);
    expect(raw.filter((value) => value.startsWith('v1:'))).toHaveLength(3);
    expect(JSON.stringify(raw)).not.toContain(privateSecret);
    expect(JSON.stringify(raw)).not.toContain(license);
  });

  it('pins existing Outlook refresh tokens to their current OAuth application before replacing it', () => {
    const deployment = resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '23'.repeat(32) });
    const db = openDb(':memory:');
    const service = new ConfigurationService(deployment, db);
    const original = { clientId: 'original-client', clientSecret: 'original-secret', tenantId: 'original-tenant' };
    service.setMicrosoft(original);
    const owner = addMember(db, { name: 'Owner' });
    const registry = new AccountRegistry(db, service.config);
    const account = registry.addOutlookAccount(
      'owner@example.com',
      { accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: 0, clientAuth: 'confidential' },
      undefined,
      owner.id,
    );

    service.setMicrosoft({
      clientId: 'replacement-client',
      clientSecret: 'replacement-secret',
      tenantId: 'replacement-tenant',
    });

    const credentialRow = db.select().from(accountCredentials).get()!;
    const stored = JSON.parse(decryptString(deployment.encryptionKey, credentialRow.encryptedCredentials));
    expect(stored.fluxmailOAuthClient).toEqual(original);
    expect(credentialRow.revision).toBe(2);
    expect(db.select().from(oauthTokens).get()).toMatchObject({
      encryptedTokens: credentialRow.encryptedCredentials,
      updatedAt: credentialRow.updatedAt,
    });

    service.resetMicrosoft();
    expect(service.config.microsoft?.clientId).toBe(DEFAULT_MICROSOFT_CLIENT_ID);
    expect(() => registry.getProvider(account.id)).not.toThrow();
  });

  it('round-trips encrypted settings and resets complete groups', () => {
    const deployment = resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '33'.repeat(32) });
    const db = openDb(':memory:');
    const first = new ConfigurationService(deployment, db);
    first.setGoogle({ clientId: 'id', clientSecret: 'secret' });

    const reopened = new ConfigurationService(deployment, db);
    expect(reopened.config.google).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(reopened.resetGoogle()).toBe(true);
    expect(reopened.oauthStatus().google.source).toBe('built-in');
  });

  it('reloads stored instance settings written through another database connection', () => {
    const deployment = resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '34'.repeat(32) });
    const firstDb = openDb(deployment.dbPath, { dataDir: deployment.dataDir });
    const secondDb = openDb(deployment.dbPath, { dataDir: deployment.dataDir });
    try {
      const running = new ConfigurationService(deployment, firstDb);
      const localCli = new ConfigurationService(deployment, secondDb);
      const license = `fluxmail_lic_${'ab'.repeat(20)}`;

      localCli.setGoogle({ clientId: 'local-cli-id', clientSecret: 'local-cli-secret' });
      localCli.setLicenseKey(license);

      expect(running.config.google).toEqual({ clientId: 'local-cli-id', clientSecret: 'local-cli-secret' });
      expect(running.oauthStatus().google.source).toBe('stored');
      expect(running.config.licenseKey).toBe(license);
      expect(running.licenseSource()).toBe('stored');

      localCli.resetGoogle();
      localCli.removeLicenseKey();

      expect(running.oauthStatus().google.source).toBe('built-in');
      expect(running.config.licenseKey).toBeUndefined();
    } finally {
      (firstDb as unknown as { $client: { close(): void } }).$client.close();
      (secondDb as unknown as { $client: { close(): void } }).$client.close();
    }
  });

  it('uses complete environment groups and prevents API changes while controlled', () => {
    const secretFile = path.join(tempDataDir(), 'google-secret');
    writeFileSync(secretFile, 'file-secret\n');
    const deployment = resolve(tempDataDir(), {
      FLUXMAIL_ENCRYPTION_KEY: '44'.repeat(32),
      GOOGLE_CLIENT_ID: 'environment-id',
      GOOGLE_CLIENT_SECRET_FILE: secretFile,
      MICROSOFT_CLIENT_ID: 'microsoft-id',
    });
    const service = new ConfigurationService(deployment, openDb(':memory:'));

    expect(service.config.google).toEqual({ clientId: 'environment-id', clientSecret: 'file-secret' });
    expect(service.config.microsoft).toEqual({ clientId: 'microsoft-id', tenantId: 'common' });
    expect(service.oauthStatus().google.source).toBe('environment-file');
    expect(() => service.setGoogle({ clientId: 'next', clientSecret: 'next-secret' })).toThrow(/environment/);
    expect(() => service.resetMicrosoft()).toThrow(/environment/);
  });

  it('supports license secret files and never exposes their path through status', () => {
    const file = path.join(tempDataDir(), 'license');
    const license = `fluxmail_lic_${'cd'.repeat(20)}`;
    writeFileSync(file, `${license}\n`);
    const service = new ConfigurationService(
      resolve(tempDataDir(), {
        FLUXMAIL_ENCRYPTION_KEY: '55'.repeat(32),
        FLUXMAIL_LICENSE_KEY_FILE: file,
      }),
      openDb(':memory:'),
    );
    expect(service.config.licenseKey).toBe(license);
    expect(JSON.stringify(service.oauthStatus())).not.toContain(file);
    expect(() => service.setLicenseKey(`fluxmail_lic_${'ef'.repeat(20)}`)).toThrow(/environment/);
  });

  it('fails safely when encrypted settings are opened with a different key', () => {
    const db = openDb(':memory:');
    const first = new ConfigurationService(resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '66'.repeat(32) }), db);
    first.setGoogle({ clientId: 'id', clientSecret: 'secret' });
    expect(
      () => new ConfigurationService(resolve(tempDataDir(), { FLUXMAIL_ENCRYPTION_KEY: '77'.repeat(32) }), db),
    ).toThrow(/decrypt/);
  });
});
