import { describe, expect, it } from 'vitest';
import { completeRequestSchema, turnResponseSchema } from './llm.js';

describe('proba-llm complete contract', () => {
  it('accepts a strict complete request matching proba-llm POST /v1/complete', () => {
    const parsed = completeRequestSchema.safeParse({
      traceId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'seedbed',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(parsed.success).toBe(true);
    expect(completeRequestSchema.safeParse({ ...parsed.data, extra: true }).success).toBe(false);
  });

  it('parses a TurnResponse including unknown cost', () => {
    const parsed = turnResponseSchema.safeParse({
      message: { role: 'assistant', content: 'hi' },
      finishReason: 'stop',
      model: 'deepseek-chat',
      provider: 'deepseek',
      usage: {},
      latencyMs: 12,
      cost: { estimate: 'unknown' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.cost).toEqual({ estimate: 'unknown' });
  });

  it('accepts optional reasoningContent without requiring thinking to be enabled', () => {
    const parsed = turnResponseSchema.safeParse({
      message: { role: 'assistant', content: 'hi', reasoningContent: 'because' },
      finishReason: 'stop',
      model: 'test-model',
      provider: 'deepseek',
      usage: {},
      latencyMs: 12,
      cost: { estimate: 'unknown' },
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a proba-llm PR #4 cache-aware TurnResponse', () => {
    const parsed = turnResponseSchema.safeParse({
      message: { role: 'assistant', content: 'ok' },
      finishReason: 'stop',
      model: 'deepseek-flash',
      provider: 'deepseek',
      usage: {
        promptTokens: 1000,
        completionTokens: 50,
        cachedTokens: 800,
        cacheMissTokens: 200,
      },
      latencyMs: 42,
      cached: true,
      cost: { estimate: 0.0001248, currency: 'USD', pricingVersion: 'env:0.3/1.2/hit:0.006' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.usage).toEqual({
        promptTokens: 1000,
        completionTokens: 50,
        cachedTokens: 800,
        cacheMissTokens: 200,
      });
      expect(parsed.data.cost).toEqual({
        estimate: 0.0001248,
        currency: 'USD',
        pricingVersion: 'env:0.3/1.2/hit:0.006',
      });
    }
  });

  it('still accepts a turn usage object that omits cacheMissTokens', () => {
    const parsed = turnResponseSchema.safeParse({
      message: { role: 'assistant', content: 'ok' },
      finishReason: 'stop',
      model: 'deepseek-flash',
      provider: 'deepseek',
      usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 8 },
      latencyMs: 12,
      cost: { estimate: 'unknown' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.usage.cacheMissTokens).toBeUndefined();
  });

  it('still refuses unknown usage keys', () => {
    const parsed = turnResponseSchema.safeParse({
      message: { role: 'assistant', content: 'ok' },
      finishReason: 'stop',
      model: 'deepseek-flash',
      provider: 'deepseek',
      usage: { promptTokens: 1, extra: true },
      latencyMs: 12,
      cost: { estimate: 'unknown' },
    });
    expect(parsed.success).toBe(false);
  });
});
