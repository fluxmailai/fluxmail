import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, inArray, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import {
  authRateLimits,
  mcpOauthClients,
  mcpOauthCodes,
  mcpOauthGrants,
  mcpOauthRequests,
  mcpOauthTokens,
  members,
  type FluxmailDb,
} from './db.js';
import type { MemberRole } from './members.js';
import { MCP_CAPABILITIES, isMcpCapability, type McpCapability } from '../permissions.js';

export const OAUTH_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const OAUTH_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const OAUTH_CODE_TTL_MS = 60 * 1000;
export const OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
export const OAUTH_MAX_CLIENTS = 1_000;
export const OAUTH_MAX_CLIENTS_PER_HOST = 20;
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 100;
const GRANT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export const OFFLINE_ACCESS_SCOPE = 'offline_access';
export const OAUTH_SCOPES = [...MCP_CAPABILITIES, OFFLINE_ACCESS_SCOPE] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
export type OAuthClientKind = 'registered' | 'metadata_document';

export interface OAuthClient {
  id: string;
  kind: OAuthClientKind;
  name: string;
  redirectUris: string[];
  /** Mail scopes the client may request. */
  scopes: McpCapability[];
  metadataHost: string | null;
  metadataExpiresAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface OAuthGrantInfo {
  id: string;
  clientId: string;
  clientName: string;
  clientKind: OAuthClientKind;
  memberId: string;
  scopes: McpCapability[];
  /** Mailbox narrowing. null means every mailbox available to the member. */
  accountIds: string[] | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

export interface OAuthAuthorizationRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: OAuthScope[];
  memberId: string | null;
  expiresAt: number;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes: OAuthScope[];
}

export type OAuthTokenResult =
  | { ok: true; tokens: OAuthTokenSet }
  | { ok: false; error: 'invalid_grant' | 'invalid_scope'; description: string };

export interface OAuthAccessTokenAuth {
  grantId: string;
  clientId: string;
  memberId: string;
  role: MemberRole;
  scopes: McpCapability[];
  accountIds: string[] | null;
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isOAuthScope(value: string): value is OAuthScope {
  return value === OFFLINE_ACCESS_SCOPE || isMcpCapability(value);
}

/** Keep known scopes in canonical order. */
export function canonicalOAuthScopes(scopes: Iterable<string>): OAuthScope[] {
  const set = new Set(scopes);
  return OAUTH_SCOPES.filter((scope) => set.has(scope));
}

export function mailScopesOf(scopes: Iterable<string>): McpCapability[] {
  const set = new Set(scopes);
  return MCP_CAPABILITIES.filter((scope) => set.has(scope));
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('Stored OAuth value must be a JSON array of strings.');
  }
  return parsed;
}

function parseAccountIds(value: string | null): string[] | null {
  return value === null ? null : [...new Set(parseStringArray(value))];
}

function clientFromRow(row: typeof mcpOauthClients.$inferSelect): OAuthClient {
  return {
    id: row.id,
    kind: row.kind as OAuthClientKind,
    name: row.name,
    redirectUris: parseStringArray(row.redirectUris),
    scopes: mailScopesOf(parseStringArray(row.scopes)),
    metadataHost: row.metadataHost,
    metadataExpiresAt: row.metadataExpiresAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function pruneUnusedClients(db: FluxmailDb, now: number): void {
  const unused = db
    .select({ id: mcpOauthClients.id })
    .from(mcpOauthClients)
    .where(
      and(
        lte(mcpOauthClients.createdAt, now - UNUSED_CLIENT_TTL_MS),
        notExists(db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId, mcpOauthClients.id))),
        notExists(db.select().from(mcpOauthRequests).where(eq(mcpOauthRequests.clientId, mcpOauthClients.id))),
      ),
    )
    .limit(PRUNE_BATCH)
    .all();
  if (unused.length) {
    db.delete(mcpOauthClients)
      .where(
        inArray(
          mcpOauthClients.id,
          unused.map((row) => row.id),
        ),
      )
      .run();
  }
}

/** Remove expired protocol state, ended grants, and clients nobody uses. */
export function pruneOAuthState(db: FluxmailDb, now = Date.now()): void {
  db.transaction((tx) => {
    tx.delete(mcpOauthRequests).where(lte(mcpOauthRequests.expiresAt, now)).run();
    tx.delete(mcpOauthCodes).where(lte(mcpOauthCodes.expiresAt, now)).run();
    // Ended grants take their tokens and codes with them through cascades.
    tx.delete(mcpOauthGrants)
      .where(or(lte(mcpOauthGrants.expiresAt, now), sql`${mcpOauthGrants.revokedAt} IS NOT NULL`))
      .run();
    // Rotated refresh tokens stay until they expire so their reuse is still detected.
    tx.delete(mcpOauthTokens).where(lte(mcpOauthTokens.expiresAt, now)).run();
    pruneUnusedClients(tx as unknown as FluxmailDb, now);
  });
}

/**
 * Count an attempt in a fixed window shared across processes. Returns false
 * once the limit is reached.
 */
export function reserveOAuthRateLimit(
  db: FluxmailDb,
  name: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const key = `oauth:${secretHash(name)}`;
  return db.transaction(
    (tx) => {
      const row = tx.select().from(authRateLimits).where(eq(authRateLimits.key, key)).get();
      if (!row || row.windowStartedAt <= now - windowMs) {
        tx.insert(authRateLimits)
          .values({ key, attempts: 1, windowStartedAt: now })
          .onConflictDoUpdate({ target: authRateLimits.key, set: { attempts: 1, windowStartedAt: now } })
          .run();
        return true;
      }
      if (row.attempts >= limit) return false;
      tx.update(authRateLimits)
        .set({ attempts: row.attempts + 1 })
        .where(eq(authRateLimits.key, key))
        .run();
      return true;
    },
    { behavior: 'immediate' },
  );
}

/** Store a dynamically registered public client. Returns null when the client limit is reached. */
export function registerOAuthClient(
  db: FluxmailDb,
  input: { name: string; redirectUris: readonly string[]; scopes: readonly McpCapability[] },
  now = Date.now(),
): OAuthClient | null {
  pruneOAuthState(db, now);
  return db.transaction(
    (tx) => {
      const total = tx.select({ value: count() }).from(mcpOauthClients).get()?.value ?? 0;
      if (total >= OAUTH_MAX_CLIENTS) return null;
      const row = {
        id: `client_${randomBytes(16).toString('hex')}`,
        kind: 'registered',
        name: input.name,
        redirectUris: JSON.stringify([...new Set(input.redirectUris)]),
        scopes: JSON.stringify(mailScopesOf(input.scopes)),
        metadataHost: null,
        metadataExpiresAt: null,
        createdAt: now,
        lastUsedAt: null,
      } satisfies typeof mcpOauthClients.$inferInsert;
      tx.insert(mcpOauthClients).values(row).run();
      return clientFromRow(row);
    },
    { behavior: 'immediate' },
  );
}

export type MetadataClientResult = { status: 'stored'; client: OAuthClient } | { status: 'limit' };

/**
 * Create or refresh a client described by a metadata document. New clients
 * count toward the global and per-host limits.
 */
export function storeMetadataOAuthClient(
  db: FluxmailDb,
  input: { id: string; host: string; name: string; redirectUris: readonly string[]; expiresAt: number },
  now = Date.now(),
): MetadataClientResult {
  return db.transaction(
    (tx) => {
      const values = {
        name: input.name,
        redirectUris: JSON.stringify([...new Set(input.redirectUris)]),
        // Metadata documents cannot narrow scopes; consent decides what the client receives.
        scopes: JSON.stringify(MCP_CAPABILITIES),
        metadataHost: input.host,
        metadataExpiresAt: input.expiresAt,
      };
      const existing = tx.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, input.id)).get();
      if (existing) {
        tx.update(mcpOauthClients).set(values).where(eq(mcpOauthClients.id, input.id)).run();
        return { status: 'stored', client: clientFromRow({ ...existing, ...values }) } as const;
      }
      const total = tx.select({ value: count() }).from(mcpOauthClients).get()?.value ?? 0;
      const perHost =
        tx.select({ value: count() }).from(mcpOauthClients).where(eq(mcpOauthClients.metadataHost, input.host)).get()
          ?.value ?? 0;
      if (total >= OAUTH_MAX_CLIENTS || perHost >= OAUTH_MAX_CLIENTS_PER_HOST) return { status: 'limit' } as const;
      const row = {
        id: input.id,
        kind: 'metadata_document',
        ...values,
        createdAt: now,
        lastUsedAt: null,
      } satisfies typeof mcpOauthClients.$inferInsert;
      tx.insert(mcpOauthClients).values(row).run();
      return { status: 'stored', client: clientFromRow(row) } as const;
    },
    { behavior: 'immediate' },
  );
}

