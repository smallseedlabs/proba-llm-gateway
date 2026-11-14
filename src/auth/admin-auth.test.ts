import { describe, expect, it } from 'vitest';
import { authorizeAdmin } from './admin-auth.js';
import type { VerifiedIdentity } from './firebase.js';

const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  subject: 'uid-1',
  email: 'owner@example.com',
  emailVerified: true,
  name: 'Owner',
  ...over,
});

describe('authorizeAdmin', () => {
  it('grants only emails on the administrator list', () => {
    const ok = authorizeAdmin(identity(), ['owner@example.com']);
    expect(ok).toEqual({ ok: true, session: { subject: 'uid-1', email: 'owner@example.com', role: 'admin' } });
  });

  it('is case-insensitive on the address and allows nobody when the list is empty', () => {
    expect(authorizeAdmin(identity({ email: 'Owner@Example.COM' }), ['owner@example.com']).ok).toBe(true);
    expect(authorizeAdmin(identity(), [])).toEqual({ ok: false, reason: 'not_allowed' });
  });

  it('refuses missing, unverified or unknown emails (viewers included)', () => {
    expect(authorizeAdmin(identity({ email: null }), ['owner@example.com'])).toEqual({ ok: false, reason: 'email_required' });
    expect(authorizeAdmin(identity({ emailVerified: false }), ['owner@example.com'])).toEqual({ ok: false, reason: 'email_not_verified' });
    expect(authorizeAdmin(identity({ email: 'viewer@example.com' }), ['owner@example.com'])).toEqual({ ok: false, reason: 'not_allowed' });
  });
});
