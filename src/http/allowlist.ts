import { HostRefusedError } from '../errors.js';

export function hostKeyFromUrl(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  const port = url.port;
  if (!port) return hostname;
  const defaultPort = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
  if (port === defaultPort) return hostname;
  return `${hostname}:${port}`;
}

/**
 * Internal overlay HTTP is allowed when the host is allowlisted (Swarm
 * `http://llm:3600`, `http://context:3500`). Userinfo in the URL is refused.
 * Production still requires an explicit host allowlist.
 */
export function assertAllowedBaseUrl(baseUrl: string, allowedHosts: readonly string[], nodeEnv: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HostRefusedError(baseUrl);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HostRefusedError(hostKeyFromUrl(url));
  if (url.username || url.password) throw new HostRefusedError(hostKeyFromUrl(url));
  if (allowedHosts.length === 0) {
    if (nodeEnv === 'production') throw new HostRefusedError(hostKeyFromUrl(url));
    return url;
  }
  const key = hostKeyFromUrl(url);
  const lower = allowedHosts.map((h) => h.toLowerCase());
  if (!lower.includes(key) && !lower.includes(url.hostname.toLowerCase())) throw new HostRefusedError(key);
  return url;
}

export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
