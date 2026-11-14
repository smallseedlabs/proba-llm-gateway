import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { testConfig } from '../testing/config.js';
import { loadGuardrails } from './guardrails.js';
import { GuardrailsController, parseGuardrailsWrite } from './snapshot.js';

const limits = testConfig().limits;
const file = (over: Record<string, unknown> = {}) => ({
  schema: 'proba.gateway-guardrails/v1',
  version: 't1',
  verbs: {},
  limits: {},
  ...over,
});

describe('parseGuardrailsWrite: loosening is rejected', () => {
  it('rejects allow on a verb the code requires approval for', () => {
    expect(() => parseGuardrailsWrite(file({ verbs: { 'ads.create_campaign': 'allow' } }), limits, 'write')).toThrow(
      /would loosen the code lock/
    );
  });

  it('rejects enabling a verb the code does not allowlist, and unknown verbs', () => {
    expect(() => parseGuardrailsWrite(file({ verbs: { 'ads.move_budget': 'ask' } }), limits, 'write')).toThrow(/would loosen the code lock \(deny\)/);
    expect(() => parseGuardrailsWrite(file({ verbs: { 'ads.spend_everything': 'deny' } }), limits, 'write')).toThrow(/unknown verb/);
  });

  it('rejects a limit above the deployment GATEWAY_MAX_* ceiling and unknown keys', () => {
    expect(() => parseGuardrailsWrite(file({ limits: { maxIterations: limits.maxIterations + 1 } }), limits, 'write')).toThrow(
      /deployment limit/
    );
    expect(() => parseGuardrailsWrite(file({ limits: { maxRetries: 9 } }), limits, 'write')).toThrow(ConfigError);
  });

  it('accepts tightening and filling in a version when the body omits one', () => {
    const parsed = parseGuardrailsWrite({ verbs: { 'research.gather': 'ask' }, limits: { maxIterations: 2 } }, limits, 'write');
    expect(parsed.schema).toBe('proba.gateway-guardrails/v1');
    expect(parsed.version).toMatch(/^\d{4}-\d{2}-\d{2}\./);
    expect(parsed.verbs).toEqual({ 'research.gather': 'ask' });
    expect(parsed.limits).toEqual({ maxIterations: 2 });
  });
});

describe('GuardrailsController', () => {
  it('writes a tightening, reloads effective config, and leaves loosening unwritten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardrails-admin-'));
    const path = join(dir, 'g.json');
    await writeFile(path, JSON.stringify(file()));
    const env = { GATEWAY_GUARDRAILS_FILE: path };
    const config = testConfig({ guardrails: loadGuardrails(env, limits), guardrailsFile: path });
    const controller = new GuardrailsController(config, env);
    try {
      expect(controller.snapshot().writable).toBe(true);
      const after = controller.replace({ verbs: { 'research.gather': 'ask' }, limits: { maxIterations: 3, maxToolCalls: 4 } });
      expect(after.fileLimits).toEqual({ maxIterations: 3, maxToolCalls: 4 });
      expect(after.verbs.find((v) => v.name === 'research.gather')?.effective).toBe('ask');
      expect(config.guardrails?.limits).toEqual({ maxIterations: 3, maxToolCalls: 4 });
      const saved = JSON.parse(await readFile(path, 'utf8'));
      expect(saved.limits).toEqual({ maxIterations: 3, maxToolCalls: 4 });

      await expect(async () => controller.replace({ verbs: { 'ads.create_campaign': 'allow' } })).rejects.toThrow(ConfigError);
      const unchanged = JSON.parse(await readFile(path, 'utf8'));
      expect(unchanged.verbs).toEqual({ 'research.gather': 'ask' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a write when no override file is configured', () => {
    const config = testConfig({ guardrailsFile: undefined });
    const controller = new GuardrailsController(config, {});
    expect(controller.snapshot().writable).toBe(false);
    expect(() => controller.replace({ limits: { maxIterations: 2 } })).toThrow(/GATEWAY_GUARDRAILS_FILE/);
  });
});
