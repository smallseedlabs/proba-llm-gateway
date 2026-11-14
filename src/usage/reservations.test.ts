import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../errors.js';
import { contextBudgetForIteration, conservativeNextCallCostUsd, DEFAULT_COMPLETION_TOKEN_CAP, observedSpendUsd, RunUsageLedger } from './reservations.js';
import type { TurnResponse } from '../types/llm.js';
import type { UsageLimits } from '../ports/usage.js';
import type { LlmPricingClaim } from '../types/preflight.js';

const verifiedPricing = (overlay: Partial<Extract<LlmPricingClaim, { kind: 'verified' }>> = {}): LlmPricingClaim => ({
  kind: 'verified',
  promptUsdPerMillion: 0.15,
  completionUsdPerMillion: 0.6,
  version: 'test-v1',
  ...overlay,
});

const limits = (overlay: Partial<UsageLimits> = {}): UsageLimits => ({
  maxIterations: 8,
  maxLlmCalls: 8,
  maxToolCalls: 16,
  maxPromptTokens: null,
  maxCompletionTokens: null,
  maxTotalTokens: 8000,
  maxCostUsd: null,
  responseTokenReserve: 512,
  contextBudgetTokens: 4000,
  ...overlay,
});

const turn = (cost: TurnResponse['cost'], prompt = 100, completion = 50): TurnResponse => ({
  message: { role: 'assistant', content: 'ok' },
  finishReason: 'stop',
  model: 'deepseek-chat',
  provider: 'deepseek',
  usage: { promptTokens: prompt, completionTokens: completion },
  latencyMs: 10,
  cost,
});

