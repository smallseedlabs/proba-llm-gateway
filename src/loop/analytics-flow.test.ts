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
import { AdjustableClock, RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { testCaller, testRunRequest, testTurn } from '../testing/fixtures.js';
import type { BrainOutput } from '../protocol.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { UnconfiguredResearchProvider } from '../research/unconfigured.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { FileAnalyticsStore } from '../analytics/file-store.js';
import { fakeAnalyticsPacket, FAKE_ACCOUNT, FAKE_PROBA_CAMPAIGN } from '../testing/analytics.js';

function loop(input: {
  context: ScriptedContextPort;
  llm?: ScriptedLlmClient;
  ads?: RecordingAdsDomain;
  analyticsStore?: MemoryAnalyticsStore | FileAnalyticsStore;
  clock?: AdjustableClock | SystemClock;
  cooldownMs?: number;
}) {
  const ads = input.ads ?? new RecordingAdsDomain();
  const clock = input.clock ?? new SystemClock();
  const researchStore = new MemoryResearchStore('test');
  const analyticsStore = input.analyticsStore ?? new MemoryAnalyticsStore('test');
  const llm = input.llm ?? new ScriptedLlmClient([testTurn()]);
  const audit = new MemoryAuditPublisher();
  return {
    ads,
    llm,
    audit,
    analyticsStore,
    coordinator: new LoopCoordinator({
      config: testConfig({
        analytics: {
          ...testConfig().analytics,
          cooldownMs: input.cooldownMs ?? 60_000,
        },
      }),
      clock,
      audit,
      runs: new MemoryRunStore('test'),
      llm,
      context: input.context,
      policy: new CatalogPolicyEngine(),
      approval: new FailClosedApprovalGate(),
      tools: new DomainLimbExecutor(ads, { provider: new UnconfiguredResearchProvider(), store: researchStore, clock }),
      ads,
      researchStore,
      analyticsStore,
    }),
  };
}

function replyTexts(outputs: unknown[] | undefined): string[] {
  return (outputs ?? []).flatMap((row) => {
    const output = row as BrainOutput;
    return output.type === 'reply' ? [output.text] : [];
  });
}

function reviewReq(overrides: Record<string, unknown> = {}) {
  return testRunRequest({
    stepType: 'review_performance',
    command: {
      kind: 'command',
      clientMsgId: '12121212-1212-4121-8121-121212121212',
      type: 'send_message',
      payload: {
        text: 'review',
        probaCampaignId: FAKE_PROBA_CAMPAIGN,
        platform: 'reddit',
        accountId: FAKE_ACCOUNT,
        ...overrides,
      },
      sentAt: new Date().toISOString(),
    },
  });
}

describe('analytics evaluator review_performance flow', () => {
  it('completes a report from FAKE Context with zero LLM and zero Ads POSTs', async () => {
    const context = new ScriptedContextPort(fakeAnalyticsPacket());
    const { coordinator, llm, ads, audit } = loop({ context });
    const snapshot = await coordinator.start(reviewReq(), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(llm.completeCalls).toBe(0);
    expect(ads.calls).toHaveLength(0);
    expect(audit.events.some((e) => e.action === 'brain.decision_made' && e.details?.outcome === 'report')).toBe(true);
    expect(audit.events.some((e) => e.details?.grantsSpend === true)).toBe(false);
  });

  it('emits a dry-run pause proposal without executing it', async () => {
    const context = new ScriptedContextPort(fakeAnalyticsPacket());
    const { coordinator, ads, audit } = loop({ context });
    const snapshot = await coordinator.start(reviewReq({ reviewIntent: 'propose_pause' }), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(ads.calls).toHaveLength(0);
    const decision = audit.events.find((e) => e.action === 'brain.decision_made');
    expect(decision?.details).toMatchObject({ outcome: 'dry_run_proposal', grantsSpend: false, dryRun: true });
  });

  it('wrong actor / other workspace is blocked', async () => {
    // ScriptedContextPort overwrites packet.workspaceId with the Hub run; userId is preserved.
    const context = new ScriptedContextPort(
      fakeAnalyticsPacket({ userId: '22222222-2222-4222-8222-222222222222' })
    );
    const { coordinator, llm } = loop({ context });
    const snapshot = await coordinator.start(reviewReq(), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(llm.completeCalls).toBe(0);
  });

  it('replays the same idempotency key without a second decision persist', async () => {
    const context = new ScriptedContextPort(fakeAnalyticsPacket());
    const analyticsStore = new MemoryAnalyticsStore('test');
    const { coordinator } = loop({ context, analyticsStore });
    const key = '13131313-1313-4131-8131-131313131313';
    const first = await coordinator.start({ ...reviewReq(), idempotencyKey: key }, testCaller());
    const second = await coordinator.start({ ...reviewReq(), idempotencyKey: key }, testCaller());
    expect(first.runId).toBe(second.runId);
    expect(second.status).toBe('completed');
  });

  it('cooldown yields no_action on a new idempotency key', async () => {
    const context = new ScriptedContextPort(fakeAnalyticsPacket());
    const analyticsStore = new MemoryAnalyticsStore('test');
    const { coordinator } = loop({ context, analyticsStore, cooldownMs: 60_000 });
    await coordinator.start({ ...reviewReq(), idempotencyKey: '14141414-1414-4141-8141-141414141414' }, testCaller());
    const again = await coordinator.start({ ...reviewReq(), idempotencyKey: '15151515-1515-4151-8151-151515151515' }, testCaller());
    expect(again.status).toBe('completed');
    expect(replyTexts(again.outputs).some((text) => text.includes('cooldown'))).toBe(true);
  });

  it('survives FileAnalyticsStore restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-analytics-'));
    try {
      const store = new FileAnalyticsStore(dir);
      const context = new ScriptedContextPort(fakeAnalyticsPacket());
      const first = loop({ context, analyticsStore: store, cooldownMs: 60_000 });
      await first.coordinator.start({ ...reviewReq(), idempotencyKey: '16161616-1616-4161-8161-161616161616' }, testCaller());
      const restarted = new FileAnalyticsStore(dir);
      const second = loop({ context, analyticsStore: restarted, cooldownMs: 60_000 });
      const again = await second.coordinator.start(
        { ...reviewReq(), idempotencyKey: '17171717-1717-4171-8171-171717171717' },
        testCaller()
      );
      expect(replyTexts(again.outputs).some((text) => text.includes('cooldown'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
