import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { FluxmailDb } from '../storage/db.js';
import {
  countOAuthClients,
  getOAuthClient,
  OAUTH_MAX_CLIENTS,
  OAUTH_MAX_CLIENTS_PER_HOST,
  pruneOAuthState,
  reserveOAuthRateLimit,
  storeMetadataOAuthClient,
  type OAuthClient,
} from '../storage/oauth.js';
import { validateRedirectUri } from './redirectUris.js';

const MAX_DOCUMENT_BYTES = 5 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_CACHE_MS = 60 * 60 * 1000;
const FETCHES_PER_MINUTE = 120;
const FETCHES_PER_ORIGIN_PER_MINUTE = 30;

export interface MetadataResponse {
  status: number;
  cacheControl: string | null;
  body: string;
}

/** Fetch a metadata document. Implementations must refuse redirects and private addresses. */
export type MetadataFetcher = (url: URL) => Promise<MetadataResponse>;

export type MetadataClientResolution =
  | { status: 'ok'; client: OAuthClient; source: 'cached' | 'fetched' | 'stale' }
  | { status: 'invalid'; reason: string }
  | { status: 'unavailable'; reason: string };

/** Thrown for a transient fetch problem, when a stored client may still be used. */
export class MetadataFetchUnavailable extends Error {}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6 && /^::ffff:/i.test(address)) {
    // Check an IPv4-mapped address as the IPv4 address it carries.
    const mapped = address.slice('::ffff:'.length);
    return isIP(mapped) === 4 && isPublicAddress(mapped);
  }
  return !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** A client id URL must already be in canonical form, with a path and without a query or fragment. */
export function canonicalClientMetadataUrl(id: string): URL | null {
  if (id.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname === '/' || url.href !== id || isIP(url.hostname.replace(/^\[|\]$/g, ''))) return null;
  return url;
}

export function isClientMetadataUrl(id: string): boolean {
  return id.startsWith('https://');
}

/**
 * Fetch over HTTPS with one DNS resolution. Every resolved address must be
 * public, and the connection uses the address that was checked.
 */
export const fetchClientMetadata: MetadataFetcher = async (url) => {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new MetadataFetchUnavailable('The client metadata host could not be resolved.');
  }
  if (!addresses.length || !addresses.every((entry) => isPublicAddress(entry.address))) {
    throw new Error('The client metadata host resolves to a private or reserved address.');
  }
  const pinned = addresses[0]!;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [
        pinned,
      ]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
  return new Promise<MetadataResponse>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: 'GET',
        lookup,
        timeout: FETCH_TIMEOUT_MS,
        headers: { accept: 'application/json', 'user-agent': 'Fluxmail' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) {
            request.destroy();
            reject(new Error('The client metadata document is larger than 5 KB.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            cacheControl:
              typeof response.headers['cache-control'] === 'string' ? response.headers['cache-control'] : null,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', () => reject(new MetadataFetchUnavailable('The client metadata fetch failed.')));
      },
    );
    request.on('timeout', () => request.destroy(new MetadataFetchUnavailable('The client metadata fetch timed out.')));
    request.on('error', (error) =>
      reject(error instanceof MetadataFetchUnavailable ? error : new MetadataFetchUnavailable(error.message)),
    );
    request.end();
  });
};

function cacheLifetime(cacheControl: string | null): number {
  if (!cacheControl) return MAX_CACHE_MS;
  const directives = cacheControl.toLowerCase();
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/.test(directives)) return 0;
  const maxAge = directives.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/);
  return maxAge ? Math.min(Number(maxAge[1]) * 1000, MAX_CACHE_MS) : MAX_CACHE_MS;
}

interface ParsedDocument {
  name: string;
  redirectUris: string[];
}

