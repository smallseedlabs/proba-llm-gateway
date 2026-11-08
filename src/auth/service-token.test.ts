import { describe, expect, it } from 'vitest';
import { ServiceTokenAuth } from './service-token.js';
import { TokenVerificationError } from '../ports/auth.js';
import { createTestSigner, mintHubToken } from '../testing/token-signer.js';

describe('Hub inbound service token', () => {
  it('accepts an EdDSA Hub token for audience proba-gateway', async () => {
    const signer = await createTestSigner();
    const auth = new ServiceTokenAuth({ keys: signer.keys, allowedIssuers: ['proba-hub'], allowedSubjects: ['hub'] });
    const token = await mintHubToken(signer);
    const caller = await auth.authenticate({ authorization: `Bearer ${token}` });
    expect(caller.issuer).toBe('proba-hub');
    expect(caller.subject).toBe('hub');
  });

  it('rejects a missing bearer, wrong audience, and wrong subject', async () => {
    const signer = await createTestSigner();
    const auth = new ServiceTokenAuth({ keys: signer.keys, allowedIssuers: ['proba-hub'], allowedSubjects: ['hub'] });
    await expect(auth.authenticate({})).rejects.toBeInstanceOf(TokenVerificationError);
    const wrongAud = await mintHubToken(signer, () => new Date(), { aud: 'proba-llm' });
    await expect(auth.authenticate({ authorization: `Bearer ${wrongAud}` })).rejects.toBeInstanceOf(TokenVerificationError);
    const wrongSub = await mintHubToken(signer, () => new Date(), { sub: 'gateway' });
    await expect(auth.authenticate({ authorization: `Bearer ${wrongSub}` })).rejects.toBeInstanceOf(TokenVerificationError);
  });
});