export function getOAuthClient(db: FluxmailDb, id: string): OAuthClient | null {
  const row = db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, id)).get();
  return row ? clientFromRow(row) : null;
}

export function countOAuthClients(db: FluxmailDb, host?: string): number {
  return (
    db
      .select({ value: count() })
      .from(mcpOauthClients)
      .where(host ? eq(mcpOauthClients.metadataHost, host) : undefined)
      .get()?.value ?? 0
  );
}

function requestFromRow(row: typeof mcpOauthRequests.$inferSelect): OAuthAuthorizationRequest {
  return {
    id: row.id,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    state: row.state,
    codeChallenge: row.codeChallenge,
    scopes: canonicalOAuthScopes(parseStringArray(row.scopes)),
    memberId: row.memberId,
    expiresAt: row.expiresAt,
  };
}

/** Save a validated authorization request. The CSRF token is returned once. */
export function createOAuthAuthorizationRequest(
  db: FluxmailDb,
  input: {
    clientId: string;
    redirectUri: string;
    state?: string;
    codeChallenge: string;
    scopes: readonly OAuthScope[];
  },
  now = Date.now(),
): { request: OAuthAuthorizationRequest; csrf: string } {
  const csrf = randomBytes(32).toString('hex');
  const row = {
    id: randomBytes(16).toString('hex'),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    state: input.state ?? null,
    codeChallenge: input.codeChallenge,
    scopes: JSON.stringify(canonicalOAuthScopes(input.scopes)),
    csrfHash: secretHash(csrf),
    memberId: null,
    createdAt: now,
    expiresAt: now + OAUTH_REQUEST_TTL_MS,
  } satisfies typeof mcpOauthRequests.$inferInsert;
  db.transaction(
    (tx) => {
      // Keep this client referenced while cleanup removes its ended grants.
      tx.insert(mcpOauthRequests).values(row).run();
      pruneOAuthState(tx as unknown as FluxmailDb, now);
    },
    { behavior: 'immediate' },
  );
  return { request: requestFromRow(row), csrf };
}

