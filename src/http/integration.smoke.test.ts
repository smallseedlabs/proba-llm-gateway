/**
 * Isolated HTTP smoke: real coordinator + HttpContextClient + HttpLlmClient
 * against local TEST STUB servers. No DeepSeek, no shared audit/DB, no
 * vendor Ads credentials.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '../runtime.js';
import { buildApp } from './app.js';
import { testConfig } from '../testing/config.js';
import { createTestSigner, mintHubToken } from '../testing/token-signer.js';
import { listenJsonServer, type LocalHttpServer } from '../testing/local-http.js';
import { writeTestSigningKeyFile } from '../testing/signing-key.js';
import { testContextPacket, testRunRequest, TEST_GOAL_ID, TEST_THREAD_ID } from '../testing/fixtures.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { AUDIT_CONTENT_MAX_CHARS } from '../protocol.js';
import type { FastifyInstance } from 'fastify';
import type { TurnResponse } from '../types/llm.js';

const createArgs = {
  name: 'Spring',
  landingPageUrl: 'https://example.com/offer',
  dailyBudget: 10,
  currency: 'USD',
  platform: 'reddit',
};

function toolTurn(): TurnResponse {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call-1', name: 'ads.create_campaign', arguments: JSON.stringify(createArgs) }],
    },
    finishReason: 'tool_calls',
    model: 'test-model',
    provider: 'test-stub',
    usage: { promptTokens: 40, completionTokens: 12 },
    latencyMs: 3,
    cost: { estimate: 0.002, currency: 'USD', pricingVersion: 'test-v1' },
  };
}

function finalTurn(text: string): TurnResponse {
  return {
    message: { role: 'assistant', content: text },
    finishReason: 'stop',
    model: 'test-model',
    provider: 'test-stub',
    usage: { promptTokens: 60, completionTokens: 10 },
    latencyMs: 3,
    cost: { estimate: 0.003, currency: 'USD', pricingVersion: 'test-v1' },
  };
}

describe('isolated HTTP integration smoke', () => {
  let llmServer: LocalHttpServer;
  let contextServer: LocalHttpServer;
  let adsServer: LocalHttpServer;
  let app: FastifyInstance;
  let token: string;
  let otherToken: string;
  const llmCalls: unknown[] = [];
  const adsCalls: unknown[] = [];
  const contextCalls: unknown[] = [];
  let llmMode: 'happy' | 'ambiguous' | 'unknown-cost' = 'happy';
  const audit = new MemoryAuditPublisher();
  const runs = new MemoryRunStore('test');

  beforeAll(async () => {
    const signer = await createTestSigner();
    const signing = await writeTestSigningKeyFile();
    llmServer = await listenJsonServer(async ({ method, url, body }) => {
      if (method === 'GET' && url === '/ready') return { status: 200, body: { status: 'ready' } };
      if (method !== 'POST' || url !== '/v1/complete') return { status: 404, body: { error: 'not_found' } };
      llmCalls.push(body);
      if (llmMode === 'ambiguous') return { status: 504, body: { error: 'provider_ambiguous', message: 'timed out' } };
      const messages = (body as { messages?: Array<{ role: string }> }).messages ?? [];
      const hasToolResult = messages.some((m) => m.role === 'tool');
      if (llmMode === 'unknown-cost') {
        return {
          status: 200,
          body: { ...toolTurn(), cost: { estimate: 'unknown' } },
        };
      }
      return { status: 200, body: hasToolResult ? finalTurn('campaign is live') : toolTurn() };
    });
    contextServer = await listenJsonServer(async ({ method, url, headers, body }) => {
      if (method === 'GET' && (url === '/ready' || url === '/health')) {
        return { status: 200, body: { status: 'ok', service: 'context' } };
      }
      if (method !== 'POST' || url !== '/v1/context/build') return { status: 404, body: { error: 'not_found' } };
      contextCalls.push({ authorization: headers.authorization, body });
      const req = body as { traceId: string; workspaceId: string; goalId?: string };
      const packet = testContextPacket({
        traceId: req.traceId,
        workspaceId: req.workspaceId,
        goalId: req.goalId ?? TEST_GOAL_ID,
        sections: [
          {
            kind: 'task',
            priority: 0,
            tokens: 8,
            items: [
              {
                itemId: 'goal-state',
                sourceRef: { source: 'hub.task', id: TEST_GOAL_ID },
                trust: 'system',
                text: `User-provided landing page is required before ads. ${'x'.repeat(AUDIT_CONTENT_MAX_CHARS)}`,
                observedAt: new Date().toISOString(),
              },
            ],
          },
        ],
      });
      return { status: 200, body: packet };
    });
    adsServer = await listenJsonServer(async ({ method, url, body }) => {
      if (method === 'POST' && url === '/v1/preflight') {
        const asOf = new Date().toISOString();
        return {
          status: 200,
          body: {
            asOf,
            freshUntil: new Date(Date.now() + 60_000).toISOString(),
            service: { state: 'ready' },
            connection: { state: 'ready', platform: 'reddit' },
            permissions: { state: 'ready', actions: ['ads.create_campaign'] },
            blueprint: { state: 'not_required' },
            billing: {
              kind: 'verified',
              mode: 'billing_eligibility',
              eligible: true,
              asOf,
              source: 'ads_domain',
            },
          },
        };
      }
      if (method !== 'POST' || url !== '/v1/campaign-actions') return { status: 404, body: { error: 'not_found' } };
      adsCalls.push(body);
      const action = body as { verb: string; args: Record<string, unknown> };
      if (action.args.providerCampaignId) {
        return { status: 400, body: { error: 'provider_id_refused', message: 'pass probaCampaignId only' } };
      }
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            probaCampaignId: typeof action.args.probaCampaignId === 'string' ? action.args.probaCampaignId : 'proba-camp-1',
            mappings: [
              {
                probaCampaignId: 'proba-camp-1',
                provider: 'reddit',
                providerCampaignId: 'r-mapped-1',
                providerAdGroupId: 'r-ag-1',
              },
            ],
          },
        },
      };
    });

    const runtime = await createRuntime(
      testConfig({
        llm: {
          ...testConfig().llm,
          baseUrl: llmServer.url,
          allowedHosts: ['127.0.0.1'],
          signingKeyFile: signing.file,
          signingKeyId: signing.kid,
        },
        context: {
          ...testConfig().context,
          baseUrl: contextServer.url,
          allowedHosts: ['127.0.0.1'],
        },
        ads: {
          ...testConfig().ads,
          baseUrl: adsServer.url,
          allowedHosts: ['127.0.0.1'],
          timeoutMs: 1000,
          tokenAudience: 'proba-ads',
        },
        audit: { ...testConfig().audit, contentEnabled: true, contentMaskPii: true },
      }),
      {
        hubKeys: signer.keys,
        audit,
        runs,
      }
    );
    app = await buildApp({
      config: runtime.config,
      coordinator: runtime.coordinator,
      auth: runtime.auth,
      audit: runtime.audit,
      clock: runtime.clock,
      logger: runtime.logger,
      ready: () => runtime.ready(),
    });
    token = await mintHubToken(signer);
    otherToken = await mintHubToken(signer, () => new Date(), { workspaceId: 'other-workspace' });
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([llmServer.close(), contextServer.close(), adsServer.close()]);
  });

  it('runs proposal -> guardrails -> Ads test adapter -> context -> final, then approval resume', async () => {
    llmMode = 'happy';
    const idempotencyKey = randomUUID();
    const payload = testRunRequest({
      idempotencyKey,
      goalId: TEST_GOAL_ID,
      threadId: TEST_THREAD_ID,
      command: {
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'send_message',
        payload: { text: 'create a campaign' },
        sentAt: new Date().toISOString(),
      },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const waiting = first.json();
    expect(waiting.status).toBe('awaiting_approval');
    expect(adsCalls).toHaveLength(0);
    expect(contextCalls.length).toBeGreaterThan(0);
    const askId = (waiting.needs as Array<{ askId: string }>)[0]?.askId;
    expect(askId).toBeTruthy();

    const got = await app.inject({
      method: 'GET',
      url: `/v1/runs/${waiting.runId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe('awaiting_approval');

    const cross = await app.inject({
      method: 'GET',
      url: `/v1/runs/${waiting.runId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(cross.statusCode).toBe(403);

    const resumed = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, resume: { askId, choice: 'approve' } },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).toBe('completed');
    expect(resumed.json().outputs[0].text).toBe('campaign is live');
    expect(adsCalls).toHaveLength(1);
    expect((adsCalls[0] as { args: Record<string, unknown> }).args).toMatchObject(createArgs);
    expect(audit.events.some((e) => e.content && e.content.text.length > 0)).toBe(true);
    expect(audit.events.some((e) => e.action === 'brain.prompt_chunk')).toBe(true);
  });

  it('cancels an awaiting-approval run without executing Ads', async () => {
    llmMode = 'happy';
    const adsBefore = adsCalls.length;
    const payload = testRunRequest({ idempotencyKey: randomUUID() });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    const runId = first.json().runId as string;
    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'hub_cancel' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect(adsCalls.length).toBe(adsBefore);
  });

  it('does not redispatch after an ambiguous LLM outcome', async () => {
    llmMode = 'ambiguous';
    const before = llmCalls.length;
    const payload = testRunRequest({ idempotencyKey: randomUUID() });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('ambiguous');
    const again = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(again.json().status).toBe('ambiguous');
    expect(llmCalls.length).toBe(before + 1);
  });

  it('enforces a USD ceiling after unknown cost', async () => {
    llmMode = 'unknown-cost';
    const payload = testRunRequest({
      idempotencyKey: randomUUID(),
      budget: { maxCostUsd: 1, maxLlmCalls: 8, maxIterations: 8 },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    const askId = (first.json().needs as Array<{ askId: string }>)[0]?.askId;
    const resumed = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, resume: { askId, choice: 'approve' } },
    });
    expect(resumed.json().status).toBe('failed');
    expect(resumed.json().error.code).toBe('budget_exhausted');
  });

  it('replays unpublished audit events without extra LLM calls', async () => {
    llmMode = 'happy';
    audit.failPublish = true;
    const payload = testRunRequest({
      idempotencyKey: randomUUID(),
      command: {
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'send_message',
        payload: { text: 'short' },
        sentAt: new Date().toISOString(),
      },
    });
    const before = llmCalls.length;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const llmAfterRun = llmCalls.length;
    audit.failPublish = false;
    const unpublished = await runs.unpublished();
    expect(unpublished.length).toBeGreaterThan(0);
    // Coordinator relay is invoked through a fresh start of the same key.
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(llmCalls.length).toBe(llmAfterRun);
    expect(llmCalls.length).toBeGreaterThan(before);
  });
});
