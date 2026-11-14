/**
 * Operator admin auth for the guardrails routes.
 *
 * These routes are not Hub service-token routes. They follow the same pattern as
 * the existing admin endpoints on proba-audit and proba-memory: a verified
 * Firebase ID token whose email is on the administrator list. An empty list
 * allows nobody. Viewers cannot read or write guardrails. The Hub caller
 * allowlists are not widened.
 */
import { IdentityRejectedError, TokenVerificationError, type IdentityCredentials } from '../ports/auth.js';
import { FirebaseTokenVerifier, type FirebaseVerifierOptions, type VerifiedIdentity } from './firebase.js';

export interface AdminSession {
  subject: string;
  email: string;
  role: 'admin';
}

export interface AdminAuth {
  readonly name: string;
  authenticate(credentials: IdentityCredentials): Promise<AdminSession>;
}

export type AdminDenialReason = 'email_required' | 'email_not_verified' | 'not_allowed';

export class AdminAuthorizationError extends IdentityRejectedError {
  readonly reason: AdminDenialReason;
  constructor(reason: AdminDenialReason, message: string) {
    super('not_allowed', message);
    this.name = 'AdminAuthorizationError';
    this.reason = reason;
  }
}

export type AdminAuthorization = { ok: true; session: AdminSession } | { ok: false; reason: AdminDenialReason };

/**
 * Only addresses on the administrator list may use the admin routes.
 * The email must be present and verified by the identity provider.
 * An empty list allows nobody.
 */
export function authorizeAdmin(identity: VerifiedIdentity, adminEmails: readonly string[]): AdminAuthorization {
  if (!identity.email) return { ok: false, reason: 'email_required' };
  if (!identity.emailVerified) return { ok: false, reason: 'email_not_verified' };
  const email = identity.email.trim().toLowerCase();
  if (!adminEmails.includes(email)) return { ok: false, reason: 'not_allowed' };
  return { ok: true, session: { subject: identity.subject, email, role: 'admin' } };
}

const DENIAL_MESSAGE: Record<AdminDenialReason, string> = {
  email_required: 'A verified email is required',
  email_not_verified: 'The email on this account is not verified',
  not_allowed: 'Administrator access is required',
};

function bearer(authorization: string | undefined): string {
  if (typeof authorization !== 'string' || authorization.trim() === '') {
    throw new TokenVerificationError('invalid_token', 'Authorization bearer token is required');
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) throw new TokenVerificationError('invalid_token', 'Authorization bearer token is required');
  return match[1];
}

export class FirebaseAdminAuth implements AdminAuth {
  readonly name = 'firebase-admin';
  private readonly verifier: FirebaseTokenVerifier;
  private readonly adminEmails: readonly string[];

  constructor(options: FirebaseVerifierOptions & { adminEmails: readonly string[] }) {
    this.verifier = new FirebaseTokenVerifier(options);
    this.adminEmails = options.adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  }

  async authenticate(credentials: IdentityCredentials): Promise<AdminSession> {
    const identity = await this.verifier.verify(bearer(credentials.authorization));
    const result = authorizeAdmin(identity, this.adminEmails);
    if (!result.ok) throw new AdminAuthorizationError(result.reason, DENIAL_MESSAGE[result.reason]);
    return result.session;
  }
}
