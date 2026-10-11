import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { EmailError, type Account, type EmailAddress, type EmailProvider, type Provider } from '@fluxmail/core';
import { GmailProvider, GMAIL_CAPABILITIES, googleTransporterOptions } from '@fluxmail/provider-gmail';
import { ImapProvider, IMAP_CAPABILITIES, type FolderWarning, type ImapCredentials } from '@fluxmail/provider-imap';
import { OutlookProvider, OUTLOOK_CAPABILITIES } from '@fluxmail/provider-outlook';
import type { FluxmailConfig } from '../config.js';
import { accountCredentials, accountMemberGrants, accounts, oauthTokens, type FluxmailDb } from '../storage/db.js';
import { decryptString, encryptString } from '../storage/crypto.js';
import {
  assertAccountLimit,
  assertCanIncreaseUsage,
  getEntitlements,
  recordCapState,
} from '../licensing/entitlements.js';
import { getMember } from '../storage/members.js';
import type { StoredGoogleOAuthApp } from '../instanceConfig.js';
import { DEFAULT_GOOGLE_CLIENT_ID } from './defaultGoogleOAuth.js';
import { requireGoogleConfig } from './googleAuth.js';
import { SqliteImapStateStore } from '../storage/imapState.js';
import { refreshMicrosoftCredentials, requireMicrosoftConfig, type MicrosoftCredentials } from './microsoftAuth.js';
import { listConfiguredSendAs } from '../storage/sendAs.js';

export interface AccountAccessInput {
  sharedWithAll: boolean;
  grantedMemberIds?: readonly string[];
}

interface StoredGmailCredentials extends Credentials {
  fluxmailOAuthClient?: StoredGoogleOAuthApp;
}

interface CredentialState {
  encryptedCredentials: string;
  revision: number;
  updatedAt: number;
}

export const IMAP_CONNECTION_TEST_TIMEOUT_MS = 30_000;

export class AccountRegistry {
  private readonly providers = new Map<string, { provider: EmailProvider } & CredentialState>();

  constructor(
    private readonly db: FluxmailDb,
    private readonly config: FluxmailConfig,
  ) {}