/** Find an unexpired request whose CSRF token matches. */
export function getOAuthAuthorizationRequest(
  db: FluxmailDb,
  id: string,
  csrf: string,
  now = Date.now(),
): OAuthAuthorizationRequest | null {
  const row = db
    .select()
    .from(mcpOauthRequests)
    .where(and(eq(mcpOauthRequests.id, id), gt(mcpOauthRequests.expiresAt, now)))
    .get();
  if (!row || !/^[0-9a-f]{64}$/.test(csrf) || !sameHash(row.csrfHash, secretHash(csrf))) return null;
  return requestFromRow(row);
}

/** Record the signed-in member on a request and rotate its CSRF token. */
export function signInOAuthAuthorizationRequest(
  db: FluxmailDb,
  id: string,
  memberId: string,
  now = Date.now(),
): string | null {
  const csrf = randomBytes(32).toString('hex');
  const updated = db
    .update(mcpOauthRequests)
    .set({ memberId, csrfHash: secretHash(csrf) })
    .where(and(eq(mcpOauthRequests.id, id), gt(mcpOauthRequests.expiresAt, now)))
    .run();
  return updated.changes === 1 ? csrf : null;
}

export function deleteOAuthAuthorizationRequest(db: FluxmailDb, id: string): void {
  db.delete(mcpOauthRequests).where(eq(mcpOauthRequests.id, id)).run();
}

