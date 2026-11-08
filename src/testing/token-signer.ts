import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey, createLocalJWKSet } from 'jose';
import { GATEWAY_AUDIENCE, SERVICE_TOKEN_MAX_TTL_SECONDS } from '../auth/constants.js';

export interface TestSigner {
  kid: string;
  jwks: { keys: JWK[] };
  keys: JWTVerifyGetKey;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function createTestSigner(kid = `key-${randomUUID().slice(0, 8)}`): Promise<TestSigner> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA' as const, use: 'sig' as const };
  const jwks = { keys: [jwk] };
  return {
    kid,
    jwks,
    keys: createLocalJWKSet(jwks),
    sign: (claims, header = {}) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT', ...header }).sign(privateKey),
  };
}

export async function mintHubToken(
  signer: TestSigner,
  now = () => new Date(),
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const iat = Math.floor(now().getTime() / 1000);
  return signer.sign({
    iss: 'proba-hub',
    aud: GATEWAY_AUDIENCE,
    sub: 'hub',
    jti: randomUUID(),
    iat,
    exp: iat + Math.min(60, SERVICE_TOKEN_MAX_TTL_SECONDS),
    ...overrides,
  });
}
