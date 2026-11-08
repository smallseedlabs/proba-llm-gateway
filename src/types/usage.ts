import { z } from 'zod';
import type { CostEstimate } from './llm.js';

/**
 * Per-call and whole-run usage. Counts are additive across loop iterations.
 * Cost stays `unknown` unless every contributing LLM turn returned a numeric
 * estimate with a pricingVersion (configured in proba-llm, not here).
 */
export const usageTotalsSchema = z
  .object({
    llmCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    promptTokens: z.number().nonnegative(),
    completionTokens: z.number().nonnegative(),
    cachedTokens: z.number().nonnegative(),
    reasoningTokens: z.number().nonnegative(),
    cost: z.union([
      z.object({ estimate: z.literal('unknown') }).strict(),
      z
        .object({
          estimate: z.number(),
          currency: z.literal('USD'),
          pricingVersion: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const emptyUsageTotals = (): UsageTotals => ({
  llmCalls: 0,
  toolCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  cost: { estimate: 'unknown' },
});

export type { CostEstimate };
