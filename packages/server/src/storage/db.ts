import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { VERSION } from '../version.js';
import { decryptString } from './crypto.js';
import { withFileLock } from './fileLock.js';

export const CURRENT_STORE_FORMAT = 7;
export const MIN_SUPPORTED_STORE_FORMAT = 1;
export const MAX_SUPPORTED_STORE_FORMAT = CURRENT_STORE_FORMAT;
export const LEGACY_STORE_FORMAT = 0;

const MIGRATION_LOCK_TIMEOUT_MS = 5 * 60_000;
const MIGRATION_LOCK_STALE_MS = 30 * 60_000;

export interface StoreCompatibility {
  engineVersion: string;
  dataDir: string;
  dbPath: string;
  storeFormat: number;
  minimumSupportedFormat: number;
  maximumSupportedFormat: number;
  compatible: boolean;
  requiresMigration: boolean;
}

export class IncompatibleStoreError extends Error {
  readonly code = 'incompatible_store';

  constructor(readonly compatibility: StoreCompatibility) {
    const supportedFormats =
      compatibility.minimumSupportedFormat === compatibility.maximumSupportedFormat
        ? `format ${compatibility.minimumSupportedFormat}`
        : `formats ${compatibility.minimumSupportedFormat} through ${compatibility.maximumSupportedFormat}`;
    const action =
      compatibility.storeFormat > compatibility.maximumSupportedFormat
        ? 'Update Fluxmail'
        : 'Use a Fluxmail version that supports this store';
    super(
      `This Fluxmail data uses store format ${compatibility.storeFormat}, but Fluxmail ${compatibility.engineVersion} supports ${supportedFormats}. ${action} before opening ${compatibility.dataDir}. Fluxmail did not change the store.`,
    );
    this.name = 'IncompatibleStoreError';
  }
}

export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email'),
    role: text('role').notNull().default('member'),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('members_email_unique').on(table.email)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    /** Transitional nulls only exist until a migrated installation claims its first administrator. */
    ownerMemberId: text('member_id').references(() => members.id, { onDelete: 'restrict' }),
    sharedWithAll: integer('shared_with_all', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [uniqueIndex('accounts_provider_email_unique').on(table.provider, table.email)],
);

export const accountMemberGrants = sqliteTable(
  'account_member_grants',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.memberId] })],
);

export const oauthTokens = sqliteTable('oauth_tokens', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** AES-256-GCM encrypted JSON blob of provider tokens. */
  encryptedTokens: text('encrypted_tokens').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const accountCredentials = sqliteTable('account_credentials', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** AES-256-GCM encrypted provider-specific credentials. */
  encryptedCredentials: text('encrypted_credentials').notNull(),
  updatedAt: integer('updated_at').notNull(),
  revision: integer('revision').notNull().default(1),
});

export const accountSendAs = sqliteTable(
  'account_send_as',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name'),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.email] })],
);

export const imapMessages = sqliteTable(
  'imap_messages',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    mailboxPath: text('mailbox_path').notNull(),
    uidValidity: text('uid_validity').notNull(),
    uid: integer('uid').notNull(),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('reference_ids'),
    threadId: text('thread_id').notNull(),
    draftId: text('draft_id'),
    subject: text('subject'),
    date: text('date'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('imap_messages_location_unique').on(table.accountId, table.mailboxPath, table.uidValidity, table.uid),
    index('imap_messages_message_id').on(table.accountId, table.messageId),
    index('imap_messages_thread_id').on(table.accountId, table.threadId),
    uniqueIndex('imap_messages_draft_id_unique').on(table.accountId, table.draftId),
  ],
);

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** SHA-256 hex of the key; the key itself is shown once at creation. */
  keyHash: text('key_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  /** Member the key was issued to. */
  memberId: text('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  /** Named MCP permission profile, or "custom" when customCapabilities is populated. */
  permissionProfile: text('permission_profile').notNull().default('full'),
  /** JSON array of explicit MCP capabilities for custom policies. */
  customCapabilities: text('custom_capabilities'),
  /** JSON array of admin capabilities added to a named mail profile. */
  supplementalCapabilities: text('supplemental_capabilities').notNull().default('[]'),
  /** NULL means no extra narrowing; otherwise a JSON array of canonical account ids. */
  accountIds: text('account_ids'),
});

