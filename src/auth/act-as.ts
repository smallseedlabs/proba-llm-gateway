/**
 * Verify a Hub-minted act-as assertion before forwarding it to the context
 * bridge. Gateway is not in the protocol audience list; we verify iss,
 * signature, aud includes proba-context, TTL ≤ 5 minutes, and claims match
 * the run request. We do not mint act-as.
 */

import { errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {
  ACT_AS_ASSERTION_MAX_TTL_SECONDS,
  type ActAsAssertionClaims,
  validateActAsAssertionClaims,
} from '../protocol.js';
import { TokenVerificationError } from '../ports/auth.js';
import { RequestValidationError } from '../errors.js';
import type { HubRunRequest } from '../types/run.js';
import { ACT_AS_EXPECTED_AUDIENCE, ACT_AS_ISSUER, CLOCK_SKEW_SECONDS, MAX_TOKEN_LENGTH } from './constants.js';

export interface ActAsMatch {
  claims: ActAsAssertionClaims;
  token: string;
}

export async function verifyForwardedActAs(
  token: string,
  request: HubRunRequest,
  keys: JWTVerifyGetKey,
  now: () => Date = () => new Date()
): Promise<ActAsMatch> {
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new TokenVerificationError('invalid_token', 'act-as assertion is too large');
  }
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, keys, {
      algorithms: ['EdDSA'],
      issuer: ACT_AS_ISSUER,
      audience: ACT_AS_EXPECTED_AUDIENCE,
      clockTolerance: CLOCK_SKEW_SECONDS,
      currentDate: now(),
      requiredClaims: ['exp', 'iat', 'sub', 'iss', 'jti', 'workspaceId'],
    });
    payload = result.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) throw new TokenVerificationError('token_expired', 'act-as assertion has expired');
    if (error instanceof TokenVerificationError) throw error;
    if (error instanceof joseErrors.JOSEError) throw new TokenVerificationError('invalid_token', `act-as assertion rejected: ${error.message}`);
    throw error;
  }
  const parsed = validateActAsAssertionClaims(payload);
  if (!parsed.success) {
    throw new TokenVerificationError('invalid_token', parsed.error.issues[0]?.message ?? 'act-as claims are invalid');
  }
  const claims = parsed.data;
  if (claims.exp - claims.iat > ACT_AS_ASSERTION_MAX_TTL_SECONDS) {
    throw new TokenVerificationError('invalid_token', 'act-as assertion lives longer than 5 minutes');
  }
  if (claims.workspaceId !== request.workspaceId) {
    throw new RequestValidationError('act-as workspaceId does not match the run request');
  }
  if (claims.sub !== request.userId) {
    throw new RequestValidationError('act-as subject does not match the run userId');
  }
  if (request.goalId && claims.goalId !== request.goalId) {
    throw new RequestValidationError('act-as goalId does not match the run request');
  }
  if (request.threadId && claims.threadId !== request.threadId) {
    throw new RequestValidationError('act-as threadId does not match the run request');
  }
  return { claims, token };
}