  async close(): Promise<void> {
    const providers = [...this.providers.values()].map(
      ({ provider }) => provider as EmailProvider & { close?: () => Promise<void> },
    );
    this.providers.clear();
    const results = await Promise.allSettled(providers.map((provider) => provider.close?.()));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private evictProvider(accountId: string): void {
    const cached = this.providers.get(accountId)?.provider as EmailProvider & { close?: () => Promise<void> };
    this.providers.delete(accountId);
    void cached?.close?.();
  }

  listAccounts(): Account[] {
    const grants = new Map<string, string[]>();
    for (const row of this.db.select().from(accountMemberGrants).all()) {
      const memberIds = grants.get(row.accountId) ?? [];
      memberIds.push(row.memberId);
      grants.set(row.accountId, memberIds);
    }
    return this.db
      .select()
      .from(accounts)
      .all()
      .map((row) => {
        if (!row.ownerMemberId) {
          throw new EmailError(
            'invalid_request',
            'This instance must finish administrator setup before mailboxes can be used.',
          );
        }
        return {
          id: row.id,
          provider: row.provider as Provider,
          email: row.email,
          ...(row.displayName ? { displayName: row.displayName } : {}),
          status: row.status as Account['status'],
          capabilities:
            this.providers.get(row.id)?.provider.capabilities ??
            (row.provider === 'imap'
              ? IMAP_CAPABILITIES
              : row.provider === 'outlook'
                ? OUTLOOK_CAPABILITIES
                : GMAIL_CAPABILITIES),
          ownerMemberId: row.ownerMemberId,
          sharedWithAll: row.sharedWithAll,
          grantedMemberIds: grants.get(row.id) ?? [],
        };
      });
  }

  getAccount(accountId: string): Account {
    const account = this.listAccounts().find((a) => a.id === accountId);
    if (!account) throw new EmailError('not_found', `No account with id "${accountId}"`);
    return account;
  }

  /** Resolve an account by canonical id or mailbox address. Email matching is case-insensitive. */
  findAccount(ref: string): Account {
    const normalized = ref.trim().toLowerCase();
    const account = this.listAccounts().find(
      (candidate) => candidate.id === ref || candidate.email.toLowerCase() === normalized,
    );
    if (!account) {
      throw new EmailError('not_found', `No account with id or email "${ref}".`);
    }
    return account;
  }

  private normalizeAccess(access?: AccountAccessInput): Required<AccountAccessInput> {
    const sharedWithAll = access?.sharedWithAll ?? false;
    const grantedMemberIds = sharedWithAll ? [] : [...new Set(access?.grantedMemberIds ?? [])];
    for (const memberId of grantedMemberIds) getMember(this.db, memberId);
    return { sharedWithAll, grantedMemberIds };
  }

  private writeAccess(
    db: Pick<FluxmailDb, 'update' | 'delete' | 'insert'>,
    accountId: string,
    access?: AccountAccessInput,
  ): void {
    const normalized = this.normalizeAccess(access);
    db.update(accounts).set({ sharedWithAll: normalized.sharedWithAll }).where(eq(accounts.id, accountId)).run();
    db.delete(accountMemberGrants).where(eq(accountMemberGrants.accountId, accountId)).run();
    if (normalized.grantedMemberIds.length) {
      db.insert(accountMemberGrants)
        .values(normalized.grantedMemberIds.map((memberId) => ({ accountId, memberId })))
        .run();
    }
  }

  /** Fail before OAuth when a new account would exceed the current plan. */
  assertCanAddAccount(): void {
    const existing = this.listAccounts();
    assertCanIncreaseUsage(this.db);
    try {
      assertAccountLimit(existing.length, getEntitlements(this.db));
    } catch (err) {
      if (!(err instanceof EmailError)) throw err;
      const reconnect =
        existing.length === 1
          ? `To reconnect ${existing[0]!.email}, rerun this command with ` + `"--reauthorize ${existing[0]!.id}".`
          : 'To reconnect an existing account, rerun this command with "--reauthorize <account-id>".';
      throw new EmailError(err.code, `${err.message} ${reconnect}`);
    }
  }

  /** Resolve an account id, defaulting to the sole account when only one exists. */
  resolveAccountId(accountId?: string): string {
    if (accountId) return this.getAccount(accountId).id;
    const all = this.listAccounts();
    if (all.length === 0) {
      throw new EmailError(
        'invalid_request',
        'No email accounts are connected yet. Run "fluxmail accounts add gmail", "fluxmail accounts add outlook", or the IMAP equivalent.',
      );
    }
    if (all.length > 1) {
      throw new EmailError(
        'invalid_request',
        `Multiple accounts are connected; specify accountId. Available: ${all
          .map((a) => `${a.id} (${a.email})`)
          .join(', ')}`,
      );
    }
    return all[0]!.id;
  }

  getProvider(accountId: string): EmailProvider {
    const account = this.getAccount(accountId);
    const credentialState = this.loadCredentialRow(accountId);
    const cached = this.providers.get(accountId);
    if (
      cached?.revision === credentialState.revision &&
      cached.encryptedCredentials === credentialState.encryptedCredentials
    ) {
      return cached.provider;
    }

    const stored = this.decryptCredentials(credentialState);
    const provider =
      account.provider === 'gmail'
        ? this.buildGmailProvider(accountId, account.email, credentialState, account.displayName)
        : account.provider === 'outlook'
          ? this.buildOutlookProvider(accountId, credentialState)
          : account.provider === 'imap'
            ? new ImapProvider({
                accountId,
                email: account.email,
                ...(account.displayName ? { displayName: account.displayName } : {}),
                credentials: stored as ImapCredentials,
                store: new SqliteImapStateStore(this.db, accountId),
                resolveSender: (email) => this.resolveConfiguredSender(accountId, email),
              })
            : undefined;
    if (!provider)
      throw new EmailError('unsupported_capability', `Provider "${account.provider}" is not supported yet`);
    this.providers.set(accountId, { provider, ...credentialState });
    return provider;
  }

  private resolveConfiguredSender(accountId: string, email: string): EmailAddress | undefined {
    const account = this.getAccount(accountId);
    if (account.email.toLowerCase() === email.toLowerCase()) {
      return { email: account.email, ...(account.displayName ? { name: account.displayName } : {}) };
    }
    const identity = listConfiguredSendAs(this.db, accountId).find(
      (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
    );
    return identity ? { email: identity.email, ...(identity.name ? { name: identity.name } : {}) } : undefined;
  }

  private loadCredentialRow(accountId: string): CredentialState {
    const row = this.db.select().from(accountCredentials).where(eq(accountCredentials.accountId, accountId)).get();
    if (!row) throw new EmailError('auth_expired', `No stored credentials for account ${accountId}`);
    return row;
  }

  private decryptCredentials(state: CredentialState): unknown {
    return JSON.parse(decryptString(this.config.encryptionKey, state.encryptedCredentials)) as unknown;
  }

  private writeCredentials(db: Pick<FluxmailDb, 'insert'>, accountId: string, credentials: unknown): CredentialState {
    const encryptedCredentials = encryptString(this.config.encryptionKey, JSON.stringify(credentials));
    const updatedAt = Date.now();
    const row = db
      .insert(accountCredentials)
      .values({ accountId, encryptedCredentials, updatedAt, revision: 1 })
      .onConflictDoUpdate({
        target: accountCredentials.accountId,
        set: {
          encryptedCredentials,
          updatedAt,
          revision: sql`${accountCredentials.revision} + 1`,
        },
      })
      .returning({
        encryptedCredentials: accountCredentials.encryptedCredentials,
        revision: accountCredentials.revision,
        updatedAt: accountCredentials.updatedAt,
      })
      .get();
    return row;
  }

  private gmailCredentials(tokens: Credentials, oauthClient?: StoredGoogleOAuthApp): StoredGmailCredentials {
    const { clientId, clientSecret } = oauthClient ?? requireGoogleConfig(this.config);
    return { ...tokens, fluxmailOAuthClient: { clientId, clientSecret } };
  }

  private writeTokenRows(db: Pick<FluxmailDb, 'insert'>, accountId: string, tokens: unknown): CredentialState {
    const state = this.writeCredentials(db, accountId, tokens);
    db.insert(oauthTokens)
      .values({ accountId, encryptedTokens: state.encryptedCredentials, updatedAt: state.updatedAt })
      .onConflictDoUpdate({
        target: oauthTokens.accountId,
        set: { encryptedTokens: state.encryptedCredentials, updatedAt: state.updatedAt },
      })
      .run();
    return state;
  }

  private writeTokensIfCurrent(
    accountId: string,
    tokens: unknown,
    expected: CredentialState,
  ): CredentialState | undefined {
    const encryptedCredentials = encryptString(this.config.encryptionKey, JSON.stringify(tokens));
    const updatedAt = Date.now();
    const revision = expected.revision + 1;
    return this.db.transaction((tx) => {
      const result = tx
        .update(accountCredentials)
        .set({ encryptedCredentials, updatedAt, revision })
        .where(
          and(
            eq(accountCredentials.accountId, accountId),
            eq(accountCredentials.revision, expected.revision),
            eq(accountCredentials.encryptedCredentials, expected.encryptedCredentials),
          ),
        )
        .run();
      if (result.changes === 0) return undefined;
      tx.insert(oauthTokens)
        .values({ accountId, encryptedTokens: encryptedCredentials, updatedAt })
        .onConflictDoUpdate({
          target: oauthTokens.accountId,
          set: { encryptedTokens: encryptedCredentials, updatedAt },
        })
        .run();
      return { encryptedCredentials, revision, updatedAt };
    });
  }

  private updateCachedProvider(accountId: string, provider: EmailProvider, state: CredentialState): void {
    const cached = this.providers.get(accountId);
    if (!cached || cached.provider !== provider) return;
    cached.encryptedCredentials = state.encryptedCredentials;
    cached.revision = state.revision;
    cached.updatedAt = state.updatedAt;
  }

  private gmailTokens(credentials: StoredGmailCredentials): Credentials {
    const tokens = { ...credentials };
    delete tokens.fluxmailOAuthClient;
    return tokens;
  }

  private buildGmailProvider(
    accountId: string,
    email: string,
    initialState: CredentialState,
    displayName?: string,
  ): EmailProvider {
    let credentialState = initialState;
    const stored = this.decryptCredentials(credentialState) as StoredGmailCredentials;
    const storedClient = stored.fluxmailOAuthClient;
    const configuredClient = storedClient ?? requireGoogleConfig(this.config);
    if (!storedClient && configuredClient.clientId === DEFAULT_GOOGLE_CLIENT_ID) {
      throw new EmailError(
        'auth_expired',
        'This Gmail account was connected with a custom Google OAuth app. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the app that connected it, or reconnect the account.',
      );
    }
    const { clientId, clientSecret } = configuredClient;
    const auth = new OAuth2Client({ clientId, clientSecret, transporterOptions: googleTransporterOptions() });
    auth.setCredentials(this.gmailTokens(stored));
    const provider = new GmailProvider({
      accountId,
      email,
      ...(displayName ? { displayName } : {}),
      auth,
    });
    // google-auth-library refreshes access tokens transparently; persist them so
    // restarts don't need a refresh round-trip (and rotated refresh tokens survive).
    auth.on('tokens', (fresh) => {
      const current = this.decryptCredentials(credentialState) as StoredGmailCredentials;
      const saved = this.writeTokensIfCurrent(accountId, { ...current, ...fresh }, credentialState);
      if (saved) {
        credentialState = saved;
        this.updateCachedProvider(accountId, provider, credentialState);
        return;
      }

      const latestState = this.loadCredentialRow(accountId);
      const latest = this.decryptCredentials(latestState) as StoredGmailCredentials;
      const latestClient = latest.fluxmailOAuthClient ?? requireGoogleConfig(this.config);
      if (latestClient.clientId !== clientId || latestClient.clientSecret !== clientSecret) {
        if (this.providers.get(accountId)?.provider === provider) this.providers.delete(accountId);
        return;
      }
      credentialState = latestState;
      auth.setCredentials(this.gmailTokens(latest));
      this.updateCachedProvider(accountId, provider, credentialState);
    });
    return provider;
  }

  private buildOutlookProvider(accountId: string, initialState: CredentialState): EmailProvider {
    let credentialState = initialState;
    let credentials = this.decryptCredentials(credentialState) as MicrosoftCredentials;
    if (!credentials.fluxmailOAuthClient) requireMicrosoftConfig(this.config);
    let refresh: Promise<string> | undefined;
    const provider = new OutlookProvider({
      accountId,
      resolveSender: (sender) => this.resolveConfiguredSender(accountId, sender),
      tokenProvider: {
        getAccessToken: async (forceRefresh = false): Promise<string> => {
          if (!forceRefresh && credentials.expiresAt > Date.now() + 60_000) return credentials.accessToken;
          if (refresh) return refresh;
          refresh = refreshMicrosoftCredentials(this.config, credentials)
            .then((fresh) => {
              credentials = fresh;
              const saved = this.writeTokensIfCurrent(accountId, fresh, credentialState);
              credentialState = saved ?? this.loadCredentialRow(accountId);
              if (!saved) credentials = this.decryptCredentials(credentialState) as MicrosoftCredentials;
              this.updateCachedProvider(accountId, provider, credentialState);
              return credentials.accessToken;
            })
            .finally(() => {
              refresh = undefined;
            });
          return refresh;
        },
      },
    });
    return provider;
  }

  addGmailAccount(
    email: string,
    tokens: Credentials,
    displayName?: string,
    memberId?: string,
    access?: AccountAccessInput,
    oauthClient?: StoredGoogleOAuthApp,
  ): Account {
    // Validate up front for a clean not_found instead of a FK constraint error.
    if (memberId) getMember(this.db, memberId);
    const existing = this.db.select().from(accounts).all();
    const duplicate = existing.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (duplicate) {
      if (duplicate.provider !== 'gmail') {
        throw new EmailError(
          'invalid_request',
          `${duplicate.email} is already connected through ${duplicate.provider}. Remove it before connecting Gmail.`,
        );
      }
      // Re-authenticating an existing account: refresh tokens, clear error
      // state. Ownership is untouched; reassign with assignAccountOwner.
      this.db.transaction((tx) => {
        this.writeTokenRows(tx, duplicate.id, this.gmailCredentials(tokens, oauthClient));
        tx.update(accounts)
          .set({ status: 'active', ...(displayName ? { displayName } : {}) })
          .where(eq(accounts.id, duplicate.id))
          .run();
      });
      this.evictProvider(duplicate.id);
      return this.getAccount(duplicate.id);
    }
    if (!memberId) {
      throw new EmailError('invalid_request', 'An owner is required when connecting a mailbox.');
    }

    const id = `acct_${randomBytes(6).toString('hex')}`;
    this.db.transaction((tx) => {
      const accountCount = tx.select().from(accounts).all().length;
      assertCanIncreaseUsage(tx);
      assertAccountLimit(accountCount, getEntitlements(tx));
      tx.insert(accounts)
        .values({
          id,
          provider: 'gmail',
          email,
          displayName: displayName ?? null,
          status: 'active',
          createdAt: Date.now(),
          ownerMemberId: memberId,
          sharedWithAll: this.normalizeAccess(access).sharedWithAll,
        })
        .run();
      this.writeTokenRows(tx, id, this.gmailCredentials(tokens, oauthClient));
      this.writeAccess(tx, id, access);
    });
    return this.getAccount(id);
  }

  addOutlookAccount(
    email: string,
    credentials: MicrosoftCredentials,
    displayName?: string,
    memberId?: string,
    reauthorizeId?: string,
    access?: AccountAccessInput,
  ): Account {
    if (memberId) getMember(this.db, memberId);
    const existingRows = this.db.select().from(accounts).all();
    const duplicate = reauthorizeId
      ? existingRows.find((row) => row.id === reauthorizeId)
      : existingRows.find((row) => row.email.toLowerCase() === email.toLowerCase());
    if (duplicate) {
      if (duplicate.provider !== 'outlook' || duplicate.email.toLowerCase() !== email.toLowerCase()) {
        if (duplicate.provider !== 'outlook' && duplicate.email.toLowerCase() === email.toLowerCase()) {
          throw new EmailError(
            'invalid_request',
            `${duplicate.email} is already connected through ${duplicate.provider}. Remove it before connecting Outlook.`,
          );
        }
        throw new EmailError('invalid_request', `Account ${duplicate.id} does not match Outlook mailbox ${email}.`);
      }
      this.db.transaction((tx) => {
        this.writeTokenRows(tx, duplicate.id, credentials);
        tx.update(accounts)
          .set({ status: 'active', ...(displayName ? { displayName } : {}) })
          .where(eq(accounts.id, duplicate.id))
          .run();
      });
      this.evictProvider(duplicate.id);
      return this.getAccount(duplicate.id);
    }
    if (reauthorizeId) throw new EmailError('not_found', `No account with id "${reauthorizeId}".`);
    if (!memberId) throw new EmailError('invalid_request', 'An owner is required when connecting a mailbox.');

    const id = `acct_${randomBytes(6).toString('hex')}`;
    this.db.transaction((tx) => {
      assertCanIncreaseUsage(tx);
      assertAccountLimit(tx.select().from(accounts).all().length, getEntitlements(tx));
      tx.insert(accounts)
        .values({
          id,
          provider: 'outlook',
          email,
          displayName: displayName ?? null,
          status: 'active',
          createdAt: Date.now(),
          ownerMemberId: memberId,
          sharedWithAll: this.normalizeAccess(access).sharedWithAll,
        })
        .run();
      this.writeTokenRows(tx, id, credentials);
      this.writeAccess(tx, id, access);
    });
    return this.getAccount(id);
  }

  async testImapCredentials(
    email: string,
    credentials: ImapCredentials,
    displayName?: string,
    timeoutMs = IMAP_CONNECTION_TEST_TIMEOUT_MS,
  ): Promise<FolderWarning[]> {
    return this.testImapSetup(email, credentials, displayName, timeoutMs, true);
  }

  async testImapFolderOverrides(
    email: string,
    credentials: ImapCredentials,
    displayName?: string,
    timeoutMs = IMAP_CONNECTION_TEST_TIMEOUT_MS,
  ): Promise<FolderWarning[]> {
    return this.testImapSetup(email, credentials, displayName, timeoutMs, false);
  }

  private async testImapSetup(
    email: string,
    credentials: ImapCredentials,
    displayName: string | undefined,
    timeoutMs: number,
    verifySmtp: boolean,
  ): Promise<FolderWarning[]> {
    const provider = new ImapProvider({
      accountId: 'imap_setup',
      email,
      ...(displayName ? { displayName } : {}),
      credentials,
      store: new SqliteImapStateStore(this.db, 'imap_setup'),
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          if (verifySmtp) await provider.testConnection();
          return provider.getFolderWarnings();
        })(),
        new Promise<FolderWarning[]>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new EmailError(
                  'provider_unavailable',
                  verifySmtp ? 'The IMAP and SMTP connection test timed out.' : 'The IMAP folder validation timed out.',
                ),
              ),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await provider.close();
    }
  }