export const memberCredentials = sqliteTable('member_credentials', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => members.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  passwordVersion: integer('password_version').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
});

export const memberSessions = sqliteTable(
  'member_sessions',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    deviceName: text('device_name').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [index('member_sessions_member').on(table.memberId), index('member_sessions_expiry').on(table.expiresAt)],
);

export const memberAuthTokens = sqliteTable(
  'member_auth_tokens',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdByMemberId: text('created_by_member_id').references(() => members.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (table) => [
    index('member_auth_tokens_member').on(table.memberId),
    index('member_auth_tokens_expiry').on(table.expiresAt),
  ],
);

export const authRateLimits = sqliteTable(
  'auth_rate_limits',
  {
    key: text('key').primaryKey(),
    attempts: integer('attempts').notNull(),
    windowStartedAt: integer('window_started_at').notNull(),
  },
  (table) => [index('auth_rate_limits_window').on(table.windowStartedAt)],
);

export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const adminAuditEvents = sqliteTable(
  'admin_audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: integer('timestamp').notNull(),
    operation: text('operation').notNull(),
    outcome: text('outcome').notNull(),
    actorKeyId: text('actor_key_id'),
    actorSessionId: text('actor_session_id'),
    actorMemberId: text('actor_member_id'),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    errorCode: text('error_code'),
  },
  (table) => [index('admin_audit_events_timestamp').on(table.timestamp)],
);

