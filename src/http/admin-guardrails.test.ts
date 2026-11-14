import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AdminAuthorizationError, type AdminAuth, type AdminSession } from '../auth/admin-auth.js';
import { TokenVerificationError } from '../ports/auth.js';
import { loadGuardrails } from '../guardrails/guardrails.js';
import { SystemClock } from '../adapters/system-clock.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { testConfig } from '../testing/config.js';
import { createLogger } from '../logger.js';
import { registerAdminGuardrails } from './admin-guardrails.js';
import { buildApp } from './app.js';
import { LoopCoordinator } from '../loop/coordinator.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { CatalogPolicyEngine } from '../limbs/policy.js';
import { DomainLimbExecutor } from '../limbs/dispatcher.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from '../action-policy/memory-store.js';
import { UnconfiguredResearchProvider } from '../research/unconfigured.js';
import { RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { createTestSigner, mintHubToken } from '../testing/token-signer.js';
import { ServiceTokenAuth } from '../auth/service-token.js';

const admin: AdminSession = { subject: 'uid-owner', email: 'owner@example.com', role: 'admin' };

class FakeAdminAuth implements AdminAuth {
  readonly name = 'fake-admin';
  constructor(private readonly result: AdminSession | 'forbidden' | 'unauth' | 'down' = admin) {}
  async authenticate(): Promise<AdminSession> {
    if (this.result === 'unauth') throw new TokenVerificationError('invalid_token', 'rejected');
    if (this.result === 'forbidden') throw new AdminAuthorizationError('not_allowed', 'Administrator access is required');
    if (this.result === 'down') throw new Error('jwks down');
    return this.result;
  }
}

async function adminApp(options: {
  path: string;
  auth?: AdminAuth | null;
  corsOrigins?: string[];
  envExtra?: NodeJS.ProcessEnv;
  rateLimitMax?: number;
}) {
  const env: NodeJS.ProcessEnv = { GATEWAY_GUARDRAILS_FILE: options.path, ...options.envExtra };
  const base = testConfig();
  const config = testConfig({
    guardrailsFile: options.path,
    guardrails: loadGuardrails(env, base.limits, { defaultFile: '/nonexistent' }),
    admin: {
      firebaseProjectId: 'test',
      adminEmails: ['owner@example.com'],
      corsOrigins: options.corsOrigins ?? ['http://localhost:3410'],
      workspaceId: 'seedbed',
    },
    limits: options.rateLimitMax ? { ...base.limits, rateLimitMax: options.rateLimitMax, rateLimitWindowMs: 60_000 } : base.limits,
  });
  const audit = new MemoryAuditPublisher();
  const app = Fastify({ logger: false });
  await registerAdminGuardrails(app, {
    config,
    adminAuth: options.auth === null ? undefined : (options.auth ?? new FakeAdminAuth()),
    audit,
    clock: new SystemClock(),
    logger: createLogger('silent'),
    guardrailsEnv: env,
  });
  return { app, audit, config, env };
}

const seed = { schema: 'proba.gateway-guardrails/v1', version: 't0', verbs: {}, limits: {} };

describe('GET/PUT /v1/admin/guardrails', () => {
  it('returns the effective snapshot to an administrator and reflects a tightening write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-admin-'));
    const path = join(dir, 'g.json');
    await writeFile(path, JSON.stringify(seed));
    const { app, audit, config } = await adminApp({ path });
    try {
      const got = await app.inject({ method: 'GET', url: '/v1/admin/guardrails', headers: { authorization: 'Bearer test' } });
      expect(got.statusCode).toBe(200);
      const body = got.json();
      expect(body.schema).toBe('proba.gateway-guardrails/v1-effective');
      expect(body.writable).toBe(true);
      expect(body.lockedLimits.maxIterations).toBe(8);
      expect(body.verbs.find((v: { name: string }) => v.name === 'ads.create_campaign').allowedModes).toEqual(['ask', 'deny']);
      expect(body.verbs.find((v: { name: string }) => v.name === 'ads.move_budget').allowedModes).toEqual(['deny']);

      const put = await app.inject({
        method: 'PUT',
        url: '/v1/admin/guardrails',
        headers: { authorization: 'Bearer test' },
        payload: { verbs: { 'research.gather': 'ask', 'ads.create_campaign': 'deny' }, limits: { maxIterations: 3, maxToolCalls: 4 } },
      });
      expect(put.statusCode).toBe(200);
      const after = put.json();
      expect(after.fileLimits).toEqual({ maxIterations: 3, maxToolCalls: 4 });
      expect(after.verbs.find((v: { name: string }) => v.name === 'research.gather').effective).toBe('ask');
      expect(after.verbs.find((v: { name: string }) => v.name === 'ads.create_campaign').effective).toBe('deny');
      expect(config.guardrails?.limits.maxIterations).toBe(3);
      const saved = JSON.parse(await readFile(path, 'utf8'));
      expect(saved.limits).toEqual({ maxIterations: 3, maxToolCalls: 4 });
      const changed = audit.events.filter((e) => e.action === 'config.changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]?.outcome).toBe('success');
      expect(changed[0]?.actor).toEqual({ type: 'user', id: 'uid-owner' });
      expect(changed[0]?.details).toMatchObject({ target: 'guardrails', changedLimits: expect.arrayContaining(['maxIterations', 'maxToolCalls']) });
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a loosening write, leaves the file unchanged, and audits the denial', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-admin-'));
    const path = join(dir, 'g.json');
    await writeFile(path, JSON.stringify({ ...seed, verbs: { 'research.gather': 'ask' } }));
    const { app, audit } = await adminApp({ path });
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/v1/admin/guardrails',
        headers: { authorization: 'Bearer test' },
        payload: { verbs: { 'ads.create_campaign': 'allow' }, limits: { maxIterations: 99 } },
      });
      expect(put.statusCode).toBe(400);
      expect(put.json().error).toBe('guardrails_rejected');
      expect(put.json().message).toMatch(/would loosen/);
      const saved = JSON.parse(await readFile(path, 'utf8'));
      expect(saved.verbs).toEqual({ 'research.gather': 'ask' });
      const denied = audit.events.filter((e) => e.action === 'config.changed');
      expect(denied[0]?.outcome).toBe('denied');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses unauthenticated, non-admin and unconfigured callers; Hub tokens are not accepted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-admin-'));
    const path = join(dir, 'g.json');
    await writeFile(path, JSON.stringify(seed));
    const unauth = await adminApp({ path, auth: new FakeAdminAuth('unauth') });
    const forbidden = await adminApp({ path, auth: new FakeAdminAuth('forbidden') });
    const missing = await adminApp({ path, auth: null });
    try {
      expect((await unauth.app.inject({ method: 'GET', url: '/v1/admin/guardrails' })).statusCode).toBe(401);
      expect((await unauth.app.inject({ method: 'GET', url: '/v1/admin/guardrails', headers: { authorization: 'Bearer x' } })).statusCode).toBe(401);
      expect((await forbidden.app.inject({ method: 'GET', url: '/v1/admin/guardrails', headers: { authorization: 'Bearer x' } })).statusCode).toBe(403);
      expect((await missing.app.inject({ method: 'GET', url: '/v1/admin/guardrails', headers: { authorization: 'Bearer x' } })).statusCode).toBe(503);

      const signer = await createTestSigner();
      const token = await mintHubToken(signer);
      const full = await buildApp({
        config: testConfig({ guardrailsFile: path, admin: { firebaseProjectId: '', adminEmails: [], corsOrigins: [], workspaceId: 'seedbed' } }),
        coordinator: new LoopCoordinator({
          config: testConfig(),
          clock: new SystemClock(),
          audit: new MemoryAuditPublisher(),
          runs: new MemoryRunStore('test'),
          llm: new ScriptedLlmClient([]),
          context: new ScriptedContextPort(),
          policy: new CatalogPolicyEngine(),
          approval: new FailClosedApprovalGate(),
          tools: new DomainLimbExecutor(new RecordingAdsDomain(), {
            provider: new UnconfiguredResearchProvider(),
            store: new MemoryResearchStore('test'),
            clock: new SystemClock(),
          }),
          ads: new RecordingAdsDomain(),
          researchStore: new MemoryResearchStore('test'),
          analyticsStore: new MemoryAnalyticsStore('test'),
          actionPolicyStore: new MemoryActionPolicyStore('test'),
          actionOutcomeStore: new MemoryActionOutcomeStore('test'),
        }),
        auth: new ServiceTokenAuth({ keys: signer.keys, allowedIssuers: ['proba-hub'], allowedSubjects: ['hub'] }),
        audit: new MemoryAuditPublisher(),
        clock: new SystemClock(),
        logger: createLogger('silent'),
      });
      const hub = await full.inject({ method: 'GET', url: '/v1/admin/guardrails', headers: { authorization: `Bearer ${token}` } });
      expect(hub.statusCode).toBe(503);
      await full.close();
    } finally {
      await unauth.app.close();
      await forbidden.app.close();
      await missing.app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers CORS preflight for an allowlisted Portal origin and not for others', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-admin-'));
    const path = join(dir, 'g.json');
    await writeFile(path, JSON.stringify(seed));
    const { app } = await adminApp({ path, corsOrigins: ['http://localhost:3410'] });
    try {
      const ok = await app.inject({
        method: 'OPTIONS',
        url: '/v1/admin/guardrails',
        headers: { origin: 'http://localhost:3410', 'access-control-request-method': 'PUT' },
      });
      expect(ok.statusCode).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3410');
      expect(ok.headers['access-control-allow-methods']).toMatch(/PUT/);
      const other = await app.inject({
        method: 'OPTIONS',
        url: '/v1/admin/guardrails',
        headers: { origin: 'http://evil.example' },
      });
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rate-limits repeated administrator calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-admin-'));
    const path = join(dir, 'g.json');
    await writeFile(path, JSON.stringify(seed));
    const { app } = await adminApp({ path, rateLimitMax: 2 });
    try {
      const headers = { authorization: 'Bearer test' };
      expect((await app.inject({ method: 'GET', url: '/v1/admin/guardrails', headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/v1/admin/guardrails', headers })).statusCode).toBe(200);
      const limited = await app.inject({ method: 'GET', url: '/v1/admin/guardrails', headers });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toBe('rate_limited');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