  addImapAccount(
    email: string,
    credentials: ImapCredentials,
    displayName?: string,
    memberId?: string,
    reauthorizeId?: string,
    access?: AccountAccessInput,
  ): Account {
    if (memberId) getMember(this.db, memberId);
    const existingRows = this.db.select().from(accounts).all();
    const duplicate = reauthorizeId
      ? existingRows.find((row) => row.id === reauthorizeId)
      : existingRows.find((row) => row.email.toLowerCase() === email.toLowerCase());
    if (duplicate) {
      if (duplicate.provider !== 'imap' || duplicate.email.toLowerCase() !== email.toLowerCase()) {
        if (duplicate.provider !== 'imap' && duplicate.email.toLowerCase() === email.toLowerCase()) {
          throw new EmailError(
            'invalid_request',
            `${duplicate.email} is already connected through ${duplicate.provider}. Remove it before connecting IMAP.`,
          );
        }
        throw new EmailError('invalid_request', `Account ${duplicate.id} does not match IMAP mailbox ${email}.`);
      }
      this.db.transaction((tx) => {
        this.writeCredentials(tx, duplicate.id, credentials);
        tx.update(accounts)
          .set({ status: 'active', ...(displayName ? { displayName } : {}) })
          .where(eq(accounts.id, duplicate.id))
          .run();
      });
      this.evictProvider(duplicate.id);
      return this.getAccount(duplicate.id);
    }
    if (reauthorizeId) {
      throw new EmailError('not_found', `No account with id "${reauthorizeId}".`);
    }
    if (!memberId) {
      throw new EmailError('invalid_request', 'An owner is required when connecting a mailbox.');
    }

    const id = `acct_${randomBytes(6).toString('hex')}`;
    this.db.transaction((tx) => {
      assertCanIncreaseUsage(tx);
      assertAccountLimit(tx.select().from(accounts).all().length, getEntitlements(tx));
      tx.insert(accounts)
        .values({
          id,
          provider: 'imap',
          email,
          displayName: displayName ?? null,
          status: 'active',
          createdAt: Date.now(),
          ownerMemberId: memberId,
          sharedWithAll: this.normalizeAccess(access).sharedWithAll,
        })
        .run();
      this.writeCredentials(tx, id, credentials);
      this.writeAccess(tx, id, access);
    });
    return this.getAccount(id);
  }

