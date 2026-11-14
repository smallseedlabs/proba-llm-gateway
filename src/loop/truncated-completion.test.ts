/**
 * A truncated model turn (finishReason=length) must never count as a completed
 * empty reply. The loop retries once with a concise-continue nudge and the
 * remaining completion budget; a second truncation is blocked with a clear reason.
 */
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
import { testCaller, testRunRequest, testTurn } from '../testing/fixtures.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from '../action-policy/memory-store.js';
import { SourcedResearchProvider } from '../testing/research.js';
import { TRUNCATED_COMPLETION_CODE, truncatedCompletionMessage } from './run-loop.js';

function loopOf(llm: ScriptedLlmClient, config = testConfig()) {
  const ads = new RecordingAdsDomain();
  const clock = new SystemClock();
  const researchStore = new MemoryResearchStore('test');
  return new LoopCoordinator({
    config,
    clock,
    audit: new MemoryAuditPublisher(),
    runs: new MemoryRunStore('test'),
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
}

function truncatedDraftTurn(completionTokens = 512) {
  return testTurn({
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          id: 'call-draft',
          name: 'creative.draft_post',
          arguments: '{"headline":"Hi","body":"this draft was cut off mid-sentence',
        },
      ],
    },
    finishReason: 'length',
    usage: { promptTokens: 100, completionTokens },
  });
}

const planningBudget = { budget: { maxCompletionTokens: 1500 } };

describe('truncated completion (finishReason=length)', () => {
  it('does not complete an empty reply; retries once with a larger remaining cap and a concise nudge', async () => {
    const llm = new ScriptedLlmClient([
      truncatedDraftTurn(512),
      testTurn({ message: { role: 'assistant', content: 'here is a concise plan' } }),
    ]);
    const snapshot = await loopOf(llm).start(testRunRequest(planningBudget), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(snapshot.outputs).toEqual([{ type: 'reply', text: 'here is a concise plan' }]);
    expect(llm.completeCalls).toBe(2);
    expect(llm.requests[0]?.maxTokens).toBe(1500);
    expect(llm.requests[1]?.maxTokens).toBe(988);
    const nudged = JSON.stringify(llm.requests[1]?.messages);
    expect(nudged).toContain('truncated at the completion token limit');
    expect(nudged).toContain('be concise');
  });

  it('blocks with a clear reason when the retry is also truncated', async () => {
    const llm = new ScriptedLlmClient([truncatedDraftTurn(512), truncatedDraftTurn(200)]);
    const snapshot = await loopOf(llm).start(testRunRequest(planningBudget), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(snapshot.error?.code).toBe(TRUNCATED_COMPLETION_CODE);
    expect(snapshot.outputs).toEqual([{ type: 'reply', text: truncatedCompletionMessage() }]);
    expect(llm.completeCalls).toBe(2);
  });

  it('blocks without retrying when the run has no remaining LLM calls', async () => {
    const llm = new ScriptedLlmClient([truncatedDraftTurn(512), testTurn()]);
    const snapshot = await loopOf(
      llm,
      testConfig({ limits: { ...testConfig().limits, maxLlmCalls: 1 } })
    ).start(testRunRequest(planningBudget), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(snapshot.error?.code).toBe(TRUNCATED_COMPLETION_CODE);
    expect(llm.completeCalls).toBe(1);
  });
});
