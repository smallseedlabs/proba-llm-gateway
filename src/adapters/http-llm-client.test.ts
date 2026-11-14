import { describe, expect, it } from 'vitest';
import { HttpLlmClient } from './http-llm-client.js';
import type { LlmServiceTokenSigner } from '../ports/token-signer.js';

const signer: LlmServiceTokenSigner = { kid: 'test', mint: async () => 'test-token' };

function client(fetchImpl: typeof fetch): HttpLlmClient {
  return new HttpLlmClient({
    baseUrl: 'https://llm.example',
    allowedHosts: ['llm.example'],
    nodeEnv: 'test',
    timeoutMs: 1000,
    signer,
    fetchImpl,
  });
}

const pr4CompleteBody = {
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
};

describe('HttpLlmClient cache-hit pricing', () => {
  it('carries promptCacheHitUsdPerMillion from a proba-llm PR #4 /v1/pricing body', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      expect(String(url)).toBe('https://llm.example/v1/pricing');
      return new Response(
        JSON.stringify({
          promptUsdPerMillion: 0.3,
          completionUsdPerMillion: 1.2,
          currency: 'USD',
          version: 'env:0.3/1.2/hit:0.006',
          promptCacheHitUsdPerMillion: 0.006,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const claim = await client(fetchImpl).pricing();
    expect(claim).toEqual({
      kind: 'verified',
      promptUsdPerMillion: 0.3,
      completionUsdPerMillion: 1.2,
      version: 'env:0.3/1.2/hit:0.006',
      promptCacheHitUsdPerMillion: 0.006,
    });
  });

  it('still verifies a pricing body that omits the cache-hit rate', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ promptUsdPerMillion: 0.27, completionUsdPerMillion: 1.1, currency: 'USD', version: 'env:0.27/1.1' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    await expect(client(fetchImpl).pricing()).resolves.toEqual({
      kind: 'verified',
      promptUsdPerMillion: 0.27,
      completionUsdPerMillion: 1.1,
      version: 'env:0.27/1.1',
    });
  });

  it('parses a proba-llm PR #4 complete response including cacheMissTokens', async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('https://llm.example/v1/complete');
      expect((init as RequestInit | undefined)?.method).toBe('POST');
      return new Response(JSON.stringify(pr4CompleteBody), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const turn = await client(fetchImpl).complete(
      {
        traceId: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'seedbed',
        messages: [{ role: 'user', content: 'hello' }],
      },
      { idempotencyKey: '22222222-2222-4222-8222-222222222222' }
    );
    expect(turn.usage).toEqual(pr4CompleteBody.usage);
    expect(turn.cost).toEqual(pr4CompleteBody.cost);
  });
});
