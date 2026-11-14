/**
 * Context is built once per Hub request and reused across loops.
 *
 * context-api treats the forwarded act-as assertion as single-use (jti replay protection,
 * proba-context actAsIdentityResolver). Rebuilding context on every loop with the same
 * assertion made the second build fail with HTTP 401 and blocked multi-loop runs.
 * SingleUseAssertionContextPort reproduces that rule; the replay protection is not relaxed.
 */
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
import { SourcedResearchProvider, TEST_LANDING_URL } from '../testing/research.js';
import { ContextClientError } from '../ports/context.js';
import type { ContextBuildOptions } from '../ports/context.js';
import type { ContextPacket, ContextRequest } from '../protocol.js';
import type { LlmClient } from '../ports/llm-client.js';
import type { ContextPort } from '../ports/context.js';

/** Like context-api: the same assertion is accepted once; a replay is a 401. */
class SingleUseAssertionContextPort extends ScriptedContextPort {
  private readonly seen = new Set<string>();
  override async build(request: ContextRequest, options: ContextBuildOptions): Promise<ContextPacket> {
    if (this.seen.has(options.assertion)) {
      this.builds += 1;
      throw new ContextClientError('http_error', 'Context bridge returned HTTP 401', undefined, 401);
    }
    this.seen.add(options.assertion);
    return super.build(request, options);
  }
}

function loop(llm: LlmClient, context: ContextPort) {
  const ads = new RecordingAdsDomain();
  const clock = new SystemClock();
  const researchStore = new MemoryResearchStore('test');
  return new LoopCoordinator({
    config: testConfig(),
    clock,
    audit: new MemoryAuditPublisher(),
    runs: new MemoryRunStore('test'),
    llm,
    context,
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

function systemOf(llm: ScriptedLlmClient, i: number): string {
  const first = llm.requests[i]?.messages[0];
  return typeof first?.content === 'string' ? first.content : '';
}

describe('context packet is built once per Hub request', () => {
  it('a 3-loop run builds context once and completes under single-use assertions (no 401)', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('nope.first', {}, 'call-a'),
      testToolTurn('nope.second', {}, 'call-b'),
      testTurn({ message: { role: 'assistant', content: 'explained what is needed' } }),
    ]);
    const context = new SingleUseAssertionContextPort();
    const snapshot = await loop(llm, context).start(testRunRequest(), testCaller());

    expect(snapshot.status).toBe('completed');
    expect(snapshot.outputs).toEqual([{ type: 'reply', text: 'explained what is needed' }]);
    expect(llm.completeCalls).toBe(3);
    expect(context.builds).toBe(1);
    // The same packet backs every loop's system message.
    expect(systemOf(llm, 1)).toBe(systemOf(llm, 0));
    expect(systemOf(llm, 2)).toBe(systemOf(llm, 0));
    // Between loops the model learns from tool results, not from a rebuilt context.
    const third = llm.requests[2]!.messages;
    expect(third.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('a model-refused creative (creative_missing) continues to the next loop without rebuilding context', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('ads.create_campaign', {
        name: 'Launch',
        landingPageUrl: TEST_LANDING_URL,
        dailyBudget: 5,
        currency: 'GBP',
        platform: 'reddit',
      }),
      testTurn({ message: { role: 'assistant', content: 'save your post copy first' } }),
    ]);
    const context = new SingleUseAssertionContextPort();
    // Operator entered a landing URL but has not saved post copy yet.
    const request = testRunRequest({ userSuppliedInput: { landingPageUrl: TEST_LANDING_URL } });
    const snapshot = await loop(llm, context).start(request, testCaller());
    expect(snapshot.status).toBe('completed');
    expect(llm.completeCalls).toBe(2);
    const refusal = llm.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(String(refusal?.content)).toContain('creative_missing');
    expect(context.builds).toBe(1);
  });

  it('a failed first build still blocks before any model call', async () => {
    const llm = new ScriptedLlmClient([testTurn()]);
    const context = new ScriptedContextPort();
    context.build = async () => {
      context.builds += 1;
      throw new ContextClientError('http_error', 'Context bridge returned HTTP 401', undefined, 401);
    };
    const snapshot = await loop(llm, context).start(testRunRequest(), testCaller());
    expect(snapshot.status).toBe('blocked');
    expect(llm.completeCalls).toBe(0);
    expect(context.builds).toBe(1);
  });
});
