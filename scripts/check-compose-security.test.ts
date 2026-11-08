import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
const stack = readFileSync(join(root, 'deploy/stack.yml'), 'utf8');

const checker = (await import(new URL('./check-compose-security.mjs', import.meta.url).href)) as {
  checkComposePublish: (text: string) => string[];
  checkStackText: (text: string) => string[];
  checkGatewayComposeFiles: (composeText: string, stackText: string) => { violations: string[]; required: string[] };
};

describe('gateway compose security (static)', () => {
  it('accepts the tracked compose and stack: loopback, research fetch off, no vendor keys', () => {
    const { violations, required } = checker.checkGatewayComposeFiles(compose, stack);
    expect(violations).toEqual([]);
    expect(required).toEqual(
      expect.arrayContaining([
        'REDIS_PASSWORD',
        'GATEWAY_LLM_PRIVATE_KEY_FILE',
        'HUB_SERVICE_JWKS_FILE',
        'HUB_ASSERTION_JWKS_FILE',
        'GATEWAY_LLM_KEY_ID',
      ])
    );
    expect(required).not.toContain('NAME');
    expect(checker.checkComposePublish(compose)).toEqual([]);
    expect(checker.checkStackText(stack)).toEqual([]);
  });

  it('fails if research fetch is enabled, a port is public, or a vendor key appears', () => {
    const badCompose = compose
      .replace('RESEARCH_HTTP_FETCH: "false"', 'RESEARCH_HTTP_FETCH: "true"')
      .replace('127.0.0.1:3700:3700', '0.0.0.0:3700:3700')
      .concat('\n      DEEPSEEK_API_KEY: sk-live\n');
    const { violations } = checker.checkGatewayComposeFiles(badCompose, stack);
    expect(violations.some((v) => /RESEARCH_HTTP_FETCH/.test(v))).toBe(true);
    expect(violations.some((v) => /0\.0\.0\.0/.test(v))).toBe(true);
    expect(violations.some((v) => /vendor LLM/.test(v))).toBe(true);
  });
});
