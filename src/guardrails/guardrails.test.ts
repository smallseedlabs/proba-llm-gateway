import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { testConfig } from '../testing/config.js';
import type { UsageLimits } from '../ports/usage.js';
import {
  applyGuardrailLimits,
  DEFAULT_GUARDRAILS_FILE,
  loadGuardrails,
  lockedVerbMode,
  NO_GUARDRAILS,
  parseGuardrailsFile,
  verbMode,
  type GuardrailsFile,
} from './guardrails.js';

const limits = testConfig().limits;
const file = (over: Partial<GuardrailsFile> = {}): GuardrailsFile => ({
  schema: 'proba.gateway-guardrails/v1',
  version: 't1',
  verbs: {},
  limits: {},
  ...over,
});
const load = (env: NodeJS.ProcessEnv, f?: GuardrailsFile) => loadGuardrails(env, limits, { file: f, defaultFile: '/nonexistent' });

describe('guardrails: loosening is rejected', () => {
  it('rejects allow on a verb the code requires approval for (file and env)', () => {
    expect(lockedVerbMode('ads.create_campaign')).toBe('ask');
    expect(() => load({}, file({ verbs: { 'ads.create_campaign': 'allow' } }))).toThrow(ConfigError);
    expect(() => load({ GATEWAY_VERB_POLICY: 'ads.create_campaign=allow' })).toThrow(/would loosen the code lock/);
  });

  it('rejects any mode that would enable a verb the code does not allowlist', () => {
    expect(lockedVerbMode('ads.move_budget')).toBe('deny');
    expect(() => load({}, file({ verbs: { 'ads.move_budget': 'ask' } }))).toThrow(/would loosen the code lock \(deny\)/);
    expect(() => load({ GATEWAY_VERB_POLICY: 'page.generate_page=allow' })).toThrow(ConfigError);
  });

  it('rejects unknown verbs and malformed env', () => {
    expect(() => load({}, file({ verbs: { 'ads.spend_everything': 'deny' } }))).toThrow(/unknown verb/);
    expect(() => load({ GATEWAY_VERB_POLICY: 'research.gather' })).toThrow(/verb=allow\|ask\|deny/);
    expect(() => load({ GATEWAY_GUARDRAIL_MAX_ITERATIONS: '0' })).toThrow(ConfigError);
    expect(() => load({ GATEWAY_GUARDRAIL_MAX_ITERATIONS: '2.5' })).toThrow(ConfigError);
  });

  it('rejects a file limit above the deployment GATEWAY_MAX_* limit', () => {
    expect(() => load({}, file({ limits: { maxIterations: limits.maxIterations + 1 } }))).toThrow(/deployment limit/);
    expect(() => load({}, file({ limits: { maxToolCalls: limits.maxToolCalls + 1 } }))).toThrow(ConfigError);
  });

  it('rejects env that is looser than the file', () => {
    const f = file({ verbs: { 'research.gather': 'ask' }, limits: { maxIterations: 3 } });
    expect(() => load({ GATEWAY_VERB_POLICY: 'research.gather=allow' }, f)).toThrow(/would loosen the guardrails file/);
    expect(() => load({ GATEWAY_GUARDRAIL_MAX_ITERATIONS: '4' }, f)).toThrow(ConfigError);
  });

  it('rejects files with unknown keys or the wrong schema', () => {
    expect(() => parseGuardrailsFile({ ...file(), limits: { maxIterations: 2, maxRetries: 9 } }, 'x')).toThrow(ConfigError);
    expect(() => parseGuardrailsFile({ ...file(), schema: 'other' }, 'x')).toThrow(ConfigError);
  });

  it('refuses to start the gateway when the configured file loosens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    try {
      const path = join(dir, 'g.json');
      await writeFile(path, JSON.stringify(file({ verbs: { 'ads.pause_campaign': 'allow' } })));
      expect(() => loadGuardrails({ GATEWAY_GUARDRAILS_FILE: path }, limits)).toThrow(ConfigError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('guardrails: tightening is applied', () => {
  it('ships an empty, valid default file', () => {
    const g = loadGuardrails({}, limits, { defaultFile: DEFAULT_GUARDRAILS_FILE });
    expect(g.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(g.verbs).toEqual({});
    expect(g.limits).toEqual({});
  });

  it('merges file and env, taking the stricter of each', () => {
    const g = load(
      { GATEWAY_VERB_POLICY: 'ads.create_campaign=deny', GATEWAY_GUARDRAIL_MAX_ITERATIONS: '2', GATEWAY_GUARDRAIL_MAX_COST_USD: '0.05' },
      file({ verbs: { 'research.gather': 'ask' }, limits: { maxIterations: 3, maxTotalTokens: 5000 } })
    );
    expect(g.verbs).toEqual({ 'research.gather': 'ask', 'ads.create_campaign': 'deny' });
    expect(g.limits).toEqual({ maxIterations: 2, maxTotalTokens: 5000, maxCostUsd: 0.05 });
    expect(verbMode(g, 'research.gather')).toBe('ask');
    expect(verbMode(g, 'ads.create_campaign')).toBe('deny');
    expect(verbMode(g, 'ads.pause_campaign')).toBe('ask');
    expect(verbMode(g, 'ads.move_budget')).toBe('deny');
  });

  it('clamps the merged run limits (deployment + Hub budget) and never raises them', () => {
    const merged = { ...limits, maxIterations: 6, maxTotalTokens: null, maxCostUsd: 0.5, contextBudgetTokens: 4000 } as unknown as UsageLimits;
    const g = load({}, file({ limits: { maxIterations: 2, maxTotalTokens: 4000, maxCostUsd: 1 } }));
    const out = applyGuardrailLimits(merged, g);
    expect(out.maxIterations).toBe(2);
    expect(out.maxTotalTokens).toBe(4000);
    expect(out.maxCostUsd).toBe(0.5);
    expect(applyGuardrailLimits(merged, NO_GUARDRAILS)).toEqual(merged);
  });
});

describe('guardrails: campaign reviewer bounds', () => {
  it('accepts tighter bounds and refuses looser ones', () => {
    const g = load({}, file({ reviewer: { minCheckHours: 6, maxCheckHours: 72, maxAutoChangePct: 10 } }));
    expect(g.reviewer).toEqual({ minCheckHours: 6, maxCheckHours: 72, maxAutoChangePct: 10 });
    expect(() => load({}, file({ reviewer: { minCheckHours: 0.5 } }))).toThrow(/reviewer.minCheckHours=0.5 would loosen/);
    expect(() => load({}, file({ reviewer: { maxCheckHours: 400 } }))).toThrow(/reviewer.maxCheckHours=400 would loosen/);
    expect(() => load({}, file({ reviewer: { maxAutoChangePct: 50 } }))).toThrow(/reviewer.maxAutoChangePct=50 would loosen/);
    expect(() => load({}, file({ reviewer: { minCheckHours: 48, maxCheckHours: 24 } }))).toThrow(/must not exceed/);
  });
});
