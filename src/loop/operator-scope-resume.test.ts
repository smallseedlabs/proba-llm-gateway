import { describe, expect, it } from 'vitest';
import { LoopCoordinator } from './coordinator.js';
import { IdempotencyConflictError } from '../errors.js';
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
import { SourcedResearchProvider, seedAcceptedResearch, TEST_LANDING_URL, userLanding } from '../testing/research.js';
import type { LlmClient } from '../ports/llm-client.js';

function coordinator(llm: LlmClient) {
  const ads = new RecordingAdsDomain();
  const audit = new MemoryAuditPublisher();
  const runs = new MemoryRunStore('test');
  const researchStore = new MemoryResearchStore('test');
  const clock = new SystemClock();
  const loop = new LoopCoordinator({
    config: testConfig(),
    clock,
    audit,
    runs,
    llm,
    context: new ScriptedContextPort(),
    policy: new CatalogPolicyEngine(),
    approval: new FailClosedApprovalGate(),
    tools: new DomainLimbExecutor(ads, { provider: new SourcedResearchProvider(), store: researchStore, clock }),
    ads,
    researchStore,
    analyticsStore: new MemoryAnalyticsStore('test'),
    actionPolicyStore: new MemoryActionPolicyStore('test'),
    actionOutcomeStore: new MemoryActionOutcomeStore('test'),
  });
  return { loop, ads, audit, runs, researchStore };
}

const createArgs = {
  name: 'Spring',
  landingPageUrl: TEST_LANDING_URL,
  dailyBudget: 2,
  currency: 'GBP',
  platform: 'reddit',
};

const urlOnly = { landingPageUrl: TEST_LANDING_URL };

describe('operator creative saved after the run was created', () => {
  it('reaches ads.create_campaign on approval resume and stops at its own approval card', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('page.attach_user_page', { url: TEST_LANDING_URL }),
      testToolTurn('ads.create_campaign', createArgs),
      testTurn({ message: { role: 'assistant', content: 'created' } }),
    ]);
    const { loop, ads, audit, researchStore } = coordinator(llm);
    await seedAcceptedResearch(researchStore);
    const idempotencyKey = '51515151-5151-4515-8515-515151515151';
    const first = await loop.start(testRunRequest({ idempotencyKey, userSuppliedInput: urlOnly }), testCaller());
    expect(first.status).toBe('awaiting_approval');
    const attachAsk = first.needs?.[0] as { askId: string; verb: string };
    expect(attachAsk.verb).toBe('page.attach_user_page');

    // Operator saved post copy in Campaigns; Hub resends the stored request plus the goal's creative.
    const resumed = await loop.start(
      testRunRequest({
        idempotencyKey,
        userSuppliedInput: userLanding(),
        resume: { askId: attachAsk.askId, choice: 'approve' },
      }),
      testCaller()
    );
    expect(audit.events.some((e) => e.action === 'command.rejected')).toBe(false);
    expect(resumed.status).toBe('awaiting_approval');
    const createNeed = resumed.needs?.[0] as { verb: string; askId: string };
    expect(createNeed.verb).toBe('ads.create_campaign');
    expect(createNeed.askId).not.toBe(attachAsk.askId);
    const card = (resumed.outputs as Array<{ type?: string; parameters?: Record<string, unknown> }> | undefined)?.find(
      (o) => o.type === 'tool_call'
    );
    expect(card?.parameters?.creative).toEqual(userLanding().creative);
    expect(ads.calls.some((c) => c.verb === 'ads.create_campaign')).toBe(false);
  });

  it('still refuses a resume that changes the landing URL (the research input revision)', async () => {
    const llm = new ScriptedLlmClient([testToolTurn('page.attach_user_page', { url: TEST_LANDING_URL })]);
    const { loop, researchStore } = coordinator(llm);
    await seedAcceptedResearch(researchStore);
    const idempotencyKey = '52525252-5252-4525-8525-525252525252';
    const first = await loop.start(testRunRequest({ idempotencyKey, userSuppliedInput: urlOnly }), testCaller());
    const askId = (first.needs?.[0] as { askId: string }).askId;
    await expect(
      loop.start(
        testRunRequest({
          idempotencyKey,
          userSuppliedInput: { ...userLanding('https://example.com/other') },
          resume: { askId, choice: 'approve' },
        }),
        testCaller()
      )
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('still refuses changed creative on the same key without a resume', async () => {
    const llm = new ScriptedLlmClient([testToolTurn('page.attach_user_page', { url: TEST_LANDING_URL })]);
    const { loop, researchStore } = coordinator(llm);
    await seedAcceptedResearch(researchStore);
    const idempotencyKey = '53535353-5353-4535-8535-535353535353';
    await loop.start(testRunRequest({ idempotencyKey, userSuppliedInput: urlOnly }), testCaller());
    await expect(
      loop.start(testRunRequest({ idempotencyKey, userSuppliedInput: userLanding() }), testCaller())
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe('ads.create_campaign without operator creative', () => {
  it('is refused with an actionable reason and the run finishes instead of failing', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('ads.create_campaign', createArgs),
      testTurn({ message: { role: 'assistant', content: 'Save the post copy in Campaigns, then approve again.' } }),
    ]);
    const { loop, ads, researchStore, runs } = coordinator(llm);
    await seedAcceptedResearch(researchStore);
    const snapshot = await loop.start(testRunRequest({ userSuppliedInput: urlOnly }), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(ads.calls).toHaveLength(0);
    const stored = await runs.getByRunId(snapshot.runId);
    const toolMessage = stored?.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(String(toolMessage?.content))).toMatchObject({
      ok: false,
      code: 'creative_missing',
      message: expect.stringContaining('Save the Reddit post copy for this goal in Campaigns, then approve again'),
    });
  });
});
