import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { EmailError } from './errors.js';
import type { EmailQuery, Provider } from './types.js';

const CURSOR_VERSION = 1;
const CURSOR_LIFETIME_MS = 60 * 60 * 1_000;
const MAX_CURSOR_BYTES = 16 * 1_024;
const HKDF_CONTEXT = 'fluxmail/search-page-token/v1';

interface SearchCursorPayload {
  v: typeof CURSOR_VERSION;
  accountId: string;
  provider: Provider;
  queryHash: string;
  pageSize: number;
  includeSnippet?: boolean;
  includeSearchContext?: boolean;
  providerToken: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SearchCursorOptions {
  /** The error for a token that is malformed, expired, forged or bound to another search. */
  invalidCursor?: () => Error;
}

function canonicalQuery(query: EmailQuery): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

export function emailQueryHash(query: EmailQuery): string {
  return createHash('sha256').update(canonicalQuery(query)).digest('base64url');
}

/**
 * Node only, so it ships as `@fluxmail/core/search-cursor` instead of the root export.
 *
 * Wraps a provider's page token in a signed, expiring cursor bound to the account, query and
 * page options, so a token can't be replayed against a different search.
 */
export class SearchCursorCodec {
  private readonly key: Buffer;
  private readonly invalidCursor: () => Error;

  constructor(secret: Buffer, options: SearchCursorOptions = {}) {
    this.key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), HKDF_CONTEXT, 32));
    this.invalidCursor =
      options.invalidCursor ?? (() => new EmailError('invalid_request', 'Invalid or expired search page token.'));
  }

  encode(
    binding: {
      accountId: string;
      provider: Provider;
      query: EmailQuery;
      pageSize: number;
      includeSnippet?: boolean;
      includeSearchContext?: boolean;
      providerToken: string;
    },
    now = Date.now(),
  ): string {
    const payload: SearchCursorPayload = {
      v: CURSOR_VERSION,
      accountId: binding.accountId,
      provider: binding.provider,
      queryHash: emailQueryHash(binding.query),
      pageSize: binding.pageSize,
      ...(binding.includeSnippet !== undefined ? { includeSnippet: binding.includeSnippet } : {}),
      ...(binding.includeSearchContext ? { includeSearchContext: true } : {}),
      providerToken: binding.providerToken,
      issuedAt: now,
      expiresAt: now + CURSOR_LIFETIME_MS,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.key).update(encodedPayload).digest('base64url');
    const token = `${encodedPayload}.${signature}`;
    if (Buffer.byteLength(token) > MAX_CURSOR_BYTES) {
      throw new EmailError('invalid_request', 'The provider returned a search page token that is too large.');
    }
    return token;
  }

  decode(
    token: string,
    binding: {
      accountId: string;
      provider: Provider;
      query: EmailQuery;
      pageSize: number;
      includeSnippet?: boolean;
      includeSearchContext?: boolean;
    },
    now = Date.now(),
  ): string {
    if (Buffer.byteLength(token) > MAX_CURSOR_BYTES) throw this.invalidCursor();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw this.invalidCursor();
    const [encodedPayload, encodedSignature] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
      throw this.invalidCursor();
    }

    let suppliedSignature: Buffer;
    try {
      suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    } catch {
      throw this.invalidCursor();
    }
    if (suppliedSignature.toString('base64url') !== encodedSignature) throw this.invalidCursor();
    const expectedSignature = createHmac('sha256', this.key).update(encodedPayload).digest();
    if (suppliedSignature.length !== expectedSignature.length) throw this.invalidCursor();
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) throw this.invalidCursor();

    let payload: SearchCursorPayload;
    try {
      const bytes = Buffer.from(encodedPayload, 'base64url');
      if (bytes.toString('base64url') !== encodedPayload) throw new Error();
      payload = JSON.parse(bytes.toString('utf8')) as SearchCursorPayload;
    } catch {
      throw this.invalidCursor();
    }
    if (
      !payload ||
      payload.v !== CURSOR_VERSION ||
      typeof payload.accountId !== 'string' ||
      !['gmail', 'outlook', 'imap'].includes(payload.provider) ||
      typeof payload.queryHash !== 'string' ||
      !Number.isInteger(payload.pageSize) ||
      (payload.includeSnippet !== undefined && typeof payload.includeSnippet !== 'boolean') ||
      (payload.includeSearchContext !== undefined && typeof payload.includeSearchContext !== 'boolean') ||
      typeof payload.providerToken !== 'string' ||
      !payload.providerToken ||
      !Number.isFinite(payload.issuedAt) ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt !== payload.issuedAt + CURSOR_LIFETIME_MS ||
      payload.issuedAt > now ||
      payload.expiresAt <= now
    ) {
      throw this.invalidCursor();
    }
    if (
      payload.accountId !== binding.accountId ||
      payload.provider !== binding.provider ||
      payload.queryHash !== emailQueryHash(binding.query) ||
      payload.pageSize !== binding.pageSize ||
      payload.includeSnippet !== binding.includeSnippet ||
      (payload.includeSearchContext ?? false) !== (binding.includeSearchContext ?? false)
    ) {
      throw this.invalidCursor();
    }
    return payload.providerToken;
  }
}