export const gmailConnectionGrants = sqliteTable('gmail_connection_grants', {
  /** SHA-256 hex digest. The raw token is printed once and never stored. */
  tokenHash: text('token_hash').primaryKey(),
  scope: text('scope').notNull(),
  ownerMemberId: text('owner_member_id'),
  reauthorizeAccountId: text('reauthorize_account_id'),
  sharedWithAll: integer('shared_with_all', { mode: 'boolean' }),
  grantedMemberIds: text('granted_member_ids'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
});

export const licenseLease = sqliteTable('license_lease', {
  /** Single-row table; the row id is always 'current'. */
  id: text('id').primaryKey(),
  /** Signed entitlement lease exactly as issued by the license server. */
  token: text('token').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const scheduledSends = sqliteTable(
  'scheduled_sends',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    draftId: text('draft_id').notNull(),
    /** Epoch milliseconds. */
    sendAt: integer('send_at').notNull(),
    createdAt: integer('created_at').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull().default(0),
    lastError: text('last_error'),
    sentMessageId: text('sent_message_id'),
    sentThreadId: text('sent_thread_id'),
    /** Display snapshots taken at schedule time so listing never hits the provider. */
    subject: text('subject'),
    toRecipients: text('to_recipients'),
    claimToken: text('claim_token'),
    claimUntil: integer('claim_until'),
  },
  (table) => [index('scheduled_sends_pending_due').on(table.status, table.sendAt)],
);

export const restIdempotency = sqliteTable(
  'rest_idempotency',
  {
    principalId: text('principal_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.principalId, table.idempotencyKey] }),
    index('rest_idempotency_expires_at').on(table.expiresAt),
  ],
);

export const deliveryOperations = sqliteTable(
  'delivery_operations',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id').notNull(),
    memberId: text('member_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    accountId: text('account_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    resultJson: text('result_json'),
    errorCode: text('error_code'),
    scheduleId: text('schedule_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('delivery_operations_principal_key').on(table.principalId, table.idempotencyKey),
    index('delivery_operations_account').on(table.accountId),
    uniqueIndex('delivery_operations_schedule').on(table.scheduleId),
  ],
);

// MCP OAuth clients. Mailbox provider tokens use the unrelated oauth_tokens table.
export const mcpOauthClients = sqliteTable(
  'mcp_oauth_clients',
  {
    /** Random id for registered clients, or the HTTPS URL of a client metadata document. */
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** JSON array of exact redirect URIs. */
    redirectUris: text('redirect_uris').notNull(),
    /** JSON array of the mail scopes the client may request. */
    scopes: text('scopes').notNull(),
    /** Lowercase host of a metadata document client. */
    metadataHost: text('metadata_host'),
    /** When a metadata document client should be fetched again. */
    metadataExpiresAt: integer('metadata_expires_at'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (table) => [index('mcp_oauth_clients_host').on(table.metadataHost)],
);

export const mcpOauthGrants = sqliteTable(
  'mcp_oauth_grants',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpOauthClients.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** JSON array of approved mail scopes. */
    scopes: text('scopes').notNull(),
    /** NULL means every mailbox available to the member; otherwise a JSON array of account ids. */
    accountIds: text('account_ids'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [index('mcp_oauth_grants_member').on(table.memberId), index('mcp_oauth_grants_client').on(table.clientId)],
);

export const mcpOauthCodes = sqliteTable(
  'mcp_oauth_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    /** JSON array of token scopes, which may include offline_access. */
    scopes: text('scopes').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
  },
  (table) => [index('mcp_oauth_codes_expiry').on(table.expiresAt)],
);

export const mcpOauthTokens = sqliteTable(
  'mcp_oauth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** JSON array of token scopes, which may include offline_access. */
    scopes: text('scopes').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    /** Set when a refresh token is exchanged. Reusing it afterwards revokes the grant. */
    rotatedAt: integer('rotated_at'),
  },
  (table) => [index('mcp_oauth_tokens_grant').on(table.grantId), index('mcp_oauth_tokens_expiry').on(table.expiresAt)],
);

export const mcpOauthRequests = sqliteTable(
  'mcp_oauth_requests',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpOauthClients.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    state: text('state'),
    codeChallenge: text('code_challenge').notNull(),
    /** JSON array of requested token scopes, which may include offline_access. */
    scopes: text('scopes').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    /** Set after the member signs in on the consent page. */
    memberId: text('member_id').references(() => members.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('mcp_oauth_requests_expiry').on(table.expiresAt)],
);

export type FluxmailDb = BetterSQLite3Database;

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS members_email_unique ON members(email);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  member_id TEXT REFERENCES members(id) ON DELETE RESTRICT,
  shared_with_all INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_member_grants (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, member_id)
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  encrypted_tokens TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  encrypted_credentials TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS account_send_as (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  PRIMARY KEY (account_id, email)
);
CREATE TABLE IF NOT EXISTS imap_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mailbox_path TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  reference_ids TEXT,
  thread_id TEXT NOT NULL,
  draft_id TEXT,
  subject TEXT,
  date TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS imap_messages_location_unique
  ON imap_messages(account_id, mailbox_path, uid_validity, uid);
CREATE INDEX IF NOT EXISTS imap_messages_message_id
  ON imap_messages(account_id, message_id);
CREATE INDEX IF NOT EXISTS imap_messages_thread_id
  ON imap_messages(account_id, thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS imap_messages_draft_id_unique
  ON imap_messages(account_id, draft_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  permission_profile TEXT NOT NULL DEFAULT 'full',
  custom_capabilities TEXT,
  supplemental_capabilities TEXT NOT NULL DEFAULT '[]',
  account_ids TEXT
);
CREATE TABLE IF NOT EXISTS member_credentials (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS member_sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS member_sessions_member ON member_sessions(member_id);
CREATE INDEX IF NOT EXISTS member_sessions_expiry ON member_sessions(expires_at);
CREATE TABLE IF NOT EXISTS member_auth_tokens (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS member_auth_tokens_member ON member_auth_tokens(member_id);
CREATE INDEX IF NOT EXISTS member_auth_tokens_expiry ON member_auth_tokens(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_window ON auth_rate_limits(window_started_at);
CREATE TABLE IF NOT EXISTS instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor_key_id TEXT,
  actor_session_id TEXT,
  actor_member_id TEXT,
  resource_type TEXT,
  resource_id TEXT,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_events_timestamp
  ON admin_audit_events(timestamp);
CREATE TRIGGER IF NOT EXISTS admin_audit_events_no_update
  BEFORE UPDATE ON admin_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'security audit events are append-only');
  END;
CREATE TRIGGER IF NOT EXISTS admin_audit_events_no_delete
  BEFORE DELETE ON admin_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'security audit events are append-only');
  END;
CREATE TABLE IF NOT EXISTS gmail_connection_grants (
  token_hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_member_id TEXT,
  reauthorize_account_id TEXT,
  shared_with_all INTEGER,
  granted_member_ids TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS gmail_connection_grants_expires_at
  ON gmail_connection_grants(expires_at);
CREATE TABLE IF NOT EXISTS license_lease (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_message_id TEXT,
  sent_thread_id TEXT,
  subject TEXT,
  to_recipients TEXT,
  claim_token TEXT,
  claim_until INTEGER
);
CREATE INDEX IF NOT EXISTS scheduled_sends_pending_due
  ON scheduled_sends(status, send_at);
CREATE TABLE IF NOT EXISTS rest_idempotency (
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS rest_idempotency_expires_at
  ON rest_idempotency(expires_at);
`;

function tableColumns(sqlite: Database.Database, table: string): Set<string> {
  return new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

function readStoreFormat(sqlite: Database.Database): number {
  return sqlite.pragma('user_version', { simple: true }) as number;
}

function sqliteTableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export type StoreEncryptionKeyStatus = 'empty' | 'matches' | 'mismatch';

export function inspectStoreEncryptionKey(dbPath: string, encryptionKey: Buffer): StoreEncryptionKeyStatus {
  if (dbPath === ':memory:' || !existsSync(dbPath) || statSync(dbPath).size === 0) return 'empty';
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const encryptedValues: string[] = [];
    if (sqliteTableExists(sqlite, 'account_credentials')) {
      encryptedValues.push(
        ...(
          sqlite.prepare('SELECT encrypted_credentials AS value FROM account_credentials').all() as Array<{
            value: string;
          }>
        ).map((row) => row.value),
      );
    }
    if (sqliteTableExists(sqlite, 'oauth_tokens')) {
      encryptedValues.push(
        ...(sqlite.prepare('SELECT encrypted_tokens AS value FROM oauth_tokens').all() as Array<{ value: string }>).map(
          (row) => row.value,
        ),
      );
    }
    if (sqliteTableExists(sqlite, 'instance_settings')) {
      encryptedValues.push(
        ...(
          sqlite.prepare("SELECT value FROM instance_settings WHERE value LIKE 'v1:%'").all() as Array<{
            value: string;
          }>
        ).map((row) => row.value.slice('v1:'.length)),
      );
    }
    if (!encryptedValues.length) return 'empty';
    try {
      for (const value of encryptedValues) decryptString(encryptionKey, value);
      return 'matches';
    } catch {
      return 'mismatch';
    }
  } finally {
    sqlite.close();
  }
}

function compatibilityFor(dbPath: string, dataDir: string, storeFormat: number): StoreCompatibility {
  return {
    engineVersion: VERSION,
    dataDir,
    dbPath,
    storeFormat,
    minimumSupportedFormat: MIN_SUPPORTED_STORE_FORMAT,
    maximumSupportedFormat: MAX_SUPPORTED_STORE_FORMAT,
    compatible:
      storeFormat === LEGACY_STORE_FORMAT ||
      (storeFormat >= MIN_SUPPORTED_STORE_FORMAT && storeFormat <= MAX_SUPPORTED_STORE_FORMAT),
    requiresMigration: storeFormat === LEGACY_STORE_FORMAT || storeFormat < CURRENT_STORE_FORMAT,
  };
}

export function inspectStoreCompatibility(
  dbPath: string,
  dataDir = dbPath === ':memory:' ? ':memory:' : path.dirname(dbPath),
): StoreCompatibility {
  if (dbPath === ':memory:' || !existsSync(dbPath) || statSync(dbPath).size === 0) {
    return compatibilityFor(dbPath, dataDir, LEGACY_STORE_FORMAT);
  }
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return compatibilityFor(dbPath, dataDir, readStoreFormat(sqlite));
  } finally {
    sqlite.close();
  }
}

function assertCompatible(compatibility: StoreCompatibility): void {
  if (!compatibility.compatible) throw new IncompatibleStoreError(compatibility);
}

function backupForMigration(
  sqlite: Database.Database,
  dbPath: string,
  fromFormat: number,
  toFormat: number,
): string | undefined {
  if (dbPath === ':memory:' || !existsSync(dbPath) || statSync(dbPath).size === 0) return undefined;
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const databaseName = path.basename(dbPath, path.extname(dbPath)) || 'fluxmail';
  const suffix = randomBytes(4).toString('hex');
  const destination = path.join(
    backupDir,
    `${databaseName}-format-${fromFormat}-to-${toFormat}-${stamp}-${process.pid}-${suffix}.db`,
  );
  sqlite.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  return destination;
}

function syncLegacyCredentialRows(sqlite: Database.Database): void {
  // Keep the generic credential row in sync if an older binary updated the
  // legacy Gmail token table before this version reopened the database.
  sqlite.exec(`
    INSERT INTO account_credentials (account_id, encrypted_credentials, updated_at, revision)
    SELECT account_id, encrypted_tokens, updated_at, 1 FROM oauth_tokens WHERE true
    ON CONFLICT(account_id) DO UPDATE SET
      encrypted_credentials = excluded.encrypted_credentials,
      updated_at = excluded.updated_at,
      revision = account_credentials.revision + 1
    WHERE excluded.updated_at > account_credentials.updated_at
  `);
}

function migrateToFormatOne(sqlite: Database.Database): void {
  const existingMemberColumns = tableColumns(sqlite, 'members');
  const existingApiKeyColumns = tableColumns(sqlite, 'api_keys');
  const existingAccountColumns = tableColumns(sqlite, 'accounts');
  const hadLegacyAccountShares = tableColumns(sqlite, 'account_member_shares').size > 0;
  const legacyAuthentication =
    (existingMemberColumns.size > 0 && !existingMemberColumns.has('status')) ||
    (existingMemberColumns.size === 0 && existingApiKeyColumns.size > 0);
  sqlite.exec(BOOTSTRAP_SQL);
  const credentialCols = tableColumns(sqlite, 'account_credentials');
  if (!credentialCols.has('revision')) {
    sqlite.exec('ALTER TABLE account_credentials ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  const scheduledCols = tableColumns(sqlite, 'scheduled_sends');
  if (!scheduledCols.has('claim_token')) sqlite.exec('ALTER TABLE scheduled_sends ADD COLUMN claim_token TEXT');
  if (!scheduledCols.has('claim_until')) sqlite.exec('ALTER TABLE scheduled_sends ADD COLUMN claim_until INTEGER');
  const memberCols = tableColumns(sqlite, 'members');
  if (!memberCols.has('role')) {
    sqlite.exec("ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    // Existing installations gain one administrator: the earliest member.
    sqlite.exec(`
      UPDATE members SET role = 'admin'
      WHERE id = (SELECT id FROM members ORDER BY created_at, id LIMIT 1)
    `);
  }
  if (!memberCols.has('status')) {
    sqlite.exec("ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  }

  if (!tableColumns(sqlite, 'accounts').has('member_id')) {
    sqlite.exec('ALTER TABLE accounts ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL');
  }
  const accountCols = tableColumns(sqlite, 'accounts');
  if (!accountCols.has('shared_with_all')) {
    sqlite.exec('ALTER TABLE accounts ADD COLUMN shared_with_all INTEGER NOT NULL DEFAULT 0');
    sqlite.exec(
      existingAccountColumns.has('sharing_mode')
        ? "UPDATE accounts SET shared_with_all = CASE WHEN sharing_mode = 'all' THEN 1 ELSE 0 END"
        : 'UPDATE accounts SET shared_with_all = CASE WHEN member_id IS NULL THEN 1 ELSE 0 END',
    );
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS account_member_grants (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      PRIMARY KEY (account_id, member_id)
    )
  `);
  if (hadLegacyAccountShares) {
    sqlite.exec(`
      INSERT OR IGNORE INTO account_member_grants (account_id, member_id)
      SELECT account_id, member_id FROM account_member_shares
    `);
    sqlite.exec('DROP TABLE account_member_shares');
  }
  if (accountCols.has('sharing_mode')) sqlite.exec('ALTER TABLE accounts DROP COLUMN sharing_mode');
  if (!tableColumns(sqlite, 'api_keys').has('member_id')) {
    sqlite.exec('ALTER TABLE api_keys ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL');
  }
  const apiKeyCols = tableColumns(sqlite, 'api_keys');
  if (!apiKeyCols.has('permission_profile')) {
    sqlite.exec("ALTER TABLE api_keys ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'full'");
  }
  if (!apiKeyCols.has('custom_capabilities')) {
    sqlite.exec('ALTER TABLE api_keys ADD COLUMN custom_capabilities TEXT');
  }
  if (!apiKeyCols.has('supplemental_capabilities')) {
    sqlite.exec("ALTER TABLE api_keys ADD COLUMN supplemental_capabilities TEXT NOT NULL DEFAULT '[]'");
    // Preserve the account-management authority held by legacy administrator
    // keys before administrative capabilities existed. Broader capabilities
    // must still be granted explicitly. The breaking auth migration below
    // revokes these keys before authenticated service access resumes.
    sqlite.exec(`
      UPDATE api_keys
      SET supplemental_capabilities = '["admin.accounts"]'
      WHERE permission_profile != 'custom'
        AND (
          member_id IS NULL
          OR member_id IN (SELECT id FROM members WHERE role = 'admin')
        )
    `);
    sqlite.exec(`
      UPDATE api_keys
      SET custom_capabilities = json_insert(
        COALESCE(custom_capabilities, '[]'),
        '$[#]', 'admin.accounts'
      )
      WHERE permission_profile = 'custom'
        AND (
          member_id IS NULL
          OR member_id IN (SELECT id FROM members WHERE role = 'admin')
        )
    `);
  }
  if (!apiKeyCols.has('account_ids')) {
    sqlite.exec('ALTER TABLE api_keys ADD COLUMN account_ids TEXT');
  }
  if (legacyAuthentication) sqlite.exec('DELETE FROM api_keys');
  if (!tableColumns(sqlite, 'admin_audit_events').has('actor_session_id')) {
    sqlite.exec('ALTER TABLE admin_audit_events ADD COLUMN actor_session_id TEXT');
  }
  const grantCols = tableColumns(sqlite, 'gmail_connection_grants');
  if (!grantCols.has('owner_member_id')) {
    sqlite.exec('ALTER TABLE gmail_connection_grants ADD COLUMN owner_member_id TEXT');
    if (grantCols.has('member_id')) {
      sqlite.exec('UPDATE gmail_connection_grants SET owner_member_id = member_id');
    }
  }
  if (!grantCols.has('shared_with_all')) {
    sqlite.exec('ALTER TABLE gmail_connection_grants ADD COLUMN shared_with_all INTEGER');
    if (grantCols.has('sharing_mode')) {
      sqlite.exec(
        "UPDATE gmail_connection_grants SET shared_with_all = CASE sharing_mode WHEN 'all' THEN 1 WHEN 'explicit' THEN 0 ELSE NULL END",
      );
    }
  }
  if (!grantCols.has('granted_member_ids')) {
    sqlite.exec('ALTER TABLE gmail_connection_grants ADD COLUMN granted_member_ids TEXT');
    if (grantCols.has('shared_member_ids')) {
      sqlite.exec('UPDATE gmail_connection_grants SET granted_member_ids = shared_member_ids');
    }
  }
  if (grantCols.has('member_id')) sqlite.exec('ALTER TABLE gmail_connection_grants DROP COLUMN member_id');
  if (grantCols.has('sharing_mode')) sqlite.exec('ALTER TABLE gmail_connection_grants DROP COLUMN sharing_mode');
  if (grantCols.has('shared_member_ids')) {
    sqlite.exec('ALTER TABLE gmail_connection_grants DROP COLUMN shared_member_ids');
  }

  // Login emails are case-insensitive. Keep the earliest duplicate address
  // and require later legacy records to receive a new email before enrollment.
  sqlite.exec(`
    UPDATE members
    SET email = NULL
    WHERE email IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM members AS winner
        WHERE winner.email IS NOT NULL
          AND lower(winner.email) = lower(members.email)
          AND (
            winner.created_at < members.created_at
            OR (winner.created_at = members.created_at AND winner.id < members.id)
          )
      )
  `);
  sqlite.exec('DROP INDEX IF EXISTS members_email_unique');
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS members_email_unique_ci ON members(lower(email))');

  // Account identity is the mailbox address, regardless of provider. Gmail
  // wins when an older database contains the same address as both Gmail and IMAP.
  sqlite.exec(`
    DELETE FROM accounts
    WHERE EXISTS (
      SELECT 1 FROM accounts AS winner
      WHERE lower(winner.email) = lower(accounts.email)
        AND (
          CASE winner.provider WHEN 'gmail' THEN 0 ELSE 1 END
            < CASE accounts.provider WHEN 'gmail' THEN 0 ELSE 1 END
          OR (
            CASE winner.provider WHEN 'gmail' THEN 0 ELSE 1 END
              = CASE accounts.provider WHEN 'gmail' THEN 0 ELSE 1 END
            AND (
              winner.created_at < accounts.created_at
              OR (winner.created_at = accounts.created_at AND winner.id < accounts.id)
            )
          )
        )
    )
  `);
  sqlite.exec('DROP INDEX IF EXISTS accounts_provider_email_unique');
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique_ci ON accounts(lower(email))');
  sqlite.exec(`
    INSERT INTO instance_settings (key, value) VALUES ('schema_version', '2')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  sqlite.exec(`
    INSERT OR IGNORE INTO instance_settings (key, value) VALUES ('bootstrap_complete', '0')
  `);
}

function migrateToFormatTwo(_sqlite: Database.Database): void {
  // Format 2 reserves encrypted instance settings for OAuth applications and
  // license state. The instance_settings table was created by format 1.
}

function migrateToFormatThree(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS account_send_as (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT,
      PRIMARY KEY (account_id, email)
    )
  `);
}

function migrateToFormatFour(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS delivery_operations (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      error_code TEXT,
      schedule_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS delivery_operations_principal_key
      ON delivery_operations(principal_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS delivery_operations_account
      ON delivery_operations(account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS delivery_operations_schedule
      ON delivery_operations(schedule_id);
  `);
}

function migrateToFormatFive(sqlite: Database.Database): void {
  sqlite.exec('ALTER TABLE delivery_operations ADD COLUMN member_id TEXT');
  sqlite.exec(`
    UPDATE delivery_operations
    SET member_id = COALESCE(
      (SELECT member_id FROM api_keys WHERE id = delivery_operations.principal_id),
      (SELECT member_id FROM member_sessions WHERE id = delivery_operations.principal_id)
    )
    WHERE member_id IS NULL
  `);
}

function migrateToFormatSix(sqlite: Database.Database): void {
  sqlite.exec('ALTER TABLE scheduled_sends ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
}

function migrateToFormatSeven(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      scopes TEXT NOT NULL,
      metadata_host TEXT,
      metadata_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mcp_oauth_clients_host ON mcp_oauth_clients(metadata_host);
    CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      scopes TEXT NOT NULL,
      account_ids TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mcp_oauth_grants_member ON mcp_oauth_grants(member_id);
    CREATE INDEX IF NOT EXISTS mcp_oauth_grants_client ON mcp_oauth_grants(client_id);
    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mcp_oauth_codes_expiry ON mcp_oauth_codes(expires_at);
    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      rotated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_grant ON mcp_oauth_tokens(grant_id);
    CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_expiry ON mcp_oauth_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS mcp_oauth_requests (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      state TEXT,
      code_challenge TEXT NOT NULL,
      scopes TEXT NOT NULL,
      csrf_hash TEXT NOT NULL,
      member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_oauth_requests_expiry ON mcp_oauth_requests(expires_at);
  `);
}

const MIGRATIONS = [
  { format: 1, run: migrateToFormatOne },
  { format: 2, run: migrateToFormatTwo },
  { format: 3, run: migrateToFormatThree },
  { format: 4, run: migrateToFormatFour },
  { format: 5, run: migrateToFormatFive },
  { format: 6, run: migrateToFormatSix },
  { format: 7, run: migrateToFormatSeven },
] as const;

function openCompatibleDb(dbPath: string, dataDir: string, options: { backupBeforeMigration?: boolean }): FluxmailDb {
  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('foreign_keys = ON');

    const beforeMigration = compatibilityFor(dbPath, dataDir, readStoreFormat(sqlite));
    assertCompatible(beforeMigration);
    if (beforeMigration.requiresMigration && options.backupBeforeMigration !== false) {
      backupForMigration(sqlite, dbPath, beforeMigration.storeFormat, CURRENT_STORE_FORMAT);
    }

    const migrate = sqlite.transaction(() => {
      let storeFormat = readStoreFormat(sqlite);
      assertCompatible(compatibilityFor(dbPath, dataDir, storeFormat));
      for (const migration of MIGRATIONS) {
        if (storeFormat >= migration.format) continue;
        migration.run(sqlite);
        sqlite.pragma(`user_version = ${migration.format}`);
        storeFormat = migration.format;
      }
      if (storeFormat !== CURRENT_STORE_FORMAT) {
        throw new Error(`Fluxmail has no migration from store format ${storeFormat} to ${CURRENT_STORE_FORMAT}`);
      }
      syncLegacyCredentialRows(sqlite);
    });
    migrate.immediate();
    sqlite.pragma('journal_mode = WAL');
    return drizzle(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export function openDb(
  dbPath: string,
  options: { dataDir?: string; backupBeforeMigration?: boolean } = {},
): FluxmailDb {
  const dataDir = options.dataDir ?? (dbPath === ':memory:' ? ':memory:' : path.dirname(dbPath));
  const inspected = inspectStoreCompatibility(dbPath, dataDir);
  assertCompatible(inspected);

  if (dbPath === ':memory:' || !inspected.requiresMigration) {
    return openCompatibleDb(dbPath, dataDir, options);
  }

  return withFileLock(
    `${dbPath}.migration.lock`,
    {
      timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
      staleMs: MIGRATION_LOCK_STALE_MS,
      description: `migration of ${dbPath}`,
    },
    () => openCompatibleDb(dbPath, dataDir, options),
  );
}

export function openReadonlyDb(dbPath: string): FluxmailDb {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma('query_only = ON');
    sqlite.pragma('foreign_keys = ON');
    return drizzle(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
