/**
 * Prompt-cache-friendly ordering: every system message starts with the same bytes (self core + SYSTEM_RULES) across loops and runs
 * of one self version; everything per run follows it, and the per-loop budget is the last message.
 */
import { describe, expect, it } from 'vitest';
import { LoopCoordinator } from './coordinator.js';
import { initialMessages, refreshSystem, SELF_MEMORY_SOURCE, systemPrefix } from './messages.js';
import { CatalogPolicyEngine } from '../limbs/policy.js';
import { DomainLimbExecutor } from '../limbs/dispatcher.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { SystemClock } from '../adapters/system-clock.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { testConfig } from '../testing/config.js';
import { RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { testCaller, testContextPacket, testRunRequest, testToolTurn, testTurn } from '../testing/fixtures.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from '../action-policy/memory-store.js';
import { SourcedResearchProvider, TEST_LANDING_URL, userLanding } from '../testing/research.js';
import type { ContextPacket } from '../protocol.js';

const at = '2026-11-14T00:00:00.000Z';
const CORE = 'You are Proba. When an action is blocked, say why and what would unblock it.';
function packetWith(extra: string): ContextPacket {
  return testContextPacket({
    sections: [
      {
        kind: 'policy',
        priority: 0,
        tokens: 30,
        items: [
          { itemId: 'self.00-core', sourceRef: { source: SELF_MEMORY_SOURCE, id: '00-core' }, trust: 'system', text: CORE, score: 1, observedAt: at },
          { itemId: 'policy.spend', sourceRef: { source: 'policy', id: 'spend' }, trust: 'system', text: 'POLICY-SPEND', observedAt: at },
        ],
      },
      {
        kind: 'memory',
        priority: 3,
        tokens: 20,
        items: [{ itemId: 'self.10-x', sourceRef: { source: SELF_MEMORY_SOURCE, id: '10-x' }, trust: 'derived', text: `Proba guidance: ${extra}`, observedAt: at }],
      },
    ],
  });
}
const facts = { offeredTools: ['research.gather'], deniedByGuardrails: [] };

describe('system prompt prefix', () => {
  it('is byte-identical for different runs, steps, inputs and context, and nothing per-run comes before its end', () => {
    const prefix = systemPrefix(packetWith('a'));
    expect(prefix.startsWith(`[self]\n${CORE}\n\nYou are the Proba brain inside the gateway harness.`)).toBe(true);
    const variants = [
      initialMessages(packetWith('a'), testRunRequest(), facts)[0]!.content!,
      initialMessages(packetWith('b'), testRunRequest({ stepType: 'interpret_message', userSuppliedInput: userLanding() }), { ...facts, deniedByGuardrails: ['ads.create_campaign'] })[0]!.content!,
      refreshSystem([{ role: 'system', content: 'old' }, { role: 'user', content: 'hi' }], packetWith('c'), testRunRequest(), facts)[0]!.content!,
    ];
    for (const v of variants) {
      expect(v.slice(0, prefix.length)).toBe(prefix);
      // The per-run part starts right after the prefix.
      const rest = v.slice(prefix.length);
      expect(rest.startsWith('\n\n')).toBe(true);
    }
    for (const perRun of ['[run]', 'Relevant context:', 'Proba guidance', 'Operator-supplied landing page URL', 'POLICY-SPEND']) {
      expect(prefix).not.toContain(perRun);
    }
  });

  it('across loops and runs through the loop: same prefix on every call, earlier turns unchanged, budget last', async () => {
    const context = new ScriptedContextPort(packetWith('a'));
    const llm = new ScriptedLlmClient([
      testToolTurn('research.gather', { url: TEST_LANDING_URL }),
      testTurn({ message: { role: 'assistant', content: 'Research is turned off; here is why and what would unblock it.' } }),
      testTurn({ message: { role: 'assistant', content: 'Second run answer.' } }),
    ]);
    const ads = new RecordingAdsDomain();
    const clock = new SystemClock();
    const researchStore = new MemoryResearchStore('test');
    const coordinator = new LoopCoordinator({
      config: testConfig({ guardrails: { version: 't', source: 'inline', verbs: { 'research.gather': 'deny' }, limits: {} } }),
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
    expect((await coordinator.start(testRunRequest({ userSuppliedInput: userLanding() }), testCaller())).status).toBe('completed');
    expect((await coordinator.start(testRunRequest({ idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8b01-bbbbbbbbbbbb', stepType: 'interpret_message' }), testCaller())).status).toBe('completed');

    expect(llm.requests).toHaveLength(3);
    const prefix = systemPrefix(packetWith('a'));
    for (const r of llm.requests) expect(r.messages[0]!.content!.slice(0, prefix.length)).toBe(prefix);
    const [loop1, loop2] = llm.requests;
    // Loop 2 re-sends loop 1's system and user messages byte for byte (a cacheable prefix), then the new turns, then the budget.
    expect(loop2!.messages.slice(0, 2)).toEqual(loop1!.messages.slice(0, 2));
    expect(loop1!.messages.at(-1)).toMatchObject({ role: 'system', content: expect.stringContaining('[run budget] Loop 1 of at most') });
    expect(loop2!.messages.at(-1)).toMatchObject({ role: 'system', content: expect.stringContaining('[run budget] Loop 2 of at most') });
    expect(loop2!.messages.filter((m) => m.content?.startsWith('[run budget]'))).toHaveLength(1);
  });

  it('surfaces provider cache-hit tokens in run usage and on the brain.llm_call audit event', async () => {
    const audit = new MemoryAuditPublisher();
    const llm = new ScriptedLlmClient([testTurn({ usage: { promptTokens: 2500, completionTokens: 100, cachedTokens: 1792 } })]);
    const ads = new RecordingAdsDomain();
    const clock = new SystemClock();
    const researchStore = new MemoryResearchStore('test');
    const coordinator = new LoopCoordinator({
      config: testConfig(),
      clock,
      audit,
      runs: new MemoryRunStore('test'),
      llm,
      context: new ScriptedContextPort(packetWith('a')),
      policy: new CatalogPolicyEngine(),
      approval: new FailClosedApprovalGate(),
      tools: new DomainLimbExecutor(ads, { provider: new SourcedResearchProvider(), store: researchStore, clock }),
      ads,
      researchStore,
      analyticsStore: new MemoryAnalyticsStore('test'),
      actionPolicyStore: new MemoryActionPolicyStore('test'),
      actionOutcomeStore: new MemoryActionOutcomeStore('test'),
    });
    const snapshot = await coordinator.start(testRunRequest(), testCaller());
    expect(snapshot.usage).toMatchObject({ promptTokens: 2500, cachedTokens: 1792 });
    await new Promise((r) => setTimeout(r, 10));
    const call = audit.events.find((e) => e.action === 'brain.llm_call');
    expect(call?.details).toMatchObject({ promptCacheHits: 1792 });
  });
});
