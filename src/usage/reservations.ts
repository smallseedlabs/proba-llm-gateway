/**
 * Whole-run usage ledger. Unknown cost is never coerced to 0. An explicit
 * USD ceiling is enforced before dispatch: the next paid LLM call runs only
 * when a conservative bound (authoritative unit prices × this-call token
 * caps) fits remaining room. Unset ceiling: unknown cost stays explicit and
 * token/iteration caps still apply. No prices are invented here. Ad spend is
 * a different claim. Concurrent completes on one run are serialized by the
 * coordinator; this ledger is per-run.
 */

import { BudgetExhaustedError } from '../errors.js';
import type { UsageLedger, UsageLimits } from '../ports/usage.js';
import type { TurnResponse } from '../types/llm.js';
import type { LlmPricingClaim } from '../types/preflight.js';
import { emptyUsageTotals, type UsageTotals } from '../types/usage.js';

const UNCONFIGURED_PRICING: LlmPricingClaim = {
  kind: 'unknown',
  reason: 'proba-llm pricing was not observed; gateway does not invent unit rates',
};

export type ObservedSpend =
  | { kind: 'zero' }
  | { kind: 'numeric'; amount: number; pricingVersion: string }
  | { kind: 'unknown'; reason: string };

export type NextCallCostBound =
  | {
      kind: 'numeric';
      amount: number;
      pricingVersion: string;
      promptTokens: number;
      completionTokens: number;
    }
  | { kind: 'unknown'; reason: string };

/** Observed spend so far. Zero LLM calls is $0 spent, not unknown pricing-as-zero. */
export function observedSpendUsd(totals: UsageTotals): ObservedSpend {
  if (totals.llmCalls === 0) return { kind: 'zero' };
  if (totals.cost.estimate === 'unknown') {
    return {
      kind: 'unknown',
      reason: 'prior LLM cost is unknown; remaining USD ceiling cannot be evaluated and unknown is not zero',
    };
  }
  return { kind: 'numeric', amount: totals.cost.estimate, pricingVersion: totals.cost.pricingVersion };
}

/** Completion tokens this complete() will request. Matches the gateway loop cap. */
export function nextCompletionTokenCap(limits: UsageLimits, totals: UsageTotals): number {
  const remainingCompletion =
    limits.maxCompletionTokens === null
      ? limits.responseTokenReserve
      : Math.max(1, limits.maxCompletionTokens - totals.completionTokens);
  const reserve = limits.responseTokenReserve || remainingCompletion;
  return Math.max(1, Math.min(reserve, remainingCompletion));
}

export function nextCallTokenBounds(
  limits: UsageLimits,
  totals: UsageTotals
): { promptTokens: number; completionTokens: number } | { unbounded: string } {
  const completionTokens = nextCompletionTokenCap(limits, totals);
  const used = totals.promptTokens + totals.completionTokens;
  let promptTokens: number;
  if (limits.maxPromptTokens !== null) {
    promptTokens = Math.max(0, limits.maxPromptTokens - totals.promptTokens);
  } else if (limits.maxTotalTokens !== null) {
    promptTokens = Math.max(0, limits.maxTotalTokens - used);
  } else {
    return {
      unbounded:
        'next-call prompt tokens are unbounded; set GATEWAY_MAX_TOTAL_TOKENS or GATEWAY_MAX_PROMPT_TOKENS to evaluate a USD ceiling',
    };
  }
  return { promptTokens, completionTokens };
}

