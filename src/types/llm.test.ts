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
});