/**
 * Turn a signed-in request into a grant and a single-use authorization code.
 * The request is deleted in the same transaction, so it cannot be approved twice.
 */
export function approveOAuthAuthorizationRequest(
  db: FluxmailDb,
  input: {
    requestId: string;
    memberId: string;
    scopes: readonly McpCapability[];
    accountIds: readonly string[] | null;
  },
  now = Date.now(),
): { code: string; grantId: string; redirectUri: string; state: string | null } | null {
  const code = `fmc_${randomBytes(32).toString('hex')}`;
  return db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(mcpOauthRequests)
        .where(
          and(
            eq(mcpOauthRequests.id, input.requestId),
            eq(mcpOauthRequests.memberId, input.memberId),
            gt(mcpOauthRequests.expiresAt, now),
          ),
        )
        .get();
      if (!row) return null;
      const requested = new Set<string>(requestFromRow(row).scopes);
      const scopes = mailScopesOf(input.scopes).filter((scope) => requested.has(scope));
      if (!scopes.length) return null;
      tx.delete(mcpOauthRequests).where(eq(mcpOauthRequests.id, row.id)).run();
      const grantId = `grant_${randomBytes(8).toString('hex')}`;
      tx.insert(mcpOauthGrants)
        .values({
          id: grantId,
          clientId: row.clientId,
          memberId: input.memberId,
          scopes: JSON.stringify(scopes),
          accountIds: input.accountIds === null ? null : JSON.stringify([...new Set(input.accountIds)]),
          createdAt: now,
          expiresAt: now + OAUTH_GRANT_TTL_MS,
          lastUsedAt: null,
          revokedAt: null,
        })
        .run();
      // Every grant gets a refresh token, so clients that omit offline_access
      // are not asked to sign in again every 15 minutes.
      const tokenScopes = canonicalOAuthScopes([...scopes, OFFLINE_ACCESS_SCOPE]);
      tx.insert(mcpOauthCodes)
        .values({
          codeHash: secretHash(code),
          grantId,
          redirectUri: row.redirectUri,
          codeChallenge: row.codeChallenge,
          scopes: JSON.stringify(tokenScopes),
          createdAt: now,
          expiresAt: now + OAUTH_CODE_TTL_MS,
          consumedAt: null,
        })
        .run();
      tx.update(mcpOauthClients).set({ lastUsedAt: now }).where(eq(mcpOauthClients.id, row.clientId)).run();
      return { code, grantId, redirectUri: row.redirectUri, state: row.state };
    },
    { behavior: 'immediate' },
  );
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const expected = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const actual = Buffer.from(challenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

type Tx = Parameters<Parameters<FluxmailDb['transaction']>[0]>[0];

function activeGrant(tx: Tx, grantId: string, now: number) {
  const grant = tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, grantId)).get();
  if (!grant || grant.revokedAt !== null || grant.expiresAt <= now) return null;
  const member = tx.select().from(members).where(eq(members.id, grant.memberId)).get();
  return member?.status === 'active' ? grant : null;
}

function revokeGrantInTx(tx: Tx, grantId: string, now: number): boolean {
  const revoked = tx
    .update(mcpOauthGrants)
    .set({ revokedAt: now })
    .where(and(eq(mcpOauthGrants.id, grantId), isNull(mcpOauthGrants.revokedAt)))
    .run();
  tx.delete(mcpOauthTokens).where(eq(mcpOauthTokens.grantId, grantId)).run();
  tx.delete(mcpOauthCodes).where(eq(mcpOauthCodes.grantId, grantId)).run();
  return revoked.changes > 0;
}

