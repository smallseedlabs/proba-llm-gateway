import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../errors.js';
import { contextBudgetForIteration, RunUsageLedger } from './reservations.js';
import type { TurnResponse } from '../types/llm.js';
import type { UsageLimits } from '../ports/usage.js';

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
  it('does not treat unknown cost as zero when a USD ceiling is set', () => {
    const ledger = new RunUsageLedger(limits({ maxCostUsd: 1 }));
    expect(() => ledger.assertCanCallLlm()).not.toThrow();
    ledger.recordLlmTurn(turn({ estimate: 'unknown' }));
    expect(() => ledger.assertCanCallLlm()).toThrow(BudgetExhaustedError);
    expect(() => ledger.assertCanCallLlm()).toThrow(/unknown/);
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
});
