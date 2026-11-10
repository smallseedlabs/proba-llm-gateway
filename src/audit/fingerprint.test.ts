import { describe, expect, it } from 'vitest';
import { canonicalJson, legacyRequestFingerprint, requestFingerprint } from './fingerprint.js';
import { testRunRequest } from '../testing/fixtures.js';
import { reverseKeysDeep } from '../testing/reorder.js';

describe('request fingerprint', () => {
  it('sorts keys at every depth and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('is stable when storage reorders keys (Postgres JSONB)', () => {
    const req = testRunRequest({ userSuppliedInput: { landingPageUrl: 'https://example.com', revision: 2 } as never, budget: { maxCostUsd: 1, currency: 'USD' } as never });
    expect(requestFingerprint(reverseKeysDeep(req))).toBe(requestFingerprint(req));
    expect(legacyRequestFingerprint(reverseKeysDeep(req))).not.toBe(legacyRequestFingerprint(req));
  });

  it('still changes when a value changes', () => {
    const req = testRunRequest();
    const other = testRunRequest({ stepId: 'step-2' });
    expect(requestFingerprint(other)).not.toBe(requestFingerprint(req));
  });
});