  loadImapCredentials(accountId: string): ImapCredentials {
    const account = this.getAccount(accountId);
    if (account.provider !== 'imap')
      throw new EmailError('invalid_request', `Account ${accountId} is not an IMAP account.`);
    const row = this.loadCredentialRow(accountId);
    return JSON.parse(decryptString(this.config.encryptionKey, row.encryptedCredentials)) as ImapCredentials;
  }

  saveImapCredentials(accountId: string, credentials: ImapCredentials): void {
    this.loadImapCredentials(accountId);
    this.writeCredentials(this.db, accountId, credentials);
    this.evictProvider(accountId);
  }

  assignAccountOwner(accountId: string, memberId: string): Account {
    this.getAccount(accountId);
    getMember(this.db, memberId);
    this.db.update(accounts).set({ ownerMemberId: memberId }).where(eq(accounts.id, accountId)).run();
    return this.getAccount(accountId);
  }

  setAccountAccess(accountId: string, access: AccountAccessInput): Account {
    this.getAccount(accountId);
    this.db.transaction((tx) => this.writeAccess(tx, accountId, access));
    return this.getAccount(accountId);
  }

  removeAccount(accountId: string): void {
    this.getAccount(accountId);
    this.db.transaction((tx) => {
      tx.delete(accounts).where(eq(accounts.id, accountId)).run();
      recordCapState(tx);
    });
    this.evictProvider(accountId);
  }

  /** Connected mailbox totals by provider. Aggregate counts only, for telemetry. */
  accountProviderCounts(): Record<'total' | Provider, number> {
    const counts: Record<'total' | Provider, number> = { total: 0, gmail: 0, outlook: 0, imap: 0 };
    for (const row of this.db.select({ provider: accounts.provider }).from(accounts).all()) {
      counts.total += 1;
      if (row.provider === 'gmail' || row.provider === 'outlook' || row.provider === 'imap') {
        counts[row.provider] += 1;
      }
    }
    return counts;
  }

  markStatus(accountId: string, status: Account['status']): void {
    this.db.update(accounts).set({ status }).where(eq(accounts.id, accountId)).run();
  }
}
