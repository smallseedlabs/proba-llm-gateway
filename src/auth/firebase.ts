/**
 * Firebase ID token verification without a service account: the same checks as
 * proba-hub, proba-audit and proba-memory. Used only for the operator admin
 * routes (guardrails). Hub → gateway run traffic stays on EdDSA service tokens.
 *
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { TokenVerificationError } from '../ports/auth.js';

export const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export const firebaseIssuer = (projectId: string): string => `https://securetoken.google.com/${projectId}`;

export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface FirebaseVerifierOptions {
  projectId: string;
  keys?: JWTVerifyGetKey;
  clockToleranceSec?: number;
  now?: () => Date;
}

const MAX_SUBJECT_LENGTH = 128;
const MAX_TOKEN_LENGTH = 8192;
const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export class FirebaseTokenVerifier {
  readonly name = 'firebase';
  private readonly projectId: string;
  private readonly keys: JWTVerifyGetKey;
  private readonly tolerance: number;
  private readonly now: () => Date;

  constructor(options: FirebaseVerifierOptions) {
    this.projectId = options.projectId.trim();
    if (!this.projectId) throw new Error('A Firebase project ID (FIREBASE_PROJECT_ID) is required to verify Firebase ID tokens');
    this.keys = options.keys ?? createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
    this.tolerance = options.clockToleranceSec ?? 5;
    this.now = options.now ?? (() => new Date());
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) {
      throw new TokenVerificationError('invalid_token', 'Malformed ID token');
    }
    const currentDate = this.now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        algorithms: ['RS256'],
        issuer: firebaseIssuer(this.projectId),
        audience: this.projectId,
        clockTolerance: this.tolerance,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'auth_time'],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw new TokenVerificationError('token_expired', 'ID token has expired');
      if (!(error instanceof joseErrors.JOSEError) || error instanceof joseErrors.JWKSTimeout || /Expected 200 OK/.test(error.message)) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new TokenVerificationError('invalid_token', `ID token rejected: ${reason}`);
    }

    const nowSec = Math.floor(currentDate.getTime() / 1000);
    const { sub, iat, auth_time: authTime } = payload as JWTPayload & { auth_time?: unknown };
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_SUBJECT_LENGTH) {
      throw new TokenVerificationError('invalid_token', 'ID token has an invalid subject');
    }
    if (!isPositiveNumber(iat) || iat > nowSec + this.tolerance) {
      throw new TokenVerificationError('invalid_token', 'ID token was issued in the future');
    }
    if (!isPositiveNumber(authTime) || authTime > nowSec + this.tolerance) {
      throw new TokenVerificationError('invalid_token', 'ID token has an invalid auth_time');
    }
    const claims = payload as JWTPayload & { email?: unknown; email_verified?: unknown; name?: unknown };
    return {
      subject: sub,
      email: typeof claims.email === 'string' && claims.email ? claims.email : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
    };
  }
}
