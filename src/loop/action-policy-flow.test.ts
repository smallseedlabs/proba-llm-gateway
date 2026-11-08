import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoopCoordinator } from './coordinator.js';
import { CatalogPolicyEngine } from '../limbs/policy.js';
import { DomainLimbExecutor } from '../limbs/dispatcher.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { SystemClock } from '../adapters/system-clock.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { testConfig } from '../testing/config.js';
import { RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { testCaller, testRunRequest, testToolTurn, testTurn } from '../testing/fixtures.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { UnconfiguredResearchProvider } from '../research/unconfigured.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from '../action-policy/memory-store.js';
import { FileActionOutcomeStore, FileActionPolicyStore } from '../action-policy/file-store.js';
import { fakeActionPolicy, FAKE_POLICY_CAMPAIGN } from '../testing/action-policy.js';
import { fakeAnalyticsPacket } from '../testing/analytics.js';
import { UnconfiguredAdsDomain } from '../domains/ads/unconfigured.js';

function loop(input: {
  llm?: ScriptedLlmClient;
  ads?: RecordingAdsDomain | UnconfiguredAdsDomain;
  actionPolicyStore?: MemoryActionPolicyStore | FileActionPolicyStore;
  actionOutcomeStore?: MemoryActionOutcomeStore | FileActionOutcomeStore;
  context?: ScriptedContextPort;
}) {
  const ads = input.ads ?? new RecordingAdsDomain();
  if (ads instanceof RecordingAdsDomain) {
    ads.mappingReady = true;
    ads.campaignRunning = true;
  }
  const clock = new SystemClock();
  const researchStore = new MemoryResearchStore('test');
  const actionPolicyStore = input.actionPolicyStore ?? new MemoryActionPolicyStore('test');
  const actionOutcomeStore = input.actionOutcomeStore ?? new MemoryActionOutcomeStore('test');
  const llm = input.llm ?? new ScriptedLlmClient([testTurn()]);
  return {
    ads,
    llm,
    actionPolicyStore,
    actionOutcomeStore,
    coordinator: new LoopCoordinator({
      config: testConfig({ actionPolicy: { ...testConfig().actionPolicy, cooldownMs: 60_000 } }),
      clock,
      audit: new MemoryAuditPublisher(),
      runs: new MemoryRunStore('test'),
      llm,
      context: input.context ?? new ScriptedContextPort(),
      policy: new CatalogPolicyEngine(),
      approval: new FailClosedApprovalGate(),
      tools: new DomainLimbExecutor(ads, { provider: new UnconfiguredResearchProvider(), store: researchStore, clock }),
      ads,
      researchStore,
      analyticsStore: new MemoryAnalyticsStore('test'),
      actionPolicyStore,
      actionOutcomeStore,
    }),
  };
}

function pauseReq() {
  return testRunRequest({
    command: {
      kind: 'command',
      clientMsgId: '19191919-1919-4191-8191-191919191919',
      type: 'send_message',
      payload: { text: 'pause', platform: 'reddit', probaCampaignId: FAKE_POLICY_CAMPAIGN },
      sentAt: new Date().toISOString(),
    },
  });
}

describe('owner action policy execution boundaries', () => {
  it('defaults pause to Hub approval when no owner policy is published', async () => {
    const ads = new RecordingAdsDomain();
    const { coordinator } = loop({
      llm: new ScriptedLlmClient([testToolTurn('ads.pause_campaign', { probaCampaignId: FAKE_POLICY_CAMPAIGN })]),
      ads,
    });
    const snapshot = await coordinator.start(pauseReq(), testCaller());
    expect(snapshot.status).toBe('awaiting_approval');
    expect(ads.calls).toHaveLength(0);
  });

  it('auto-with-limits pause skips Hub approval, uses Ads port, and never grants spend', async () => {
    const policies = new MemoryActionPolicyStore('test');
    await policies.put(fakeActionPolicy());
    const ads = new RecordingAdsDomain();
    const { coordinator } = loop({
      llm: new ScriptedLlmClient([
        testToolTurn('ads.pause_campaign', { probaCampaignId: FAKE_POLICY_CAMPAIGN }),
        testTurn({ message: { role: 'assistant', content: 'paused' } }),
      ]),
      ads,
      actionPolicyStore: policies,
    });
    const snapshot = await coordinator.start(pauseReq(), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(snapshot.needs).toBeUndefined();
    expect(ads.calls).toHaveLength(1);
    expect(ads.calls[0]?.verb).toBe('ads.pause_campaign');
  });

  it('auto-with-limits cap decrease uses Ads port and still does not grant spend', async () => {
    const policies = new MemoryActionPolicyStore('test');
    await policies.put(fakeActionPolicy({ policyId: 'policy-cap-auto', verb: 'ads.update_campaign' }));
    const ads = new RecordingAdsDomain();
    const { coordinator } = loop({
      llm: new ScriptedLlmClient([
        testToolTurn('ads.update_campaign', { probaCampaignId: FAKE_POLICY_CAMPAIGN, dailyBudget: 8 }),
        testTurn({ message: { role: 'assistant', content: 'capped' } }),
      ]),
      ads,
      actionPolicyStore: policies,
    });
    const snapshot = await coordinator.start(
      testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: '19191919-1919-4191-8191-191919191920',
          type: 'send_message',
          payload: {
            text: 'cap down',
            platform: 'reddit',
            probaCampaignId: FAKE_POLICY_CAMPAIGN,
            currentDailyBudget: 10,
          },
          sentAt: new Date().toISOString(),
        },
      }),
      testCaller()
    );
    expect(snapshot.status).toBe('completed');
    expect(snapshot.needs).toBeUndefined();
    expect(ads.calls).toHaveLength(1);
    expect(ads.calls[0]?.verb).toBe('ads.update_campaign');
    expect(ads.calls[0]?.args.dailyBudget).toBe(8);
  });

  it('unconfigured Ads still fail closed under auto-with-limits (no fabricated POST)', async () => {
    const policies = new MemoryActionPolicyStore('test');
    await policies.put(fakeActionPolicy());
    const { coordinator } = loop({
      llm: new ScriptedLlmClient([testToolTurn('ads.pause_campaign', { probaCampaignId: FAKE_POLICY_CAMPAIGN })]),
      ads: new UnconfiguredAdsDomain(),
      actionPolicyStore: policies,
    });
    const snapshot = await coordinator.start(pauseReq(), testCaller());
    expect(snapshot.status).toBe('blocked');
  });

  it('review_performance dry-run is not authority even with auto pause policy', async () => {
    const policies = new MemoryActionPolicyStore('test');
    await policies.put(fakeActionPolicy());
    const ads = new RecordingAdsDomain();
    const { coordinator, llm } = loop({
      ads,
      actionPolicyStore: policies,
      context: new ScriptedContextPort(fakeAnalyticsPacket()),
      llm: new ScriptedLlmClient([testTurn()]),
    });
    const snapshot = await coordinator.start(
      testRunRequest({
        stepType: 'review_performance',
        command: {
          kind: 'command',
          clientMsgId: '20202020-2020-4202-8202-202020202020',
          type: 'send_message',
          payload: {
            text: 'review',
            reviewIntent: 'propose_pause',
            platform: 'reddit',
            probaCampaignId: FAKE_POLICY_CAMPAIGN,
            accountId: 'acct-1',
          },
          sentAt: new Date().toISOString(),
        },
      }),
      testCaller()
    );
    expect(snapshot.status).toBe('completed');
    expect(llm.completeCalls).toBe(0);
    expect(ads.calls).toHaveLength(0);
  });

  it('survives FileActionPolicyStore / outcome store restart cooldown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-action-policy-'));
    try {
      const policies = new FileActionPolicyStore(dir);
      const outcomes = new FileActionOutcomeStore(dir);
      await policies.put(fakeActionPolicy({ limits: { cooldownMs: 60_000 } }));
      const first = loop({
        llm: new ScriptedLlmClient([
          testToolTurn('ads.pause_campaign', { probaCampaignId: FAKE_POLICY_CAMPAIGN }),
          testTurn({ message: { role: 'assistant', content: 'paused' } }),
        ]),
        actionPolicyStore: policies,
        actionOutcomeStore: outcomes,
      });
      const done = await first.coordinator.start(
        { ...pauseReq(), idempotencyKey: '21212121-2121-4212-8212-212121212121' },
        testCaller()
      );
      expect(done.status).toBe('completed');
      const restartedPolicies = new FileActionPolicyStore(dir);
      const restartedOutcomes = new FileActionOutcomeStore(dir);
      const second = loop({
        llm: new ScriptedLlmClient([testToolTurn('ads.pause_campaign', { probaCampaignId: FAKE_POLICY_CAMPAIGN })]),
        actionPolicyStore: restartedPolicies,
        actionOutcomeStore: restartedOutcomes,
      });
      const again = await second.coordinator.start(
        { ...pauseReq(), idempotencyKey: '22222222-2222-4222-8222-222222222222' },
        testCaller()
      );
      expect(again.status).toBe('failed');
      expect(again.error?.message).toMatch(/cooldown/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
