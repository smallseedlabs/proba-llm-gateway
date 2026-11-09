/**
 * Approved analytics action: evaluator dry-run proposal -> explicit Hub owner
 * decision -> Ads domain port. FAKE Context + TEST STUB Ads; no live provider.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LoopCoordinator } from './coordinator.js';
import { CatalogPolicyEngine } from '../limbs/policy.js';
import { DomainLimbExecutor } from '../limbs/dispatcher.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { testConfig } from '../testing/config.js';
import { AdjustableClock, RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { testCaller, testRunRequest, testTurn, TEST_USER_ID } from '../testing/fixtures.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { UnconfiguredResearchProvider } from '../research/unconfigured.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from '../action-policy/memory-store.js';
import { fakeAnalyticsPacket, FAKE_ACCOUNT, FAKE_PROBA_CAMPAIGN } from '../testing/analytics.js';
import { fakeActionPolicy } from '../testing/action-policy.js';
import type { HubRunRequest } from '../types/run.js';

function harness() {
  const ads = new RecordingAdsDomain();
  const clock = new AdjustableClock();
  const audit = new MemoryAuditPublisher();
  const analyticsStore = new MemoryAnalyticsStore('test');
  const actionPolicyStore = new MemoryActionPolicyStore('test');
  const actionOutcomeStore = new MemoryActionOutcomeStore('test');
  const llm = new ScriptedLlmClient([testTurn()]);
  const researchStore = new MemoryResearchStore('test');
  const coordinator = new LoopCoordinator({
    config: testConfig({ analytics: { ...testConfig().analytics, cooldownMs: 60_000 } }),
    clock,
    audit,
    runs: new MemoryRunStore('test'),
    llm,
    context: new ScriptedContextPort(fakeAnalyticsPacket()),
    policy: new CatalogPolicyEngine(),
    approval: new FailClosedApprovalGate(),
    tools: new DomainLimbExecutor(ads, { provider: new UnconfiguredResearchProvider(), store: researchStore, clock }),
    ads,
    researchStore,
    analyticsStore,
    actionPolicyStore,
    actionOutcomeStore,
  });
  return { ads, clock, audit, llm, coordinator, actionPolicyStore, actionOutcomeStore };
}

function reviewReq(payload: Record<string, unknown>): HubRunRequest {
  return testRunRequest({
    idempotencyKey: randomUUID(),
    stepType: 'review_performance',
    command: {
      kind: 'command',
      clientMsgId: randomUUID(),
      type: 'send_message',
      payload: { text: 'review', probaCampaignId: FAKE_PROBA_CAMPAIGN, platform: 'reddit', accountId: FAKE_ACCOUNT, ...payload },
      sentAt: new Date().toISOString(),
    },
  });
}

function actionReq(
  proposal: { decisionId: string; verb: string; args: Record<string, unknown>; argsHash: string },
  opts: { choice?: 'approve' | 'reject'; resume?: boolean; overrides?: Record<string, unknown>; userId?: string } = {}
): HubRunRequest {
  const proposalId = randomUUID();
  return testRunRequest({
    idempotencyKey: randomUUID(),
    stepType: 'handle_approval',
    ...(opts.userId ? { userId: opts.userId } : {}),
    command: {
      kind: 'command',
      clientMsgId: randomUUID(),
      type: 'send_message',
      payload: {
        text: 'approved analytics action',
        analyticsAction: {
          proposalId,
          decisionId: proposal.decisionId,
          verb: proposal.verb,
          args: proposal.args,
          argsHash: proposal.argsHash,
          probaCampaignId: FAKE_PROBA_CAMPAIGN,
          platform: 'reddit',
          accountId: FAKE_ACCOUNT,
          ...opts.overrides,
        },
      },
      sentAt: new Date().toISOString(),
    },
    ...(opts.resume === false ? {} : { resume: { askId: proposalId, choice: opts.choice ?? 'approve' } }),
  });
}

async function proposePause(h: ReturnType<typeof harness>) {
  const snap = await h.coordinator.start(reviewReq({ reviewIntent: 'propose_pause' }), testCaller());
  expect(snap.status).toBe('completed');
  const analytics = snap.analytics as {
    decisionId: string;
    outcome: string;
    grantsSpend: boolean;
    proposal: { verb: string; args: Record<string, unknown>; argsHash: string };
    metrics: unknown[];
  };
  expect(analytics.outcome).toBe('dry_run_proposal');
  expect(analytics.grantsSpend).toBe(false);
  expect(analytics.metrics.length).toBeGreaterThan(0);
  expect(h.ads.calls).toHaveLength(0);
  return { decisionId: analytics.decisionId, ...analytics.proposal };
}

describe('approved analytics action', () => {
  it('executes exactly the approved pause proposal through Ads with zero LLM calls and audits it', async () => {
    const h = harness();
    const proposal = await proposePause(h);
    const snap = await h.coordinator.start(actionReq(proposal), testCaller());
    expect(snap.status).toBe('completed');
    expect(h.llm.completeCalls).toBe(0);
    expect(h.ads.calls).toHaveLength(1);
    expect(h.ads.calls[0]).toMatchObject({ verb: 'ads.pause_campaign', args: { probaCampaignId: FAKE_PROBA_CAMPAIGN } });
    expect(snap.actionOutcome).toMatchObject({ ok: true, verb: 'ads.pause_campaign', grantsSpend: false });
    expect(h.audit.events.some((e) => e.action === 'tool.executed' && e.details?.evaluator === 'approved_action')).toBe(true);
    expect(h.audit.events.some((e) => e.details?.grantsSpend === true)).toBe(false);
  });

  it('requires an explicit resume bound to the proposal; absence is not approval', async () => {
    const h = harness();
    const proposal = await proposePause(h);
    const snap = await h.coordinator.start(actionReq(proposal, { resume: false }), testCaller());
    expect(snap.status).toBe('blocked');
    expect(snap.error?.code).toBe('approval_required');
    expect(h.ads.calls).toHaveLength(0);
  });

  it('records a rejection without calling Ads', async () => {
    const h = harness();
    const proposal = await proposePause(h);
    const snap = await h.coordinator.start(actionReq(proposal, { choice: 'reject' }), testCaller());
    expect(snap.status).toBe('completed');
    expect(h.ads.calls).toHaveLength(0);
    expect(h.audit.events.some((e) => e.action === 'approval.rejected')).toBe(true);
  });

  it('refuses tampered args, other campaigns, other users, other providers and expired proposals', async () => {
    const h = harness();
    const proposal = await proposePause(h);
    const tampered = await h.coordinator.start(
      actionReq({ ...proposal, args: { probaCampaignId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' } }),
      testCaller()
    );
    expect(tampered.error?.code).toBe('args_mismatch');
    const otherUser = await h.coordinator.start(
      actionReq(proposal, { userId: '22222222-2222-4222-8222-222222222222' }),
      testCaller({ userId: '22222222-2222-4222-8222-222222222222' } as never)
    );
    expect(['proposal_unknown', 'scope_actor']).toContain(otherUser.error?.code ?? 'proposal_unknown');
    const otherProvider = await h.coordinator.start(actionReq(proposal, { overrides: { platform: 'microsoft' } }), testCaller());
    expect(otherProvider.error?.code).toBe('scope_provider');
    const otherAccount = await h.coordinator.start(actionReq(proposal, { overrides: { accountId: 'acct-other' } }), testCaller());
    expect(otherAccount.error?.code).toBe('scope_provider');
    const moveBudget = await h.coordinator.start(
      actionReq({ ...proposal, verb: 'ads.move_budget' }),
      testCaller()
    );
    expect(moveBudget.error?.code).toBe('verb_not_allowed');
    h.clock.advance(61_000);
    const expired = await h.coordinator.start(actionReq(proposal), testCaller());
    expect(expired.error?.code).toBe('proposal_expired');
    expect(h.ads.calls).toHaveLength(0);
  });

  it('owner deny policy still wins over an approved proposal', async () => {
    const h = harness();
    await h.actionPolicyStore.put(fakeActionPolicy({ policyId: 'deny-pause', mode: 'deny', ownerUserId: TEST_USER_ID }));
    const proposal = await proposePause(h);
    const snap = await h.coordinator.start(actionReq(proposal), testCaller());
    expect(snap.status).toBe('blocked');
    expect(h.ads.calls).toHaveLength(0);
  });

  it('executes an approved cap decrease with Ads-shaped args (currency stays evidence)', async () => {
    const h = harness();
    const snap = await h.coordinator.start(
      reviewReq({ reviewIntent: 'propose_cap', dailyBudget: 6, currentDailyBudget: 10, currency: 'USD' }),
      testCaller()
    );
    const analytics = snap.analytics as { decisionId: string; proposal: { verb: string; args: Record<string, unknown>; argsHash: string } };
    expect(analytics.proposal.verb).toBe('ads.update_campaign');
    const done = await h.coordinator.start(actionReq({ decisionId: analytics.decisionId, ...analytics.proposal }), testCaller());
    expect(done.status).toBe('completed');
    expect(h.ads.calls[0]?.args).toEqual({ probaCampaignId: FAKE_PROBA_CAMPAIGN, dailyBudget: 6 });
  });

  it('does not re-execute when the same Hub idempotency key is replayed', async () => {
    const h = harness();
    const proposal = await proposePause(h);
    const req = actionReq(proposal);
    await h.coordinator.start(req, testCaller());
    await h.coordinator.start(req, testCaller());
    expect(h.ads.calls).toHaveLength(1);
  });
});