describe('usage reservations', () => {
  it('refuses the first paid LLM call when a USD ceiling is set and pricing is unknown', () => {
    const ledger = new RunUsageLedger(limits({ maxCostUsd: 1 }));
    expect(observedSpendUsd(ledger.snapshot()).kind).toBe('zero');
    expect(() => ledger.assertCanCallLlm()).toThrow(BudgetExhaustedError);
    expect(() => ledger.assertCanCallLlm()).toThrow(/unknown unit prices|pricing/);
  });

  it('allows a first call inside a USD ceiling only when a conservative bound fits remaining room', () => {
    const ledger = new RunUsageLedger(limits({ maxCostUsd: 1 }));
    ledger.observePricing(verifiedPricing());
    expect(() => ledger.assertCanCallLlm()).not.toThrow();
    ledger.recordLlmTurn(turn({ estimate: 0.002, currency: 'USD', pricingVersion: 'test-v1' }));
    expect(() => ledger.assertCanCallLlm()).not.toThrow();
  });

  it('blocks when remaining room is below the conservative next-call bound', () => {
    const ledger = new RunUsageLedger(limits({ maxCostUsd: 0.001 }));
    ledger.observePricing(verifiedPricing({ promptUsdPerMillion: 1000, completionUsdPerMillion: 1000 }));
    const bound = conservativeNextCallCostUsd(limits({ maxCostUsd: 0.001 }), ledger.snapshot(), verifiedPricing({ promptUsdPerMillion: 1000, completionUsdPerMillion: 1000 }));
    expect(bound.kind).toBe('numeric');
    expect(() => ledger.assertCanCallLlm()).toThrow(/exceeds remaining USD ceiling/);
  });

  it('blocks further calls after unknown spend even when unit prices are known', () => {
    const ledger = new RunUsageLedger(limits({ maxCostUsd: 1 }));
    ledger.observePricing(verifiedPricing());
    ledger.recordLlmTurn(turn({ estimate: 'unknown' }));
    expect(() => ledger.assertCanCallLlm()).toThrow(/prior LLM cost is unknown/);
  });

  it('allows the first LLM call when no USD ceiling is configured even if cost is unknown', () => {
    const ledger = new RunUsageLedger(limits({ maxCostUsd: null }));
    expect(() => ledger.assertCanCallLlm()).not.toThrow();
    ledger.recordLlmTurn(turn({ estimate: 'unknown' }));
    expect(ledger.snapshot().cost).toEqual({ estimate: 'unknown' });
    expect(ledger.snapshot().cost.estimate).not.toBe(0);
  });

  it('keeps cost unknown if any iteration is unknown, including mixing with a numeric estimate', () => {
    const ledger = new RunUsageLedger(limits());
    ledger.recordLlmTurn(turn({ estimate: 0.02, currency: 'USD', pricingVersion: 'v1' }));
    ledger.recordLlmTurn(turn({ estimate: 'unknown' }));
    expect(ledger.snapshot().cost).toEqual({ estimate: 'unknown' });
  });

  it('subtracts the response-token reserve from context budgetTokens', () => {
    expect(
      contextBudgetForIteration({
        remainingTotalTokens: 8000,
        responseTokenReserve: 512,
        requestBudget: 4000,
        maxBudgetTokens: 4000,
      })
    ).toBe(4000);
    expect(
      contextBudgetForIteration({
        remainingTotalTokens: 600,
        responseTokenReserve: 512,
        requestBudget: 4000,
        maxBudgetTokens: 4000,
      })
    ).toBe(88);
  });

  it('refuses a context fetch when the reserve leaves no tokens', () => {
    expect(() =>
      contextBudgetForIteration({
        remainingTotalTokens: 10,
        responseTokenReserve: 512,
        requestBudget: null,
        maxBudgetTokens: 4000,
      })
    ).toThrow(BudgetExhaustedError);
  });

  it('refuses an unbounded context fetch when no budget is configured', () => {
    expect(() =>
      contextBudgetForIteration({
        remainingTotalTokens: null,
        responseTokenReserve: 0,
        requestBudget: null,
        maxBudgetTokens: null,
      })
    ).toThrow(/not configured/);
  });

  it('lets maxIterations=1 record its first iteration and still call the LLM', () => {
    const ledger = new RunUsageLedger(limits({ maxIterations: 1, maxLlmCalls: 1 }));
    expect(() => ledger.assertCanStartIteration()).not.toThrow();
    expect(ledger.recordIteration()).toBe(1);
    expect(() => ledger.assertCanCallLlm()).not.toThrow();
    expect(() => ledger.assertCanStartIteration()).toThrow(/iteration cap 1/);
  });

  it('counts a failed dispatch toward llmCalls without treating unknown cost as zero', () => {
    const ledger = new RunUsageLedger(limits({ maxLlmCalls: 2, maxCostUsd: 1 }));
    ledger.observePricing(verifiedPricing());
    ledger.recordLlmDispatchFailure();
    expect(ledger.snapshot().llmCalls).toBe(1);
    expect(ledger.snapshot().cost).toEqual({ estimate: 'unknown' });
    expect(ledger.snapshot().cost.estimate).not.toBe(0);
    expect(() => ledger.assertCanCallLlm()).toThrow(BudgetExhaustedError);
    expect(() => ledger.assertCanCallLlm()).toThrow(/unknown/);
  });

  it('accumulates cacheMissTokens from each turn and treats a missing field as zero', () => {
    const ledger = new RunUsageLedger(limits());
    ledger.recordLlmTurn({
      ...turn({ estimate: 0.001, currency: 'USD', pricingVersion: 'test-v1' }, 1000, 50),
      usage: { promptTokens: 1000, completionTokens: 50, cachedTokens: 800, cacheMissTokens: 200 },
    });
    ledger.recordLlmTurn({
      ...turn({ estimate: 0.002, currency: 'USD', pricingVersion: 'test-v1' }, 10, 2),
      usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 8 },
    });
    const snap = ledger.snapshot();
    expect(snap.cachedTokens).toBe(808);
    expect(snap.cacheMissTokens).toBe(200);
    expect(snap.promptTokens).toBe(1010);
  });

  it('does not shrink the next-call USD bound when a cache-hit rate is present', () => {
    const tight = limits({ maxTotalTokens: 1000, responseTokenReserve: 0 });
    const empty = new RunUsageLedger(tight).snapshot();
    const withHit = conservativeNextCallCostUsd(
      tight,
      empty,
      verifiedPricing({ promptUsdPerMillion: 0.3, completionUsdPerMillion: 1.2, promptCacheHitUsdPerMillion: 0.006 })
    );
    const withoutHit = conservativeNextCallCostUsd(
      tight,
      empty,
      verifiedPricing({ promptUsdPerMillion: 0.3, completionUsdPerMillion: 1.2 })
    );
    expect(withHit.kind).toBe('numeric');
    expect(withoutHit.kind).toBe('numeric');
    if (withHit.kind === 'numeric' && withoutHit.kind === 'numeric') {
      expect(withHit.amount).toBe(withoutHit.amount);
    }
  });

  it('uses the remaining run completion budget, not the context response reserve, as the per-call cap', () => {
    const ledger = new RunUsageLedger(limits({ maxCompletionTokens: 1500, responseTokenReserve: 512 }));
    expect(ledger.completionTokenCap()).toBe(1500);
    ledger.recordLlmTurn(turn({ estimate: 0.001, currency: 'USD', pricingVersion: 'test-v1' }, 100, 68));
    expect(ledger.completionTokenCap()).toBe(1432);
  });

  it('defaults a missing run completion cap to 4000 so a 512 reserve cannot clip a draft', () => {
    const ledger = new RunUsageLedger(limits({ maxCompletionTokens: null, responseTokenReserve: 512 }));
    expect(DEFAULT_COMPLETION_TOKEN_CAP).toBe(4000);
    expect(ledger.completionTokenCap()).toBe(4000);
  });

});
