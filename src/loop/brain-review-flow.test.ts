import { describe, expect, it } from 'vitest';
import { LoopCoordinator } from './coordinator.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { CatalogPolicyEngine } from '../limbs/policy.js';
import { DomainLimbExecutor } from '../limbs/dispatcher.js';
import { SystemClock } from '../adapters/system-clock.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { testConfig } from '../testing/config.js';
import { RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { testCaller, testRunRequest, testToolTurn, testTurn } from '../testing/fixtures.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from '../action-policy/memory-store.js';
import { SourcedResearchProvider } from '../testing/research.js';
import { fakeAnalyticsPacket, FAKE_PROBA_CAMPAIGN } from '../testing/analytics.js';
import type { ContextPacket } from '../protocol.js';

function coordinator(llm: ScriptedLlmClient, packet: ContextPacket) {
  const ads = new RecordingAdsDomain();
  const runs = new MemoryRunStore('test');
  const researchStore = new MemoryResearchStore('test');
  const clock = new SystemClock();
  const loop = new LoopCoordinator({
    config: testConfig(),
    clock,
    audit: new MemoryAuditPublisher(),
    runs,
    llm,
    context: new ScriptedContextPort(packet),
    policy: new CatalogPolicyEngine(),
    approval: new FailClosedApprovalGate(),
    tools: new DomainLimbExecutor(ads, { provider: new SourcedResearchProvider(), store: researchStore, clock }),
    ads,
    researchStore,
    analyticsStore: new MemoryAnalyticsStore('test'),
    actionPolicyStore: new MemoryActionPolicyStore('test'),
    actionOutcomeStore: new MemoryActionOutcomeStore('test'),
  });
  return { loop, ads, runs };
}

function reviewRequest(payload: Record<string, unknown> = {}) {
  return testRunRequest({
    stepType: 'review_performance',
    command: {
      kind: 'command',
      clientMsgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1',
      type: 'send_message',
      payload: {
        text: 'campaign review (schedule)',
        probaCampaignId: FAKE_PROBA_CAMPAIGN,
        platform: 'reddit',
        reviewIntent: 'brain',
        reviewTrigger: 'schedule',
        currentDailyBudget: 5,
        currency: 'USD',
        reviewBounds: { minCheckHours: 6, maxCheckHours: 72 },
        plan: { successMetric: 'clicks', successTarget: 200, durationDays: 14 },
        ...payload,
      },
      sentAt: new Date().toISOString(),
    },
  });
}

const note = {
  summary: '80 clicks for 42.50 USD in 7 days.',
  working: ['CTR about 1.6%'],
  notWorking: ['CPC above plan'],
  whyNowOrNotYet: 'CPC has been high for a full week with enough clicks; trimming budget 20% is small and reversible.',
  nextCheckInHours: 200,
  nextCheckReason: 'see whether CPC settles at the lower budget',
};

describe('brain campaign review (Hub-started run on the normal loop)', () => {
  it('offers only reviewer verbs, uses the audited packet, clamps the next check and returns a dry-run change', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('analytics.review_campaign', { ...note, decision: 'change', change: { action: 'lower_budget', dailyBudget: 4 } }),
      testTurn({ message: { role: 'assistant', content: 'Trimmed budget proposed; next look in 3 days.' } }),
    ]);
    const { loop, ads } = coordinator(llm, fakeAnalyticsPacket());
    const snap = await loop.start(reviewRequest(), testCaller());
    expect(snap.status).toBe('completed');
    const tools = (llm.requests[0]?.tools ?? []).map((t) => t.name).sort();
    expect(tools).toEqual(['analytics.report_checkpoint', 'analytics.review_campaign']);
    const system = JSON.stringify(llm.requests[0]?.messages ?? []);
    expect(system).toContain('Approved plan');
    expect(system).toContain('Be realistic, not aggressive');
    const analytics = snap.analytics as Record<string, any>;
    expect(analytics.outcome).toBe('dry_run_proposal');
    expect(analytics.grantsSpend).toBe(false);
    expect(analytics.metrics[0]).toMatchObject({ clicks: 80, spend: 42.5 });
    expect(analytics.proposal).toMatchObject({ verb: 'ads.update_campaign', dryRun: true, args: { probaCampaignId: FAKE_PROBA_CAMPAIGN, dailyBudget: 4 } });
    expect(analytics.review).toMatchObject({ decision: 'change', nextCheckInHours: 72, clamped: true });
    expect(analytics.reviewWindowUntil).toBe(analytics.review.nextCheckAt);
    expect(ads.calls).toHaveLength(0);
  });

  it('with no audited metrics, a checkpoint must say unknown; the model is told and can correct itself', async () => {
    const noMetrics = fakeAnalyticsPacket({ gaps: [] });
    noMetrics.sections = [];
    const checkpoint = { ...note, checkpoint: 'day3', metric: 'clicks', target: 200, status: 'behind', recommendation: 'continue' };
    const llm = new ScriptedLlmClient([
      testToolTurn('analytics.report_checkpoint', { ...checkpoint, actual: 80 }),
      testToolTurn('analytics.report_checkpoint', { ...checkpoint, actual: null, status: 'unknown' }),
      testTurn({ message: { role: 'assistant', content: 'No audited numbers yet.' } }),
    ]);
    const { loop } = coordinator(llm, noMetrics);
    const snap = await loop.start(reviewRequest({ checkpoint: 'day3' }), testCaller());
    expect(snap.status).toBe('completed');
    const firstToolReply = (llm.requests[1]?.messages ?? []).filter((m) => m.role === 'tool').at(-1);
    expect(firstToolReply?.content).toContain('review_invalid');
    const analytics = snap.analytics as Record<string, any>;
    expect(analytics.outcome).toBe('report');
    expect(analytics.metrics).toEqual([]);
    expect(analytics.review.checkpoint).toMatchObject({ actual: null, status: 'unknown' });
  });

  it('normal runs never see reviewer verbs, and a call to one is refused', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('analytics.review_campaign', { ...note, decision: 'keep' }),
      testTurn({ message: { role: 'assistant', content: 'ok' } }),
    ]);
    const { loop } = coordinator(llm, fakeAnalyticsPacket());
    const snap = await loop.start(testRunRequest(), testCaller());
    expect(snap.status).toBe('completed');
    expect((llm.requests[0]?.tools ?? []).map((t) => t.name)).not.toContain('analytics.review_campaign');
    const reply = (llm.requests[1]?.messages ?? []).filter((m) => m.role === 'tool').at(-1);
    expect(reply?.content).toContain('only available in a Hub campaign review');
  });
});