function issueTokens(
  tx: Tx,
  grant: typeof mcpOauthGrants.$inferSelect,
  scopes: readonly OAuthScope[],
  now: number,
): OAuthTokenSet {
  const accessToken = `fmo_${randomBytes(32).toString('hex')}`;
  const accessExpiresAt = Math.min(now + OAUTH_ACCESS_TOKEN_TTL_MS, grant.expiresAt);
  const serialized = JSON.stringify(scopes);
  tx.insert(mcpOauthTokens)
    .values({
      tokenHash: secretHash(accessToken),
      grantId: grant.id,
      kind: 'access',
      scopes: serialized,
      createdAt: now,
      expiresAt: accessExpiresAt,
      rotatedAt: null,
    })
    .run();
  let refreshToken: string | undefined;
  if (scopes.includes(OFFLINE_ACCESS_SCOPE)) {
    refreshToken = `fmr_${randomBytes(32).toString('hex')}`;
    tx.insert(mcpOauthTokens)
      .values({
        tokenHash: secretHash(refreshToken),
        grantId: grant.id,
        kind: 'refresh',
        scopes: serialized,
        createdAt: now,
        expiresAt: Math.min(now + OAUTH_REFRESH_TOKEN_TTL_MS, grant.expiresAt),
        rotatedAt: null,
      })
      .run();
  }
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresIn: Math.max(1, Math.floor((accessExpiresAt - now) / 1000)),
    scopes: [...scopes],
  };
}

const INVALID_GRANT = (description: string): OAuthTokenResult => ({ ok: false, error: 'invalid_grant', description });

/** Exchange an authorization code. Replaying a used code revokes its grant. */
export function exchangeOAuthAuthorizationCode(
  db: FluxmailDb,
  input: { code: string; clientId: string; redirectUri: string; codeVerifier: string },
  now = Date.now(),
): OAuthTokenResult {
  return db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(mcpOauthCodes)
        .where(eq(mcpOauthCodes.codeHash, secretHash(input.code)))
        .get();
      if (!row) return INVALID_GRANT('The authorization code is invalid.');
      const grant = tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, row.grantId)).get();
      if (!grant || grant.clientId !== input.clientId) return INVALID_GRANT('The authorization code is invalid.');
      if (row.consumedAt !== null) {
        revokeGrantInTx(tx, grant.id, now);
        return INVALID_GRANT('The authorization code was already used.');
      }
      if (row.expiresAt <= now) return INVALID_GRANT('The authorization code has expired.');
      if (row.redirectUri !== input.redirectUri) return INVALID_GRANT('redirect_uri does not match the authorization.');
      if (!pkceMatches(input.codeVerifier, row.codeChallenge)) return INVALID_GRANT('PKCE verification failed.');
      const active = activeGrant(tx, grant.id, now);
      if (!active) return INVALID_GRANT('The authorization is no longer active.');
      tx.update(mcpOauthCodes).set({ consumedAt: now }).where(eq(mcpOauthCodes.codeHash, row.codeHash)).run();
      return {
        ok: true,
        tokens: issueTokens(tx, active, canonicalOAuthScopes(parseStringArray(row.scopes)), now),
      } as const;
    },
    { behavior: 'immediate' },
  );
}

/**
 * Rotate a refresh token. Reusing a rotated token revokes the grant. A refresh
 * can keep or narrow its scopes but never add one.
 */
