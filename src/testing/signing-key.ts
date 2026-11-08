/** TEST STUB: write a temp Ed25519 PKCS#8 used only by gateway tests. */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';

export async function writeTestSigningKeyFile(kid = 'gateway-test-1'): Promise<{ file: string; kid: string }> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pem = await exportPKCS8(privateKey);
  const dir = await mkdtemp(join(tmpdir(), 'proba-gw-key-'));
  const file = join(dir, 'gateway.pem');
  await writeFile(file, pem, { mode: 0o600 });
  return { file, kid };
}
