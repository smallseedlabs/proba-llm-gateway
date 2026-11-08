/**
 * Mints short-lived EdDSA service tokens for proba-llm.
 * Claims: iss (default proba-gateway), aud proba-llm, sub (default gateway),
 * jti, iat, exp. TTL ≤ 120 seconds.
 */

export interface LlmServiceTokenSigner {
  readonly kid: string;
  mint(now?: Date): Promise<string>;
}
