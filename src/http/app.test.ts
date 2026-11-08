import { randomUUID } from 'node:crypto';
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
import { UnconfiguredResearchProvider } from '../research/unconfigured.js';

describe('HTTP gateway', () => {
  it('serves health without auth and refuses unauthenticated runs', async () => {
    const signer = await createTestSigner();
    const config = testConfig();
    const llm = new ScriptedLlmClient([testTurn()]);
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
        llm,
        context: new ScriptedContextPort(),
        policy: new CatalogPolicyEngine(),
        approval: new FailClosedApprovalGate(),
        tools: new DomainLimbExecutor(ads, { provider: new UnconfiguredResearchProvider(), store: researchStore, clock }),
        ads,
        researchStore,
      }),
      auth: new ServiceTokenAuth({
        keys: signer.keys,
        allowedIssuers: ['proba-hub'],
        allowedSubjects: ['hub'],
      }),
      audit,
      clock: new SystemClock(),
      logger: createLogger('silent'),
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', service: 'gateway' });

    const unauth = await app.inject({ method: 'POST', url: '/v1/runs', payload: {} });
    expect(unauth.statusCode).toBe(401);

    const token = await mintHubToken(signer);
    const body = testRunRequest();
    const run = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe('completed');
    expect(llm.completeCalls).toBe(1);
    await app.close();
  });

  it('rejects a cross-workspace token and unknown run lookup', async () => {
    const signer = await createTestSigner();
    const config = testConfig();
    const audit = new MemoryAuditPublisher();
    const clock = new SystemClock();
    const researchStore = new MemoryResearchStore('test');
    const ads = new RecordingAdsDomain();
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
      }),
      auth: new ServiceTokenAuth({
        keys: signer.keys,
        allowedIssuers: ['proba-hub'],
        allowedSubjects: ['hub'],
      }),
      audit,
      clock: new SystemClock(),
      logger: createLogger('silent'),
    });
    const scoped = await mintHubToken(signer, () => new Date(), { workspaceId: 'other-workspace' });
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${scoped}` },
      payload: testRunRequest(),
    });
    expect(denied.statusCode).toBe(403);

    const token = await mintHubToken(signer);
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/runs/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
