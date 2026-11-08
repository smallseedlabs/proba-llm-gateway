/**
 * Usage accounting reservations across all loop iterations.
 * Per-call and whole-run tokens, cost and tool counts. Model/provider-aware
 * numeric cost comes from proba-llm's CostEstimate (configurable there).
 * This gateway does not invent prices or a free quota.
 */

import type { CostEstimate, TurnResponse } from '../types/llm.js';
import type { UsageTotals } from '../types/usage.js';
import type { RunBudget } from '../types/run.js';
import type { LimitsConfig } from '../types/config.js';

export interface UsageLimits {
  maxIterations: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  maxPromptTokens: number | null;
  maxCompletionTokens: number | null;
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
  responseTokenReserve: number;
  contextBudgetTokens: number | null;
}

export interface UsageLedger {
  snapshot(): UsageTotals;
  /**
   * Throws if another loop iteration cannot start. Uses pre-increment
   * semantics so maxIterations=1 can still complete its first LLM turn.
   */
  assertCanStartIteration(): void;
  /** Throws BudgetExhaustedError if the next LLM call cannot be proven in budget. */
  assertCanCallLlm(): void;
  /** Throws if another tool call would exceed the tool count. */
  assertCanCallTool(): void;
  recordLlmTurn(response: TurnResponse): void;
  /** Count a dispatched LLM attempt that did not return a usable turn. */
  recordLlmDispatchFailure(): void;
  recordToolCall(): void;
  recordIteration(): number;
  /**
   * ContextRequest.budgetTokens for the next bridge call: remaining room minus
   * the response-token reserve, capped by protocol/config max. Never negative.
   */
  contextBudgetTokens(): number;
}

export type { CostEstimate, LimitsConfig, RunBudget, UsageTotals };
