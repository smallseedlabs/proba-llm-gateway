/**
 * Swappable inbound Hub-auth port.
 *
 * Caller identity comes only from a verified short-lived service token
 * (signature, issuer, audience `proba-gateway`, expiry, allowlisted subject).
 * Request headers/body are not a source of caller identity. Workspace in the
 * body is scoped against an optional `workspaceId` claim when the token has one.
 */

export interface IdentityCredentials {
  /** Raw `Authorization` header. */
  authorization?: string;
}

export interface VerifiedCaller {
  issuer: string;
  subject: string;
  jti: string;
  keyId: string;
  expiresAt: Date;
  /** Present only when the Hub token carries a workspaceId claim. */
  workspaceId?: string;
}

export class IdentityRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdentityRejectedError';
    this.code = code;
  }
}

export class TokenVerificationError extends IdentityRejectedError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'TokenVerificationError';
  }
}

export interface ServiceAuth {
  readonly name: string;
  authenticate(credentials: IdentityCredentials): Promise<VerifiedCaller>;
}
