import { errors as joseErrors, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import {
  CLOCK_SKEW_SECONDS,
  GATEWAY_AUDIENCE,
  MAX_JTI_LENGTH,
  MAX_TOKEN_LENGTH,
  SERVICE_TOKEN_MAX_TTL_SECONDS,
} from './constants.js';
import { TokenVerificationError, type IdentityCredentials, type ServiceAuth, type VerifiedCaller } from '../ports/auth.js';

export interface ServiceTokenVerifierOptions {
  keys: JWTVerifyGetKey;
  allowedIssuers: readonly string[];
  allowedSubjects: readonly string[];
  now?: () => Date;
}

function checkShape(token: string): void {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) {
    throw new TokenVerificationError('invalid_token', 'Malformed service token');
  }
  let kid: unknown;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new TokenVerificationError('invalid_token', 'Malformed service token');
  }
  if (typeof kid !== 'string' || kid === '') throw new TokenVerificationError('invalid_token', 'service token names no key id');
}

function rejection(error: unknown): never {
  if (error instanceof joseErrors.JWTExpired) throw new TokenVerificationError('token_expired', 'service token has expired');
  if (!(error instanceof joseErrors.JOSEError)) throw error;
  throw new TokenVerificationError('invalid_token', `service token rejected: ${error.message}`);
}

const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function bearer(authorization: string | undefined): string {
  if (typeof authorization !== 'string' || authorization.trim() === '') {
    throw new TokenVerificationError('invalid_token', 'Authorization bearer token is required');
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) throw new TokenVerificationError('invalid_token', 'Authorization bearer token is required');
  return match[1];
}

/**
 * Verifies EdDSA Hub service tokens: signature, iss allowlist, aud `proba-gateway`,
 * sub allowlist, exp/iat, max TTL, jti. Fail closed. Does not trust body identity.
 */
export class ServiceTokenAuth implements ServiceAuth {
  readonly name = 'service-token';
  private readonly keys: JWTVerifyGetKey;
  private readonly allowedIssuers: Set<string>;
  private readonly allowedSubjects: Set<string>;
  private readonly now: () => Date;

  constructor(options: ServiceTokenVerifierOptions) {
    this.keys = options.keys;
    this.allowedIssuers = new Set(options.allowedIssuers);
    this.allowedSubjects = new Set(options.allowedSubjects);
    this.now = options.now ?? (() => new Date());
    if (this.allowedIssuers.size === 0) throw new Error('caller issuer allowlist is empty');
    if (this.allowedSubjects.size === 0) throw new Error('caller subject allowlist is empty');
  }

  async authenticate(credentials: IdentityCredentials): Promise<VerifiedCaller> {
    const token = bearer(credentials.authorization);
    checkShape(token);
    const currentDate = this.now();
    let payload: JWTPayload;
    let keyId: string;
    try {
      const result = await jwtVerify(token, this.keys, {
        algorithms: ['EdDSA'],
        audience: GATEWAY_AUDIENCE,
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'iss', 'jti'],
      });
      payload = result.payload;
      keyId = result.protectedHeader.kid as string;
    } catch (error) {
      return rejection(error);
    }
    const { iss, sub, jti, iat, exp, workspaceId } = payload;
    if (typeof iss !== 'string' || !this.allowedIssuers.has(iss)) {
      throw new TokenVerificationError('invalid_token', 'service token issuer is not allowlisted');
    }
    if (typeof sub !== 'string' || !this.allowedSubjects.has(sub)) {
      throw new TokenVerificationError('invalid_token', 'service token subject is not allowlisted');
    }
    if (typeof jti !== 'string' || jti === '' || jti.length > MAX_JTI_LENGTH) {
      throw new TokenVerificationError('invalid_token', 'service token has an invalid jti');
    }
    if (!isPositiveNumber(iat) || !isPositiveNumber(exp) || exp <= iat) {
      throw new TokenVerificationError('invalid_token', 'service token has invalid iat or exp');
    }
    const nowSec = Math.floor(currentDate.getTime() / 1000);
    if (exp - iat > SERVICE_TOKEN_MAX_TTL_SECONDS) {
      throw new TokenVerificationError('invalid_token', `service token lives longer than ${SERVICE_TOKEN_MAX_TTL_SECONDS} seconds`);
    }
    if (iat > nowSec + CLOCK_SKEW_SECONDS) {
      throw new TokenVerificationError('invalid_token', 'service token was issued in the future');
    }
    const scopedWorkspace = typeof workspaceId === 'string' && workspaceId.trim() !== '' ? workspaceId : undefined;
    return {
      issuer: iss,
      subject: sub,
      jti,
      keyId,
      expiresAt: new Date(exp * 1000),
      ...(scopedWorkspace ? { workspaceId: scopedWorkspace } : {}),
    };
  }
}