export function conservativeNextCallCostUsd(
  limits: UsageLimits,
  totals: UsageTotals,
  pricing: LlmPricingClaim
): NextCallCostBound {
  if (pricing.kind === 'unavailable') {
    return { kind: 'unknown', reason: pricing.reason };
  }
  if (pricing.kind !== 'verified') {
    return {
      kind: 'unknown',
      reason:
        pricing.kind === 'unknown'
          ? `${pricing.reason} A USD ceiling cannot treat unknown unit prices as zero; leave GATEWAY_MAX_COST_USD unset to keep token/iteration caps only`
          : 'proba-llm pricing is unknown; a USD ceiling cannot treat unknown as zero',
    };
  }
  const tokens = nextCallTokenBounds(limits, totals);
  if ('unbounded' in tokens) return { kind: 'unknown', reason: tokens.unbounded };
  const amount =
    (tokens.promptTokens / 1_000_000) * pricing.promptUsdPerMillion +
    (tokens.completionTokens / 1_000_000) * pricing.completionUsdPerMillion;
  if (!Number.isFinite(amount) || amount < 0) {
    return { kind: 'unknown', reason: 'conservative next-call cost bound is not a finite number' };
  }
  return {
    kind: 'numeric',
    amount,
    pricingVersion: pricing.version,
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
  };
}

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
  private pricing: LlmPricingClaim = UNCONFIGURED_PRICING;

  constructor(private readonly limits: UsageLimits) {}

  hasMonetaryCap(): boolean {
    return this.limits.maxCostUsd !== null;
  }

  observePricing(claim: LlmPricingClaim): void {
    this.pricing = claim;
  }

  completionTokenCap(): number {
    return nextCompletionTokenCap(this.limits, this.totals);
  }

  restore(totals: UsageTotals, iterations: number): void {
    this.totals = { ...totals, cost: { ...totals.cost } };
    this.iterations = iterations;
  }

  snapshot(): UsageTotals {
    return { ...this.totals, cost: { ...this.totals.cost } };
  }

  /** What the model is told about its run budget: current loop and what is used of each bound. */
  budgetView(): { iteration: number; maxIterations: number; toolCalls: number; maxToolCalls: number; tokens: number; maxTotalTokens: number | null } {
    return {
      iteration: this.iterations,
      maxIterations: this.limits.maxIterations,
      toolCalls: this.totals.toolCalls,
      maxToolCalls: this.limits.maxToolCalls,
      tokens: this.totals.promptTokens + this.totals.completionTokens,
      maxTotalTokens: this.limits.maxTotalTokens,
    };
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
    if (this.limits.maxCostUsd !== null) {
      const spent = observedSpendUsd(this.totals);
      if (spent.kind === 'unknown') {
        throw new BudgetExhaustedError(spent.reason, 'unknown');
      }
      const spentAmount = spent.kind === 'zero' ? 0 : spent.amount;
      if (spentAmount >= this.limits.maxCostUsd) {
        throw new BudgetExhaustedError('USD ceiling reached', 'insufficient');
      }
      const bound = conservativeNextCallCostUsd(this.limits, this.totals, this.pricing);
      if (bound.kind !== 'numeric') {
        throw new BudgetExhaustedError(bound.reason, 'unknown');
      }
      if (spent.kind === 'numeric' && spent.pricingVersion !== bound.pricingVersion) {
        throw new BudgetExhaustedError(
          'spent cost and next-call bound use different pricing versions; remaining USD ceiling cannot be evaluated',
          'unknown'
        );
      }
      const remaining = this.limits.maxCostUsd - spentAmount;
      if (bound.amount > remaining) {
        throw new BudgetExhaustedError(
          `conservative next-call cost bound ${bound.amount} USD exceeds remaining USD ceiling ${remaining}`,
          'insufficient'
        );
      }
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
    const cost =
      this.totals.llmCalls === 0
        ? response.cost.estimate === 'unknown'
          ? { estimate: 'unknown' as const }
          : response.cost
        : addCost(this.totals.cost, response.cost);
    this.totals = {
      llmCalls: this.totals.llmCalls + 1,
      toolCalls: this.totals.toolCalls,
      promptTokens: this.totals.promptTokens + (response.usage.promptTokens ?? 0),
      completionTokens: this.totals.completionTokens + (response.usage.completionTokens ?? 0),
      cachedTokens: this.totals.cachedTokens + (response.usage.cachedTokens ?? 0),
      cacheMissTokens: this.totals.cacheMissTokens + (response.usage.cacheMissTokens ?? 0),
      reasoningTokens: this.totals.reasoningTokens + (response.usage.reasoningTokens ?? 0),
      cost,
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
