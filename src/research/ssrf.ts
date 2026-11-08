/**
 * SSRF guards for optional user-URL fetch. Private, loopback, link-local,
 * metadata, and credentialed URLs are refused. Redirects are not followed.
 * Page bytes are untrusted even when the URL is public.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export class UnsafeUrlError extends Error {
  readonly code = 'ssrf_blocked';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google',
  'metadata.google.internal',
  'metadata.internal',
]);

export function parsePublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('landing page URL is not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('landing page URL must be http or https');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('landing page URL must not include credentials');
  }
  const port = url.port;
  const defaultOk = !port || (url.protocol === 'http:' && port === '80') || (url.protocol === 'https:' && port === '443');
  if (!defaultOk) {
    throw new UnsafeUrlError('landing page URL must use port 80 or 443');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new UnsafeUrlError('landing page URL is missing a host');
  if (host.endsWith('.localhost') || host.endsWith('.local') || BLOCKED_HOSTS.has(host)) {
    throw new UnsafeUrlError('landing page host is not a public address');
  }
  if (isIP(host) && !isPublicIp(host)) {
    throw new UnsafeUrlError('landing page host is not a public address');
  }
  url.hash = '';
  return url;
}

export async function assertResolvedPublic(url: URL): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError('landing page host is not a public address');
    return [host];
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('landing page host could not be resolved');
  }
  if (records.length === 0) throw new UnsafeUrlError('landing page host could not be resolved');
  const addresses = records.map((row) => row.address);
  for (const address of addresses) {
    if (!isPublicIp(address)) {
      throw new UnsafeUrlError('landing page host resolved to a private or reserved address');
    }
  }
  return addresses;
}

export function isPublicIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPublicV4(ip);
  if (isIP(ip) === 6) return isPublicV6(ip);
  return false;
}

function isPublicV4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function isPublicV6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fec0:')) return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (normalized.startsWith('ff')) return false;
  const v4mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped?.[1]) return isPublicV4(v4mapped[1]);
  if (normalized.startsWith('2001:db8:')) return false;
  return true;
}
