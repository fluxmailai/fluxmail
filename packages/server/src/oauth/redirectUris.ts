const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'ftp:',
  'ws:',
  'wss:',
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** True when a redirect can only reach a program on the member's own computer. */
export function isLocalRedirectUri(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Accept HTTPS redirects, plain HTTP only on loopback, and private-use schemes
 * for native apps. Returns an error message, or null when the URI is valid.
 */
export function validateRedirectUri(value: string): string | null {
  if (value.length > 2_000) return 'Redirect URIs are limited to 2,000 characters.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Redirect URIs must be absolute URLs.';
  }
  if (url.hash || value.includes('#')) return 'Redirect URIs cannot contain a fragment.';
  if (url.username || url.password) return 'Redirect URIs cannot contain credentials.';
  if (url.protocol === 'https:') return url.hostname ? null : 'HTTPS redirect URIs need a host.';
  if (url.protocol === 'http:')
    return isLoopbackHttp(url) ? null : 'Plain HTTP redirect URIs must use a loopback host.';
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return `The ${url.protocol} scheme is not allowed for redirect URIs.`;
  return null;
}

/**
 * Exact string match, except that a loopback HTTP redirect may use any port,
 * as RFC 8252 requires for native apps.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let target: URL;
  try {
    target = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(target)) return false;
  return registered.some((candidate) => {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return false;
    }
    if (!isLoopbackHttp(url)) return false;
    url.port = target.port;
    return url.href === target.href;
  });
}