function parseDocument(id: string, body: string): ParsedDocument {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new Error('The client metadata document is not valid JSON.');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('The client metadata document must be a JSON object.');
  }
  const fields = document as Record<string, unknown>;
  if (fields.client_id !== id) throw new Error('client_id in the metadata document does not match its URL.');
  if ('client_secret' in fields || 'client_secret_expires_at' in fields) {
    throw new Error('A client metadata document cannot contain a client secret.');
  }
  const name = typeof fields.client_name === 'string' ? fields.client_name.trim() : '';
  if (!name || name.length > 200) throw new Error('The client metadata document needs a client_name.');
  const method = fields.token_endpoint_auth_method;
  const supported = fields.token_endpoint_auth_methods_supported;
  const allowsNone =
    method === undefined || method === 'none' || (Array.isArray(supported) && supported.includes('none'));
  if (!allowsNone) throw new Error('Fluxmail only accepts public clients that use token_endpoint_auth_method none.');
  const redirectUris = fields.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    !redirectUris.length ||
    redirectUris.length > 20 ||
    !redirectUris.every((uri) => typeof uri === 'string' && validateRedirectUri(uri) === null)
  ) {
    throw new Error('The client metadata document needs valid redirect_uris.');
  }
  return { name, redirectUris: redirectUris as string[] };
}

/**
 * Resolve a client whose id is the URL of its metadata document. A fresh
 * stored copy is used without fetching. If a refetch fails for a transient
 * reason, the stored copy keeps existing connections working.
 */
export async function resolveMetadataClient(
  db: FluxmailDb,
  id: string,
  fetcher: MetadataFetcher,
  now = Date.now(),
): Promise<MetadataClientResolution> {
  const url = canonicalClientMetadataUrl(id);
  if (!url) return { status: 'invalid', reason: 'client_id must be a canonical HTTPS URL with a path.' };
  const stored = getOAuthClient(db, id);
  if (stored && stored.kind === 'metadata_document' && (stored.metadataExpiresAt ?? 0) > now) {
    return { status: 'ok', client: stored, source: 'cached' };
  }
  const stale = (reason: string): MetadataClientResolution =>
    stored ? { status: 'ok', client: stored, source: 'stale' } : { status: 'unavailable', reason };
  // Drop abandoned clients first so they don't hold the quota forever.
  if (!stored) pruneOAuthState(db, now);
  if (
    !stored &&
    (countOAuthClients(db) >= OAUTH_MAX_CLIENTS || countOAuthClients(db, url.hostname) >= OAUTH_MAX_CLIENTS_PER_HOST)
  ) {
    return { status: 'unavailable', reason: 'Fluxmail has reached its OAuth client limit.' };
  }
  if (
    !reserveOAuthRateLimit(db, 'metadata', FETCHES_PER_MINUTE, 60_000, now) ||
    !reserveOAuthRateLimit(db, `metadata:${url.origin}`, FETCHES_PER_ORIGIN_PER_MINUTE, 60_000, now)
  ) {
    return stale('Too many client metadata requests. Try again shortly.');
  }

  let response: MetadataResponse;
  try {
    response = await fetcher(url);
  } catch (error) {
    if (error instanceof MetadataFetchUnavailable) return stale('The client metadata document could not be fetched.');
    return { status: 'invalid', reason: error instanceof Error ? error.message : 'Invalid client metadata.' };
  }
  if (response.status >= 500) return stale('The client metadata server returned an error.');
  if (response.status !== 200) {
    return { status: 'invalid', reason: `The client metadata document returned HTTP ${response.status}.` };
  }
  let parsed: ParsedDocument;
  try {
    parsed = parseDocument(id, response.body);
  } catch (error) {
    return { status: 'invalid', reason: (error as Error).message };
  }
  const result = storeMetadataOAuthClient(
    db,
    {
      id,
      host: url.hostname,
      name: parsed.name,
      redirectUris: parsed.redirectUris,
      expiresAt: now + cacheLifetime(response.cacheControl),
    },
    now,
  );
  if (result.status === 'limit')
    return { status: 'unavailable', reason: 'Fluxmail has reached its OAuth client limit.' };
  return { status: 'ok', client: result.client, source: 'fetched' };
}
