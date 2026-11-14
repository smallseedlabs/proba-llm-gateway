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
import { SourcedResearchProvider, seedAcceptedResearch, TEST_LANDING_URL } from '../testing/research.js';
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

const createArgs = { name: 'Trail boots', landingPageUrl: TEST_LANDING_URL, dailyBudget: 2, currency: 'USD', platform: 'reddit' };
const urlOnly = { landingPageUrl: TEST_LANDING_URL };
const draft = {
  headline: 'Waterproof boots for muddy UK trails',
  body: 'Light, grippy and dry on wet ground. Have a look before your next walk.',
  rationale: 'Plain, practical angle for r/UKhiking readers.',
};

describe('creative.draft_post: the brain drafts, the operator approves, Hub saves', () => {
  it('shows the draft as an approval card bound to the operator URL; approval continues to the create card', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('creative.draft_post', draft),
      testToolTurn('ads.create_campaign', createArgs),
      testTurn({ message: { role: 'assistant', content: 'waiting on the create card' } }),
    ]);
    const { loop, ads, researchStore } = coordinator(llm);
    await seedAcceptedResearch(researchStore);
    const idempotencyKey = '61616161-6161-4616-8616-616161616161';
    const first = await loop.start(testRunRequest({ idempotencyKey, userSuppliedInput: urlOnly }), testCaller());
    expect(first.status).toBe('awaiting_approval');
    const need = first.needs?.[0] as { askId: string; verb: string };
    expect(need.verb).toBe('creative.draft_post');
    const card = (first.outputs as Array<{ type?: string; parameters?: Record<string, unknown> }>).find((o) => o.type === 'tool_call');
    expect(card?.parameters).toMatchObject({ type: 'TEXT', headline: draft.headline, body: draft.body, landingPageUrl: TEST_LANDING_URL });

    // Operator approved (Hub saved the copy as goals.approved_creative and resends it as userSuppliedInput.creative).
    const saved = { type: 'TEXT' as const, headline: draft.headline, body: `${draft.body} (edited)` };
    const resumed = await loop.start(
      testRunRequest({ idempotencyKey, userSuppliedInput: { ...urlOnly, creative: saved }, resume: { askId: need.askId, choice: 'approve' } }),
      testCaller()
    );
    expect(resumed.status).toBe('awaiting_approval');
    const createNeed = resumed.needs?.[0] as { verb: string };
    expect(createNeed.verb).toBe('ads.create_campaign');
    const createCard = (resumed.outputs as Array<{ type?: string; parameters?: Record<string, unknown> }>).find((o) => o.type === 'tool_call');
    // The create uses the operator-saved (edited) copy, never the model draft args.
    expect(createCard?.parameters?.creative).toEqual(saved);
    expect(ads.calls).toHaveLength(0);
  });

  it('refuses drafts with unsupported claims without failing the run, and never calls Ads', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('creative.draft_post', { ...draft, body: 'The best boots in Britain, 50% off.' }),
      testTurn({ message: { role: 'assistant', content: 'I will redraft without claims.' } }),
    ]);
    const { loop, ads, researchStore, runs } = coordinator(llm);
    await seedAcceptedResearch(researchStore);
    const snapshot = await loop.start(testRunRequest({ userSuppliedInput: urlOnly }), testCaller());
    expect(snapshot.status).toBe('completed');
    const stored = await runs.getByRunId(snapshot.runId);
    const tool = stored?.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(String(tool?.content))).toMatchObject({ ok: false, code: 'creative_invalid' });
    expect(ads.calls).toHaveLength(0);
  });

  it('asks for accepted research first', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('creative.draft_post', draft),
      testTurn({ message: { role: 'assistant', content: 'Gathering research first.' } }),
    ]);
    const { loop, runs } = coordinator(llm);
    const snapshot = await loop.start(testRunRequest({ userSuppliedInput: urlOnly }), testCaller());
    const stored = await runs.getByRunId(snapshot.runId);
    const tool = stored?.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(String(tool?.content))).toMatchObject({ ok: false, code: 'research_not_accepted' });
  });

  it('is offered to the model', async () => {
    const { llmToolDefinitions } = await import('../limbs/catalog.js');
    expect(llmToolDefinitions().map((t) => t.name)).toContain('creative.draft_post');
  });
});
