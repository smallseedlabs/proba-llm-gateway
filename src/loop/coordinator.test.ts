import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoopCoordinator } from './coordinator.js';
import { WorkspaceScopeError } from '../errors.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { FileRunStore } from '../adapters/file-run-store.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { CatalogPolicyEngine } from '../limbs/policy.js';
import { DomainLimbExecutor } from '../limbs/dispatcher.js';
import { UnconfiguredAdsDomain } from '../domains/ads/unconfigured.js';
import { SystemClock } from '../adapters/system-clock.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { testConfig } from '../testing/config.js';
import { AdjustableClock, RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import type { Clock } from '../ports/clock.js';
import { testCaller, testRunRequest, testToolTurn, testTurn } from '../testing/fixtures.js';
import type { RunStore } from '../ports/run-store.js';
import type { LlmClient } from '../ports/llm-client.js';
import type { ContextPort } from '../ports/context.js';
import type { LimbExecutor } from '../ports/limbs.js';
import type { AdsDomainPort } from '../ports/ads.js';

function coordinator(input: {
  llm: LlmClient;
  context?: ContextPort;
  tools?: LimbExecutor;
  ads?: AdsDomainPort;
  runs?: RunStore;
  audit?: MemoryAuditPublisher;
  config?: ReturnType<typeof testConfig>;
  clock?: Clock;
}) {
  const ads = input.ads ?? new RecordingAdsDomain();
  const audit = input.audit ?? new MemoryAuditPublisher();
  const runs = input.runs ?? new MemoryRunStore('test');
  return {
    ads,
    audit,
    runs,
    coordinator: new LoopCoordinator({
      config: input.config ?? testConfig(),
      clock: input.clock ?? new SystemClock(),
      audit,
      runs,
      llm: input.llm,
      context: input.context ?? new ScriptedContextPort(),
      policy: new CatalogPolicyEngine(),
      approval: new FailClosedApprovalGate(),
      tools: input.tools ?? new DomainLimbExecutor(ads),
      ads,
    }),
  };
}

const createArgs = {
  name: 'Spring',
  landingPageUrl: 'https://example.com/offer',
  dailyBudget: 10,
  currency: 'USD',
  platform: 'reddit',
};

describe('loop coordinator', () => {
  it('rejects a workspace claim that does not match the body', async () => {
    const { coordinator: loop } = coordinator({ llm: new ScriptedLlmClient([testTurn()]) });
    await expect(loop.start(testRunRequest(), testCaller({ workspaceId: 'other-workspace' }))).rejects.toBeInstanceOf(
      WorkspaceScopeError
    );
  });

  it('completes a final reply without tools', async () => {
    const llm = new ScriptedLlmClient([testTurn({ message: { role: 'assistant', content: 'hello back' } })]);
    const context = new ScriptedContextPort();
    const { coordinator: loop } = coordinator({ llm, context });
    const snapshot = await loop.start(testRunRequest(), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(snapshot.outputs).toEqual([{ type: 'reply', text: 'hello back' }]);
    expect(llm.completeCalls).toBe(1);
    expect(context.builds).toBe(1);
  });

  it('pauses for Hub approval, then executes bound Ads args on resume', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('ads.create_campaign', createArgs),
      testTurn({ message: { role: 'assistant', content: 'campaign created' } }),
    ]);
    const ads = new RecordingAdsDomain();
    const { coordinator: loop, runs } = coordinator({ llm, ads });
    const idempotencyKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const req = testRunRequest({ idempotencyKey });
    const first = await loop.start(req, testCaller());
    expect(first.status).toBe('awaiting_approval');
    expect(ads.calls).toHaveLength(0);
    const stored = await runs.getByRunId(first.runId);
    const need = first.needs?.[0] as { askId?: string } | undefined;
    expect(stored?.pendingApproval?.askId).toBe(need?.askId);
    expect(need?.askId).toMatch(/^[0-9a-f-]{36}$/i);

    const resumed = await loop.start(
      testRunRequest({
        idempotencyKey,
        resume: { askId: need!.askId!, choice: 'approve' },
      }),
      testCaller()
    );
    expect(resumed.status).toBe('completed');
    expect(ads.calls).toHaveLength(1);
    expect(ads.calls[0]?.args).toMatchObject(createArgs);
    expect(ads.calls[0]?.args.providerCampaignId).toBeUndefined();
    expect(llm.completeCalls).toBe(2);
  });

  it('does not treat resume.values as the executed arguments', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('ads.create_campaign', createArgs),
      testTurn({ message: { role: 'assistant', content: 'ok' } }),
    ]);
    const ads = new RecordingAdsDomain();
    const { coordinator: loop } = coordinator({ llm, ads });
    const idempotencyKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const first = await loop.start(testRunRequest({ idempotencyKey }), testCaller());
    const askId = (first.needs?.[0] as { askId: string }).askId;
    await loop.start(
      testRunRequest({
        idempotencyKey,
        resume: { askId, choice: 'approve', values: { dailyBudget: 999, providerCampaignId: 'invented' } },
      }),
      testCaller()
    );
    expect(ads.calls[0]?.args.dailyBudget).toBe(10);
    expect(ads.calls[0]?.args.providerCampaignId).toBeUndefined();
  });

  it('fails closed when the Ads domain is unconfigured', async () => {
    const llm = new ScriptedLlmClient([testToolTurn('ads.create_campaign', createArgs)]);
    const { coordinator: loop } = coordinator({
      llm,
      ads: new UnconfiguredAdsDomain(),
    });
    const first = await loop.start(testRunRequest({ idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), testCaller());
    const askId = (first.needs?.[0] as { askId: string }).askId;
    const done = await loop.start(
      testRunRequest({
        idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        resume: { askId, choice: 'approve' },
      }),
      testCaller()
    );
    expect(done.status).toBe('blocked');
    expect(done.error?.code).toBe('preflight_blocked');
    expect(done.error?.message).toMatch(/ADS_DOMAIN_URL|not ready|not configured/);
  });

  it('refuses a second paid LLM call after unknown cost when a USD ceiling is set', async () => {
    const idempotencyKey = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const llmUnknown = new ScriptedLlmClient([
      {
        ...testToolTurn('page.attach_user_page', { url: 'https://example.com/x' }),
        cost: { estimate: 'unknown' },
      },
      testTurn(),
    ]);
    const again = coordinator({ llm: llmUnknown, config: testConfig({ limits: { ...testConfig().limits, maxCostUsd: 1 } }) });
    const first = await again.coordinator.start(testRunRequest({ idempotencyKey }), testCaller());
    const askId = (first.needs?.[0] as { askId: string }).askId;
    const done = await again.coordinator.start(
      testRunRequest({ idempotencyKey, resume: { askId, choice: 'approve' } }),
      testCaller()
    );
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('budget_exhausted');
    expect(llmUnknown.completeCalls).toBe(1);
  });

  it('does not redispatch an ambiguous LLM turn', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    llm.hang = () => new Promise(() => undefined);
    const { coordinator: loop, runs } = coordinator({ llm });
    const idempotencyKey = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const pending = loop.start(testRunRequest({ idempotencyKey }), testCaller());
    await waitFor(() => runs.unpublished().then((rows) => rows.some((r) => r.llmTurns[0]?.state === 'inflight')));
    const row = (await runs.unpublished())[0];
    if (!row) throw new Error('expected inflight run');
    await loop.cancel(row.runId, 'hub_cancel', testCaller());
    const snapshot = await pending;
    expect(snapshot.status === 'ambiguous' || snapshot.status === 'cancelled').toBe(true);
    const again = await loop.start(testRunRequest({ idempotencyKey }), testCaller());
    expect(again.status).toBe(snapshot.status);
    expect(llm.completeCalls).toBe(1);
  });

  it('replays the audit outbox without calling the LLM again', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    const audit = new MemoryAuditPublisher();
    audit.failPublish = true;
    const { coordinator: loop } = coordinator({ llm, audit });
    const snapshot = await loop.start(testRunRequest(), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(audit.events).toHaveLength(0);
    audit.failPublish = false;
    await loop.relayPending();
    expect(audit.events.length).toBeGreaterThan(0);
    expect(llm.completeCalls).toBe(1);
    const contentEvents = audit.events.filter((e) => e.content?.kind === 'prompt' || e.content?.kind === 'brain_reply');
    expect(contentEvents.length).toBeGreaterThan(0);
  });

  it('preserves usage and approval records across FileRunStore restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proba-gw-runs-'));
    try {
      const llm = new ScriptedLlmClient([testToolTurn('ads.create_campaign', createArgs)]);
      const firstStore = new FileRunStore(dir);
      const { coordinator: loop } = coordinator({ llm, runs: firstStore });
      const idempotencyKey = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const snapshot = await loop.start(testRunRequest({ idempotencyKey }), testCaller());
      expect(snapshot.status).toBe('awaiting_approval');
      await firstStore.close();
      const restarted = new FileRunStore(dir);
      const loaded = await restarted.getByRunId(snapshot.runId);
      expect(loaded?.pendingApproval?.verbName).toBe('ads.create_campaign');
      expect(loaded?.usage.llmCalls).toBe(1);
      expect(loaded?.snapshot?.status).toBe('awaiting_approval');
      await restarted.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks launch_campaign when Ads is unconfigured without LLM or mutations', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    const ads = new UnconfiguredAdsDomain();
    const { coordinator: loop } = coordinator({ llm, ads });
    const snapshot = await loop.start(testRunRequest({ stepType: 'launch_campaign' }), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(snapshot.error?.code).toBe('preflight_blocked');
    expect(llm.completeCalls).toBe(0);
    expect(snapshot.needs?.some((n) => (n as { capability?: string }).capability === 'ads.service')).toBe(true);
  });

  it('blocks launch_campaign when the Ads domain is down without LLM or mutations', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    const ads = new RecordingAdsDomain();
    ads.preflightDown = true;
    const { coordinator: loop } = coordinator({ llm, ads });
    const snapshot = await loop.start(testRunRequest({ stepType: 'launch_campaign' }), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(llm.completeCalls).toBe(0);
    expect(ads.calls).toHaveLength(0);
  });

  it('blocks launch_campaign when the workspace/provider is unauthorized', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    const ads = new RecordingAdsDomain();
    ads.preflightUnauthorized = true;
    const { coordinator: loop } = coordinator({ llm, ads });
    const snapshot = await loop.start(testRunRequest({ stepType: 'launch_campaign' }), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(snapshot.needs?.some((n) => (n as { capability?: string }).capability === 'ads.connection')).toBe(true);
    expect(llm.completeCalls).toBe(0);
    expect(ads.calls).toHaveLength(0);
  });

  it('blocks launch_campaign when authoritative billing is ineligible', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    const ads = new RecordingAdsDomain();
    ads.billing = {
      kind: 'verified',
      mode: 'billing_eligibility',
      eligible: false,
      asOf: new Date().toISOString(),
      source: 'ads_domain',
    };
    const { coordinator: loop } = coordinator({ llm, ads });
    const snapshot = await loop.start(testRunRequest({ stepType: 'launch_campaign' }), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(snapshot.needs?.some((n) => (n as { capability?: string }).capability === 'ads.billing')).toBe(true);
    expect(llm.completeCalls).toBe(0);
    expect(ads.calls).toHaveLength(0);
  });

  it('blocks launch_campaign when provider funds are required-unknown', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    const ads = new RecordingAdsDomain();
    ads.billing = {
      kind: 'unknown',
      reason: 'Ads domain does not support a provider balance probe',
    };
    const { coordinator: loop } = coordinator({ llm, ads });
    const snapshot = await loop.start(testRunRequest({ stepType: 'launch_campaign' }), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(snapshot.error?.message).toMatch(/not verified|unknown|Locked policy/i);
    expect(llm.completeCalls).toBe(0);
    expect(ads.calls).toHaveLength(0);
  });

  it('continues a healthy authorized launch_campaign preflight into the LLM loop', async () => {
    const llm = new ScriptedLlmClient([testTurn({ message: { role: 'assistant', content: 'ready to launch' } })]);
    const ads = new RecordingAdsDomain();
    const { coordinator: loop } = coordinator({ llm, ads });
    const snapshot = await loop.start(testRunRequest({ stepType: 'launch_campaign' }), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(llm.completeCalls).toBe(1);
    expect(ads.preflightCalls).toBeGreaterThan(0);
    expect(ads.calls).toHaveLength(0);
  });

  it('evaluates the graph before every LLM turn and reuses fresh Ads evidence', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('page.attach_user_page', { url: 'https://example.com/x' }),
      testTurn({ message: { role: 'assistant', content: 'page attached' } }),
    ]);
    const ads = new RecordingAdsDomain();
    const clock = new AdjustableClock();
    const { coordinator: loop } = coordinator({
      llm,
      ads,
      clock,
      config: testConfig({ ads: { ...testConfig().ads, preflightFreshnessMs: 30_000 } }),
    });
    const idempotencyKey = '12121212-1212-4121-8121-121212121212';
    const first = await loop.start(testRunRequest({ stepType: 'launch_campaign', idempotencyKey }), testCaller());
    expect(first.status).toBe('awaiting_approval');
    expect(llm.completeCalls).toBe(1);
    const askId = (first.needs?.[0] as { askId: string }).askId;
    const done = await loop.start(
      testRunRequest({ stepType: 'launch_campaign', idempotencyKey, resume: { askId, choice: 'approve' } }),
      testCaller()
    );
    expect(done.status).toBe('completed');
    expect(llm.completeCalls).toBe(2);
    expect(ads.preflightCalls).toBe(1);
    expect(ads.calls).toHaveLength(0);
  });

  it('re-probes Ads when cached evidence is stale before the next LLM turn', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('page.attach_user_page', { url: 'https://example.com/x' }),
      testTurn({ message: { role: 'assistant', content: 'page attached' } }),
    ]);
    const ads = new RecordingAdsDomain();
    const clock = new AdjustableClock();
    const { coordinator: loop } = coordinator({
      llm,
      ads,
      clock,
      config: testConfig({ ads: { ...testConfig().ads, preflightFreshnessMs: 1_000 } }),
    });
    const idempotencyKey = '13131313-1313-4131-8131-131313131313';
    const first = await loop.start(testRunRequest({ stepType: 'launch_campaign', idempotencyKey }), testCaller());
    const askId = (first.needs?.[0] as { askId: string }).askId;
    clock.advance(5_000);
    const done = await loop.start(
      testRunRequest({ stepType: 'launch_campaign', idempotencyKey, resume: { askId, choice: 'approve' } }),
      testCaller()
    );
    expect(done.status).toBe('completed');
    expect(llm.completeCalls).toBe(2);
    expect(ads.preflightCalls).toBe(2);
  });

  it('lets analysis continue with insufficient ad funds and zero Ads probes or LLM quota spend', async () => {
    const llm = new ScriptedLlmClient([testTurn({ message: { role: 'assistant', content: 'analysis' } })]);
    const ads = new RecordingAdsDomain();
    ads.billing = {
      kind: 'verified',
      mode: 'billing_eligibility',
      eligible: false,
      asOf: new Date().toISOString(),
      source: 'ads_domain',
    };
    const { coordinator: loop } = coordinator({ llm, ads });
    const snapshot = await loop.start(testRunRequest({ stepType: 'review_performance' }), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(llm.completeCalls).toBe(1);
    expect(ads.preflightCalls).toBe(0);
    expect(ads.calls).toHaveLength(0);
  });

  it('lets pause proceed with insufficient ad funds while resume/create still block with zero LLM', async () => {
    const ineligible = {
      kind: 'verified' as const,
      mode: 'billing_eligibility' as const,
      eligible: false,
      asOf: new Date().toISOString(),
      source: 'ads_domain' as const,
    };
    const pauseLlm = new ScriptedLlmClient([testTurn({ message: { role: 'assistant', content: 'paused' } })]);
    const pauseAds = new RecordingAdsDomain();
    pauseAds.billing = ineligible;
    pauseAds.mappingReady = true;
    pauseAds.campaignRunning = true;
    const pauseLoop = coordinator({ llm: pauseLlm, ads: pauseAds });
    const paused = await pauseLoop.coordinator.start(
      testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: '14141414-1414-4141-8141-141414141414',
          type: 'control',
          payload: { action: 'pause', target: 'camp-1' },
          sentAt: new Date().toISOString(),
        },
      }),
      testCaller()
    );
    expect(paused.status).toBe('completed');
    expect(pauseLlm.completeCalls).toBe(1);
    expect(pauseAds.calls).toHaveLength(0);
    expect(paused.needs?.some((n) => (n as { capability?: string }).capability === 'ads.billing')).toBeFalsy();

    const resumeLlm = new ScriptedLlmClient([testTurn()]);
    const resumeAds = new RecordingAdsDomain();
    resumeAds.billing = ineligible;
    resumeAds.mappingReady = true;
    resumeAds.campaignRunning = true;
    const resumeLoop = coordinator({ llm: resumeLlm, ads: resumeAds });
    const resumed = await resumeLoop.coordinator.start(
      testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: '15151515-1515-4151-8151-151515151515',
          type: 'control',
          payload: { action: 'resume', target: 'camp-1' },
          sentAt: new Date().toISOString(),
        },
      }),
      testCaller()
    );
    expect(resumed.status).toBe('blocked');
    expect(resumeLlm.completeCalls).toBe(0);
    expect(resumeAds.calls).toHaveLength(0);
    expect(resumed.needs?.some((n) => (n as { capability?: string }).capability === 'ads.billing')).toBe(true);
  });

  it('executes pause despite insufficient funds and blocks create immediately before spend', async () => {
    const ineligible = {
      kind: 'verified' as const,
      mode: 'billing_eligibility' as const,
      eligible: false,
      asOf: new Date().toISOString(),
      source: 'ads_domain' as const,
    };
    const pauseLlm = new ScriptedLlmClient([
      testToolTurn('ads.pause_campaign', { probaCampaignId: 'camp-1' }),
      testTurn({ message: { role: 'assistant', content: 'paused' } }),
    ]);
    const pauseAds = new RecordingAdsDomain();
    pauseAds.billing = ineligible;
    pauseAds.mappingReady = true;
    pauseAds.campaignRunning = true;
    const pauseLoop = coordinator({ llm: pauseLlm, ads: pauseAds });
    const pauseKey = '17171717-1717-4171-8171-171717171717';
    const firstPause = await pauseLoop.coordinator.start(testRunRequest({ idempotencyKey: pauseKey }), testCaller());
    const pauseAsk = (firstPause.needs?.[0] as { askId: string }).askId;
    const paused = await pauseLoop.coordinator.start(
      testRunRequest({ idempotencyKey: pauseKey, resume: { askId: pauseAsk, choice: 'approve' } }),
      testCaller()
    );
    expect(paused.status).toBe('completed');
    expect(pauseAds.calls).toHaveLength(1);
    expect(pauseAds.calls[0]?.verb).toBe('ads.pause_campaign');

    const createLlm = new ScriptedLlmClient([testToolTurn('ads.create_campaign', createArgs)]);
    const createAds = new RecordingAdsDomain();
    createAds.billing = ineligible;
    const createLoop = coordinator({ llm: createLlm, ads: createAds });
    const createKey = '18181818-1818-4181-8181-181818181818';
    const firstCreate = await createLoop.coordinator.start(testRunRequest({ idempotencyKey: createKey }), testCaller());
    const createAsk = (firstCreate.needs?.[0] as { askId: string }).askId;
    const created = await createLoop.coordinator.start(
      testRunRequest({ idempotencyKey: createKey, resume: { askId: createAsk, choice: 'approve' } }),
      testCaller()
    );
    expect(created.status).toBe('blocked');
    expect(createAds.calls).toHaveLength(0);
    expect(created.needs?.some((n) => (n as { capability?: string }).capability === 'ads.billing')).toBe(true);
  });

  it('does not treat a running campaign as authorization for pause', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    const ads = new RecordingAdsDomain();
    ads.preflightUnauthorized = true;
    ads.campaignRunning = true;
    ads.mappingReady = true;
    const { coordinator: loop } = coordinator({ llm, ads });
    const snapshot = await loop.start(
      testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: '16161616-1616-4161-8161-161616161616',
          type: 'control',
          payload: { action: 'pause', target: 'camp-1' },
          sentAt: new Date().toISOString(),
        },
      }),
      testCaller()
    );
    expect(snapshot.status).toBe('blocked');
    expect(snapshot.needs?.some((n) => (n as { capability?: string }).capability === 'ads.connection')).toBe(true);
    expect(llm.completeCalls).toBe(0);
    expect(ads.calls).toHaveLength(0);
  });

  it('completes one LLM turn when maxIterations is 1', async () => {
    const llm = new ScriptedLlmClient([testTurn({ message: { role: 'assistant', content: 'one' } })]);
    const { coordinator: loop } = coordinator({
      llm,
      config: testConfig({ limits: { ...testConfig().limits, maxIterations: 1 } }),
    });
    const snapshot = await loop.start(testRunRequest(), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(llm.completeCalls).toBe(1);
    expect(snapshot.usage.llmCalls).toBe(1);
  });

  it('does not dispatch a second LLM after maxIterations=1 plus a tool pause', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('page.attach_user_page', { url: 'https://example.com/x' }),
      testTurn({ message: { role: 'assistant', content: 'should not run' } }),
    ]);
    const { coordinator: loop } = coordinator({
      llm,
      config: testConfig({ limits: { ...testConfig().limits, maxIterations: 1 } }),
    });
    const req = testRunRequest({ idempotencyKey: '19191919-1919-4191-8191-191919191919' });
    const first = await loop.start(req, testCaller());
    expect(first.status).toBe('awaiting_approval');
    expect(llm.completeCalls).toBe(1);
    const askId = (first.needs?.[0] as { askId: string }).askId;
    const done = await loop.start({ ...req, resume: { askId, choice: 'approve' } }, testCaller());
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('budget_exhausted');
    expect(llm.completeCalls).toBe(1);
  });

  it('counts a failed LLM dispatch in usage and does not redispatch the same run', async () => {
    const llm = new ScriptedLlmClient([]);
    const { coordinator: loop } = coordinator({ llm });
    const req = testRunRequest({ idempotencyKey: '20202020-2020-4202-8202-202020202020' });
    const snapshot = await loop.start(req, testCaller());
    expect(snapshot.status).toBe('failed');
    expect(llm.completeCalls).toBe(1);
    expect(snapshot.usage.llmCalls).toBe(1);
    expect(snapshot.usage.cost).toEqual({ estimate: 'unknown' });
    const again = await loop.start(req, testCaller());
    expect(again.status).toBe('failed');
    expect(llm.completeCalls).toBe(1);
  });
});

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}