export function refreshOAuthTokens(
  db: FluxmailDb,
  input: { refreshToken: string; clientId: string; scopes?: readonly string[] },
  now = Date.now(),
): OAuthTokenResult {
  return db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(mcpOauthTokens)
        .where(and(eq(mcpOauthTokens.tokenHash, secretHash(input.refreshToken)), eq(mcpOauthTokens.kind, 'refresh')))
        .get();
      if (!row) return INVALID_GRANT('The refresh token is invalid.');
      const grant = tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, row.grantId)).get();
      if (!grant || grant.clientId !== input.clientId) return INVALID_GRANT('The refresh token is invalid.');
      if (row.rotatedAt !== null) {
        revokeGrantInTx(tx, grant.id, now);
        return INVALID_GRANT('The refresh token was already used.');
      }
      if (row.expiresAt <= now) return INVALID_GRANT('The refresh token has expired.');
      const active = activeGrant(tx, grant.id, now);
      if (!active) return INVALID_GRANT('The authorization is no longer active.');
      const current = canonicalOAuthScopes(parseStringArray(row.scopes));
      let scopes = current;
      if (input.scopes) {
        if (!input.scopes.every((scope) => (current as string[]).includes(scope))) {
          return { ok: false, error: 'invalid_scope', description: 'A refresh cannot add scopes.' } as const;
        }
        scopes = canonicalOAuthScopes([...input.scopes, OFFLINE_ACCESS_SCOPE]);
      }
      if (!mailScopesOf(scopes).length) {
        return { ok: false, error: 'invalid_scope', description: 'Request at least one mail scope.' } as const;
      }
      tx.update(mcpOauthTokens).set({ rotatedAt: now }).where(eq(mcpOauthTokens.tokenHash, row.tokenHash)).run();
      return { ok: true, tokens: issueTokens(tx, active, scopes, now) } as const;
    },
    { behavior: 'immediate' },
  );
}

/**
 * Revoke the grant behind a token when the token belongs to the client.
 * Unknown tokens are ignored, as RFC 7009 requires.
 */
export function revokeOAuthToken(db: FluxmailDb, input: { token: string; clientId: string }, now = Date.now()): void {
  db.transaction(
    (tx) => {
      const row = tx
        .select({ grantId: mcpOauthTokens.grantId, clientId: mcpOauthGrants.clientId })
        .from(mcpOauthTokens)
        .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthTokens.grantId))
        .where(eq(mcpOauthTokens.tokenHash, secretHash(input.token)))
        .get();
      if (row && row.clientId === input.clientId) revokeGrantInTx(tx, row.grantId, now);
    },
    { behavior: 'immediate' },
  );
}

/** Verify an access token against its live grant and member. */
export function authenticateOAuthAccessToken(
  db: FluxmailDb,
  token: string,
  now = Date.now(),
): OAuthAccessTokenAuth | null {
  const row = db
    .select({
      tokenScopes: mcpOauthTokens.scopes,
      tokenExpiresAt: mcpOauthTokens.expiresAt,
      grantId: mcpOauthGrants.id,
      clientId: mcpOauthGrants.clientId,
      memberId: mcpOauthGrants.memberId,
      grantScopes: mcpOauthGrants.scopes,
      accountIds: mcpOauthGrants.accountIds,
      grantExpiresAt: mcpOauthGrants.expiresAt,
      revokedAt: mcpOauthGrants.revokedAt,
      lastUsedAt: mcpOauthGrants.lastUsedAt,
      role: members.role,
      status: members.status,
    })
    .from(mcpOauthTokens)
    .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthTokens.grantId))
    .innerJoin(members, eq(members.id, mcpOauthGrants.memberId))
    .where(and(eq(mcpOauthTokens.tokenHash, secretHash(token)), eq(mcpOauthTokens.kind, 'access')))
    .get();
  if (!row || row.tokenExpiresAt <= now || row.grantExpiresAt <= now || row.revokedAt !== null) return null;
  if (row.status !== 'active') return null;
  try {
    const granted = new Set(parseStringArray(row.grantScopes));
    const scopes = mailScopesOf(parseStringArray(row.tokenScopes)).filter((scope) => granted.has(scope));
    if (!scopes.length) return null;
    const accountIds = parseAccountIds(row.accountIds);
    if (row.lastUsedAt === null || now - row.lastUsedAt >= GRANT_TOUCH_INTERVAL_MS) {
      db.update(mcpOauthGrants).set({ lastUsedAt: now }).where(eq(mcpOauthGrants.id, row.grantId)).run();
    }
    return {
      grantId: row.grantId,
      clientId: row.clientId,
      memberId: row.memberId,
      role: row.role as MemberRole,
      scopes,
      accountIds,
    };
  } catch {
    return null;
  }
}

