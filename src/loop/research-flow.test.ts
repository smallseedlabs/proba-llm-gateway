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
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from '../action-policy/memory-store.js';
import { FileResearchStore } from '../research/file-store.js';
import { UnconfiguredResearchProvider } from '../research/unconfigured.js';
import {
  seedAcceptedResearch,
  SourcedResearchProvider,
  TEST_LANDING_URL,
  testBinding,
  userLanding,
} from '../testing/research.js';
import { inputRevisionForUrl } from '../research/input.js';
import { TEST_GOAL_ID, TEST_THREAD_ID, TEST_USER_ID } from '../testing/fixtures.js';

const createArgs = {
  name: 'Spring',
  landingPageUrl: TEST_LANDING_URL,
  dailyBudget: 10,
  currency: 'USD',
  platform: 'reddit',
};

function landingReq(overrides: Parameters<typeof testRunRequest>[0] = {}) {
  return testRunRequest({ userSuppliedInput: userLanding(), ...overrides });
}

function loop(input: {
  llm: ScriptedLlmClient;
  ads?: RecordingAdsDomain;
  research?: SourcedResearchProvider | UnconfiguredResearchProvider;
  researchStore?: MemoryResearchStore | FileResearchStore;
}) {
  const ads = input.ads ?? new RecordingAdsDomain();
  const researchStore = input.researchStore ?? new MemoryResearchStore('test');
  const research = input.research ?? new SourcedResearchProvider();
  const clock = new SystemClock();
  const runs = new MemoryRunStore('test');
  return {
    ads,
    research,
    researchStore,
    runs,
    coordinator: new LoopCoordinator({
      config: testConfig(),
      clock,
      audit: new MemoryAuditPublisher(),
      runs,
      llm: input.llm,
      context: new ScriptedContextPort(),
      policy: new CatalogPolicyEngine(),
      approval: new FailClosedApprovalGate(),
      tools: new DomainLimbExecutor(ads, { provider: research, store: researchStore, clock }),
      ads,
      researchStore,
      analyticsStore: new MemoryAnalyticsStore('test'),
      actionPolicyStore: new MemoryActionPolicyStore('test'),
      actionOutcomeStore: new MemoryActionOutcomeStore('test'),
    }),
  };
}

