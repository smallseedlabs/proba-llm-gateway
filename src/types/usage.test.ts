import { describe, expect, it } from 'vitest';
import { emptyUsageTotals, usageTotalsSchema } from './usage.js';

describe('usageTotalsSchema', () => {
  it('defaults cacheMissTokens to 0 so a persisted run from before the field still parses', () => {
    const parsed = usageTotalsSchema.safeParse({
      llmCalls: 1,
      toolCalls: 0,
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 8,
      reasoningTokens: 0,
      cost: { estimate: 'unknown' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.cacheMissTokens).toBe(0);
    expect(emptyUsageTotals().cacheMissTokens).toBe(0);
  });
});