/** Active grants, optionally for one member, newest first. */
export function listOAuthGrants(db: FluxmailDb, memberId?: string, now = Date.now()): OAuthGrantInfo[] {
  return db
    .select({ grant: mcpOauthGrants, clientName: mcpOauthClients.name, clientKind: mcpOauthClients.kind })
    .from(mcpOauthGrants)
    .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientId))
    .where(
      and(
        isNull(mcpOauthGrants.revokedAt),
        gt(mcpOauthGrants.expiresAt, now),
        memberId ? eq(mcpOauthGrants.memberId, memberId) : undefined,
      ),
    )
    .all()
    .map(({ grant, clientName, clientKind }) => ({
      id: grant.id,
      clientId: grant.clientId,
      clientName,
      clientKind: clientKind as OAuthClientKind,
      memberId: grant.memberId,
      scopes: mailScopesOf(parseStringArray(grant.scopes)),
      accountIds: parseAccountIds(grant.accountIds),
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      lastUsedAt: grant.lastUsedAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function getOAuthGrant(db: FluxmailDb, grantId: string, now = Date.now()): OAuthGrantInfo | null {
  return listOAuthGrants(db, undefined, now).find((grant) => grant.id === grantId) ?? null;
}

/** Revoke one active grant. Pass memberId to limit the change to that member's grants. */
export function revokeOAuthGrant(db: FluxmailDb, grantId: string, memberId?: string, now = Date.now()): boolean {
  return db.transaction(
    (tx) => {
      const grant = tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, grantId)).get();
      if (!grant || grant.revokedAt !== null || grant.expiresAt <= now) return false;
      if (memberId && grant.memberId !== memberId) return false;
      return revokeGrantInTx(tx, grant.id, now);
    },
    { behavior: 'immediate' },
  );
}

/** Revoke every grant a member approved, for suspension and password changes. */
export function revokeMemberOAuthGrants(db: FluxmailDb | Tx, memberId: string, now = Date.now()): number {
  db.delete(mcpOauthRequests).where(eq(mcpOauthRequests.memberId, memberId)).run();
  const grants = db
    .select({ id: mcpOauthGrants.id })
    .from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.memberId, memberId), isNull(mcpOauthGrants.revokedAt)))
    .all();
  if (!grants.length) return 0;
  const ids = grants.map((grant) => grant.id);
  db.update(mcpOauthGrants).set({ revokedAt: now }).where(inArray(mcpOauthGrants.id, ids)).run();
  db.delete(mcpOauthTokens).where(inArray(mcpOauthTokens.grantId, ids)).run();
  db.delete(mcpOauthCodes).where(inArray(mcpOauthCodes.grantId, ids)).run();
  return ids.length;
}

/** Replace the mailbox narrowing of an active grant. Existing tokens use it on their next request. */
export function updateOAuthGrantAccounts(
  db: FluxmailDb,
  grantId: string,
  accountIds: readonly string[] | null,
  now = Date.now(),
): boolean {
  return (
    db
      .update(mcpOauthGrants)
      .set({ accountIds: accountIds === null ? null : JSON.stringify([...new Set(accountIds)]) })
      .where(and(eq(mcpOauthGrants.id, grantId), isNull(mcpOauthGrants.revokedAt), gt(mcpOauthGrants.expiresAt, now)))
      .run().changes > 0
  );
}

/** Count active grants per member for listings. */
export function countActiveOAuthGrants(db: FluxmailDb, memberId: string, now = Date.now()): number {
  return (
    db
      .select({ value: count() })
      .from(mcpOauthGrants)
      .where(
        and(eq(mcpOauthGrants.memberId, memberId), isNull(mcpOauthGrants.revokedAt), gt(mcpOauthGrants.expiresAt, now)),
      )
      .get()?.value ?? 0
  );
}
