import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { LlmServiceTokenSigner } from '../ports/token-signer.js';
import type { GatewaySigningKey } from './private-key.js';
import { LLM_AUDIENCE, SERVICE_TOKEN_MAX_TTL_SECONDS } from './constants.js';

export interface MintLlmTokenOptions {
  signingKey: GatewaySigningKey;
  issuer: string;
  subject: string;
  audience?: string;
  ttlSeconds?: number;
  now?: () => Date;
}

/**
 * Mints the token proba-llm verifies. Identities are deployment-controlled;
 * defaults match LLM's DEFAULT_CALLER_ISSUERS/SUBJECTS.
 */
export function createLlmTokenSigner(options: MintLlmTokenOptions): LlmServiceTokenSigner {
  const now = options.now ?? (() => new Date());
  const ttl = Math.min(Math.max(1, options.ttlSeconds ?? 60), SERVICE_TOKEN_MAX_TTL_SECONDS);
  return {
    kid: options.signingKey.kid,
    async mint(at?: Date) {
      const iat = Math.floor((at ?? now()).getTime() / 1000);
      return new SignJWT({
        iss: options.issuer,
        aud: options.audience ?? LLM_AUDIENCE,
        sub: options.subject,
        jti: randomUUID(),
        iat,
        exp: iat + ttl,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: options.signingKey.kid, typ: 'JWT' })
        .sign(options.signingKey.privateKey);
    },
  };
}