describe('research review artifact', () => {
  it('gathers sourced findings, pauses for acceptance, then allows create with the user URL', async () => {
    const research = new SourcedResearchProvider();
    const llm = new ScriptedLlmClient([
      testToolTurn('research.gather', { url: TEST_LANDING_URL }),
      testToolTurn('ads.create_campaign', createArgs, 'call-2'),
      testTurn({ message: { role: 'assistant', content: 'created' } }),
    ]);
    const ads = new RecordingAdsDomain();
    const { coordinator, researchStore, runs } = loop({ llm, ads, research });
    const key = 'aaaaaaaa-aaaa-4aaa-8a01-aaaaaaaaaaaa';
    const first = await coordinator.start(landingReq({ idempotencyKey: key }), testCaller());
    expect(first.status).toBe('awaiting_approval');
    expect((first.needs?.[0] as { verb?: string }).verb).toBe('research.accept');
    expect(ads.calls).toHaveLength(0);
    expect(research.calls).toBe(1);
    const gathered = await runs.getByRunId(first.runId);
    const gatherTurn = gathered?.toolTurns.find((t) => t.verbName === 'research.gather');
    expect(gatherTurn?.state).toBe('completed');
    expect(gatherTurn?.result).toMatchObject({ ok: true });
    const stored = await researchStore.get(testBinding(), inputRevisionForUrl(TEST_LANDING_URL));
    expect(stored?.status).toBe('awaiting_acceptance');
    expect(stored?.findings[0]?.sourceIds.length).toBeGreaterThan(0);

    const askId = (first.needs?.[0] as { askId: string }).askId;
    const afterAccept = await coordinator.start(
      landingReq({ idempotencyKey: key, resume: { askId, choice: 'approve' } }),
      testCaller()
    );
    expect(afterAccept.status).toBe('awaiting_approval');
    expect((afterAccept.needs?.[0] as { verb?: string }).verb).toBe('ads.create_campaign');
    expect(ads.calls).toHaveLength(0);
    const accepted = await researchStore.get(testBinding(), inputRevisionForUrl(TEST_LANDING_URL));
    expect(accepted?.status).toBe('accepted');

    const createAsk = (afterAccept.needs?.[0] as { askId: string }).askId;
    const done = await coordinator.start(
      landingReq({ idempotencyKey: key, resume: { askId: createAsk, choice: 'approve' } }),
      testCaller()
    );
    expect(done.status).toBe('completed');
    expect(ads.calls).toHaveLength(1);
    expect(ads.calls[0]?.args.landingPageUrl).toBe(TEST_LANDING_URL);
    // Operator-approved creative is forwarded for Ads post creation; research
    // binding + gateway attestation are forwarded for Ads verification.
    expect(ads.calls[0]?.args.creative).toMatchObject({ type: 'TEXT', headline: 'FAKE fixture headline' });
    expect(ads.calls[0]?.args.researchAcceptance).toEqual({
      artifactId: accepted!.artifactId,
      version: accepted!.version,
      inputRevision: accepted!.inputRevision,
    });
    expect(ads.calls[0]?.args.researchAttestation).toMatchObject({
      status: 'accepted',
      landingPageUrl: TEST_LANDING_URL,
      acceptedAt: accepted!.acceptedAt,
    });
  });

  it('refuses model-invented landing URLs and does not call Ads', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('ads.create_campaign', { ...createArgs, landingPageUrl: 'https://evil.example/phish' }),
    ]);
    const ads = new RecordingAdsDomain();
    const { coordinator } = loop({ llm, ads });
    const snapshot = await coordinator.start(landingReq(), testCaller());
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('policy_denied');
    expect(ads.calls).toHaveLength(0);
  });

  it('refuses create without userSuppliedInput even if the model copied a URL', async () => {
    const llm = new ScriptedLlmClient([testToolTurn('ads.create_campaign', createArgs)]);
    const ads = new RecordingAdsDomain();
    const { coordinator } = loop({ llm, ads });
    const snapshot = await coordinator.start(testRunRequest(), testCaller());
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.message).toMatch(/userSuppliedInput/);
    expect(ads.calls).toHaveLength(0);
  });

  it('does not treat Context or an unconfigured provider as sourced research', async () => {
    const research = new UnconfiguredResearchProvider();
    const llm = new ScriptedLlmClient([
      testToolTurn('research.gather', { url: TEST_LANDING_URL }),
      testTurn({ message: { role: 'assistant', content: 'research unavailable' } }),
    ]);
    const { coordinator, researchStore } = loop({ llm, research });
    const snapshot = await coordinator.start(landingReq(), testCaller());
    expect(snapshot.status).toBe('completed');
    const stored = await researchStore.get(testBinding(), inputRevisionForUrl(TEST_LANDING_URL));
    expect(stored?.status).toBe('failed');
    expect(stored?.sources).toEqual([]);
    expect(stored?.errorCode).toBe('research_unconfigured');
  });

  it('invalidates acceptance on edit and blocks create until a new gather is accepted', async () => {
    const research = new SourcedResearchProvider();
    const llm = new ScriptedLlmClient([
      testToolTurn('research.gather', { url: TEST_LANDING_URL }),
      testTurn({ message: { role: 'assistant', content: 'will revise' } }),
    ]);
    const { coordinator, researchStore } = loop({ llm, research });
    const key = 'bbbbbbbb-bbbb-4bbb-8b01-bbbbbbbbbbbb';
    const first = await coordinator.start(landingReq({ idempotencyKey: key }), testCaller());
    const askId = (first.needs?.[0] as { askId: string }).askId;
    await coordinator.start(landingReq({ idempotencyKey: key, resume: { askId, choice: 'edit' } }), testCaller());
    const stored = await researchStore.get(testBinding(), inputRevisionForUrl(TEST_LANDING_URL));
    expect(stored?.status).toBe('invalidated');

    const createLlm = new ScriptedLlmClient([testToolTurn('ads.create_campaign', createArgs)]);
    const ads = new RecordingAdsDomain();
    const createLoop = loop({ llm: createLlm, ads, researchStore });
    const paused = await createLoop.coordinator.start(landingReq({ idempotencyKey: 'cccccccc-cccc-4ccc-8c01-cccccccccccc' }), testCaller());
    const createAsk = (paused.needs?.[0] as { askId: string }).askId;
    const blocked = await createLoop.coordinator.start(
      landingReq({
        idempotencyKey: 'cccccccc-cccc-4ccc-8c01-cccccccccccc',
        resume: { askId: createAsk, choice: 'approve' },
      }),
      testCaller()
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.needs?.some((n) => (n as { capability?: string }).capability === 'research.accepted')).toBe(true);
    expect(ads.calls).toHaveLength(0);
  });

  it('isolates artifacts by workspace/user/goal/thread', async () => {
    const store = new MemoryResearchStore('test');
    await seedAcceptedResearch(store, TEST_LANDING_URL, testBinding());
    const llm = new ScriptedLlmClient([testToolTurn('ads.create_campaign', createArgs), testTurn()]);
    const ads = new RecordingAdsDomain();
    const other = loop({ llm, ads, researchStore: store });
    const req = landingReq({
      workspaceId: 'other-ws',
      userId: TEST_USER_ID,
      goalId: TEST_GOAL_ID,
      threadId: TEST_THREAD_ID,
      idempotencyKey: 'dddddddd-dddd-4ddd-8d01-dddddddddddd',
    });
    const first = await other.coordinator.start(req, testCaller({ workspaceId: 'other-ws' }));
    const askId = (first.needs?.[0] as { askId: string }).askId;
    const done = await other.coordinator.start(
      { ...req, resume: { askId, choice: 'approve' } },
      testCaller({ workspaceId: 'other-ws' })
    );
    expect(done.status).toBe('blocked');
    expect(ads.calls).toHaveLength(0);
  });

  it('replays a completed gather without a second provider call', async () => {
    const research = new SourcedResearchProvider();
    const llm = new ScriptedLlmClient([
      testToolTurn('research.gather', { url: TEST_LANDING_URL }),
      testTurn({ message: { role: 'assistant', content: 'waiting' } }),
    ]);
    const wired = loop({ llm, research });
    const key = 'eeeeeeee-eeee-4eee-8e01-eeeeeeeeeeee';
    const first = await wired.coordinator.start(landingReq({ idempotencyKey: key }), testCaller());
    expect(first.status).toBe('awaiting_approval');
    expect(research.calls).toBe(1);
    const again = await wired.coordinator.start(landingReq({ idempotencyKey: key }), testCaller());
    expect(again.status).toBe('awaiting_approval');
    expect(research.calls).toBe(1);
  });

  it('persists artifacts across FileResearchStore restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proba-gw-research-'));
    try {
      const first = new FileResearchStore(dir);
      await seedAcceptedResearch(first);
      await first.close();
      const restarted = new FileResearchStore(dir);
      const loaded = await restarted.get(testBinding(), inputRevisionForUrl(TEST_LANDING_URL));
      expect(loaded?.status).toBe('accepted');
      expect(loaded?.landingPageUrl).toBe(TEST_LANDING_URL);
      expect(loaded?.sources[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      await restarted.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
