import { describe, expect, it } from 'vitest';
import { isPublicIp, parsePublicHttpUrl, UnsafeUrlError } from './ssrf.js';

describe('research SSRF guards', () => {
  it('accepts a public https URL without credentials or fragment', () => {
    const url = parsePublicHttpUrl('https://Example.com/offer#hash');
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('example.com');
    expect(url.hash).toBe('');
  });

  it('refuses loopback, private, metadata, credentials, and odd ports', () => {
    expect(() => parsePublicHttpUrl('http://127.0.0.1/')).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpUrl('http://10.0.0.5/')).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpUrl('http://192.168.1.9/')).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpUrl('http://169.254.169.254/latest/')).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpUrl('http://localhost/')).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpUrl('http://metadata.google.internal/')).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpUrl('https://user:pass@example.com/')).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpUrl('https://example.com:8443/')).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpUrl('file:///etc/passwd')).toThrow(UnsafeUrlError);
  });

  it('classifies IPv4/IPv6 reserved ranges as non-public', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('172.16.4.1')).toBe(false);
    expect(isPublicIp('100.64.1.1')).toBe(false);
    expect(isPublicIp('::1')).toBe(false);
    expect(isPublicIp('fc00::1')).toBe(false);
    expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
  });
});
