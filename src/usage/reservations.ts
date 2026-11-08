/**
 * Whole-run usage ledger. Unknown cost is never coerced to 0. A configured
 * USD ceiling cannot be proven while cost is unknown, so the next paid LLM
 * call is refused. Token/tool counts still apply. No prices live here.
 */

import { BudgetExhaustedError } from '../errors.js';
import type { UsageLedger, UsageLimits } from '../ports/usage.js';
import type { TurnResponse } from '../types/llm.js';
import { emptyUsageTotals, type UsageTotals } from '../types/usage.js';

export function mergeLimits(base: UsageLimits, overlay?: Partial<UsageLimits>): UsageLimits {
  return {
    maxIterations: overlay?.maxIterations ?? base.maxIterations,
    maxLlmCalls: overlay?.maxLlmCalls ?? base.maxLlmCalls,
    maxToolCalls: overlay?.maxToolCalls ?? base.maxToolCalls,
    maxPromptTokens: overlay?.maxPromptTokens ?? base.maxPromptTokens,
    maxCompletionTokens: overlay?.maxCompletionTokens ?? base.maxCompletionTokens,
    maxTotalTokens: overlay?.maxTotalTokens ?? base.maxTotalTokens,
    maxCostUsd: overlay?.maxCostUsd ?? base.maxCostUsd,
    responseTokenReserve: overlay?.responseTokenReserve ?? base.responseTokenReserve,
    contextBudgetTokens: overlay?.contextBudgetTokens ?? base.contextBudgetTokens,
  };
}

export function addCost(current: UsageTotals['cost'], incoming: TurnResponse['cost']): UsageTotals['cost'] {
  if (current.estimate === 'unknown' || incoming.estimate === 'unknown') {
    return { estimate: 'unknown' };
  }
  if (current.pricingVersion !== incoming.pricingVersion) {
    return { estimate: 'unknown' };
  }
  return {
    estimate: current.estimate + incoming.estimate,
    currency: 'USD',
    pricingVersion: current.pricingVersion,
  };
}

/**
 * Tokens offered to the context bridge for this iteration.
 * `responseTokenReserve` is subtracted here; ContextRequest still uses `budgetTokens`.
 */
export function contextBudgetForIteration(input: {
  remainingTotalTokens: number | null;
  responseTokenReserve: number;
  requestBudget: number | null;
  maxBudgetTokens: number | null;
}): number {
  const reserved = Math.max(0, input.responseTokenReserve);
  const remaining = input.remainingTotalTokens === null ? Number.POSITIVE_INFINITY : Math.max(0, input.remainingTotalTokens);
  let budget = remaining - reserved;
  if (input.requestBudget !== null) budget = Math.min(budget, input.requestBudget);
  if (input.maxBudgetTokens !== null) budget = Math.min(budget, input.maxBudgetTokens);
  if (!Number.isFinite(budget)) {
    if (input.requestBudget !== null) return Math.max(0, Math.floor(input.requestBudget));
    if (input.maxBudgetTokens !== null) return Math.max(0, Math.floor(input.maxBudgetTokens));
    throw new BudgetExhaustedError('context budgetTokens is not configured; refusing an unbounded context fetch');
  }
  const whole = Math.floor(budget);
  if (whole < 1) throw new BudgetExhaustedError('response-token reserve leaves no tokens for context');
  return whole;
}

export class RunUsageLedger implements UsageLedger {
  private totals = emptyUsageTotals();
  private iterations = 0;

  constructor(private readonly limits: UsageLimits) {}

  restore(totals: UsageTotals, iterations: number): void {
    this.totals = { ...totals, cost: { ...totals.cost } };
    this.iterations = iterations;
  }

  snapshot(): UsageTotals {
    return { ...this.totals, cost: { ...this.totals.cost } };
  }

  assertCanStartIteration(): void {
    if (this.iterations >= this.limits.maxIterations) {
      throw new BudgetExhaustedError(`iteration cap ${this.limits.maxIterations} reached`);
    }
  }

  assertCanCallLlm(): void {
    if (this.totals.llmCalls >= this.limits.maxLlmCalls) {
      throw new BudgetExhaustedError(`LLM call cap ${this.limits.maxLlmCalls} reached`);
    }
    if (this.limits.maxCostUsd !== null && this.totals.cost.estimate === 'unknown' && this.totals.llmCalls > 0) {
      throw new BudgetExhaustedError('cost estimate is unknown; a USD ceiling cannot treat unknown as zero');
    }
    if (this.limits.maxCostUsd !== null && this.totals.cost.estimate !== 'unknown' && this.totals.cost.estimate >= this.limits.maxCostUsd) {
      throw new BudgetExhaustedError('USD ceiling reached');
    }
    const usedTokens = this.totals.promptTokens + this.totals.completionTokens;
    if (this.limits.maxTotalTokens !== null && usedTokens >= this.limits.maxTotalTokens) {
      throw new BudgetExhaustedError('total token cap reached');
    }
    if (this.limits.maxPromptTokens !== null && this.totals.promptTokens >= this.limits.maxPromptTokens) {
      throw new BudgetExhaustedError('prompt token cap reached');
    }
    if (this.limits.maxCompletionTokens !== null && this.totals.completionTokens >= this.limits.maxCompletionTokens) {
      throw new BudgetExhaustedError('completion token cap reached');
    }
  }

  assertCanCallTool(): void {
    if (this.totals.toolCalls >= this.limits.maxToolCalls) {
      throw new BudgetExhaustedError(`tool call cap ${this.limits.maxToolCalls} reached`);
    }
  }

  recordLlmTurn(response: TurnResponse): void {
    this.totals = {
      llmCalls: this.totals.llmCalls + 1,
      toolCalls: this.totals.toolCalls,
      promptTokens: this.totals.promptTokens + (response.usage.promptTokens ?? 0),
      completionTokens: this.totals.completionTokens + (response.usage.completionTokens ?? 0),
      cachedTokens: this.totals.cachedTokens + (response.usage.cachedTokens ?? 0),
      reasoningTokens: this.totals.reasoningTokens + (response.usage.reasoningTokens ?? 0),
      cost: addCost(this.totals.cost, response.cost),
    };
  }

  recordLlmDispatchFailure(): void {
    this.totals = {
      ...this.totals,
      llmCalls: this.totals.llmCalls + 1,
      cost: { estimate: 'unknown' },
    };
  }

  recordToolCall(): void {
    this.totals = { ...this.totals, toolCalls: this.totals.toolCalls + 1 };
  }

  recordIteration(): number {
    this.iterations += 1;
    if (this.iterations > this.limits.maxIterations) {
      throw new BudgetExhaustedError(`iteration cap ${this.limits.maxIterations} reached`);
    }
    return this.iterations;
  }

  contextBudgetTokens(): number {
    const used = this.totals.promptTokens + this.totals.completionTokens;
    const remaining = this.limits.maxTotalTokens === null ? null : Math.max(0, this.limits.maxTotalTokens - used);
    return contextBudgetForIteration({
      remainingTotalTokens: remaining,
      responseTokenReserve: this.limits.responseTokenReserve,
      requestBudget: this.limits.contextBudgetTokens,
      maxBudgetTokens: this.limits.contextBudgetTokens,
    });
  }
}
