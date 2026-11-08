/**
 * Fastify 5 compatibility around the production highs we remediating.
 * These are boundary tests, not exploit PoCs. trustProxy stays false.
 */

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { LoopCoordinator } from '../loop/coordinator.js';
import { ServiceTokenAuth } from '../auth/service-token.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { CatalogPolicyEngine } from '../limbs/policy.js';
import { DomainLimbExecutor } from '../limbs/dispatcher.js';
import { SystemClock } from '../adapters/system-clock.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { createTestSigner, mintHubToken } from '../testing/token-signer.js';
import { testConfig } from '../testing/config.js';
import { RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { testRunRequest, testTurn } from '../testing/fixtures.js';
import { createLogger } from '../logger.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { UnconfiguredResearchProvider } from '../research/unconfigured.js';

async function testApp() {
  const signer = await createTestSigner();
  const config = testConfig();
  const ads = new RecordingAdsDomain();
  const audit = new MemoryAuditPublisher();
  const clock = new SystemClock();
  const researchStore = new MemoryResearchStore('test');
  const app = await buildApp({
    config,
    coordinator: new LoopCoordinator({
      config,
      clock,
      audit,
      runs: new MemoryRunStore('test'),
      llm: new ScriptedLlmClient([testTurn()]),
      context: new ScriptedContextPort(),
      policy: new CatalogPolicyEngine(),
      approval: new FailClosedApprovalGate(),
      tools: new DomainLimbExecutor(ads, { provider: new UnconfiguredResearchProvider(), store: researchStore, clock }),
      ads,
      researchStore,
      analyticsStore: new MemoryAnalyticsStore('test'),
    }),
    auth: new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-hub'],
      allowedSubjects: ['hub'],
    }),
    audit,
    clock,
    logger: createLogger('silent'),
  });
  return { app, signer };
}

describe('Fastify 5 production-high compatibility', () => {
  it('does not trust forwarded proto or host when trustProxy is false', async () => {
    const probe = Fastify({ logger: false, trustProxy: false });
    probe.get('/probe', async (request) => ({
      protocol: request.protocol,
      host: request.host,
      hostname: request.hostname,
    }));
    const res = await probe.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example',
        host: '127.0.0.1:3700',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { protocol: string; host: string; hostname: string };
    expect(body.protocol).toBe('http');
    expect(body.host).not.toMatch(/evil/i);
    expect(body.hostname).not.toMatch(/evil/i);
    await probe.close();
  });

  it('still validates JSON when Content-Type tab follows the subtype', async () => {
    const { app, signer } = await testApp();
    const token = await mintHubToken(signer);
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json\t',
      },
      payload: { notAHubRun: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'invalid_request' });

    const valid = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json\t',
      },
      payload: testRunRequest(),
    });
    expect(valid.statusCode).toBe(200);
    await app.close();
  });

  it('does not skip auth on a malformed run path', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'GET', url: '/v1/runs/%2e%2e/health' });
    expect([401, 404]).toContain(res.statusCode);
    expect(res.json()).not.toEqual({ status: 'ok', service: 'gateway' });
    await app.close();
  });
});
