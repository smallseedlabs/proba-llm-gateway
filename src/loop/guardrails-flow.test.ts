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
import { SourcedResearchProvider, TEST_LANDING_URL, userLanding } from '../testing/research.js';
import type { Guardrails } from '../guardrails/guardrails.js';

function loop(llm: ScriptedLlmClient, guardrails: Guardrails) {
  const ads = new RecordingAdsDomain();
  const research = new SourcedResearchProvider();
  const researchStore = new MemoryResearchStore('test');
  const clock = new SystemClock();
  const audit = new MemoryAuditPublisher();
  const coordinator = new LoopCoordinator({
    config: testConfig({ guardrails }),
    clock,
    audit,
    runs: new MemoryRunStore('test'),
    llm,
    context: new ScriptedContextPort(),
    policy: new CatalogPolicyEngine(),
    approval: new FailClosedApprovalGate(),
    tools: new DomainLimbExecutor(ads, { provider: research, store: researchStore, clock }),
    ads,
    researchStore,
    analyticsStore: new MemoryAnalyticsStore('test'),
    actionPolicyStore: new MemoryActionPolicyStore('test'),
    actionOutcomeStore: new MemoryActionOutcomeStore('test'),
  });
  return { coordinator, ads, research };
}

const g = (verbs: Guardrails['verbs'], limits: Guardrails['limits'] = {}): Guardrails => ({ version: 't1', source: 'inline', verbs, limits });
const req = () => testRunRequest({ userSuppliedInput: userLanding() });
const systemOf = (llm: ScriptedLlmClient, i: number) => llm.requests[i]?.messages[0]?.content ?? '';

describe('guardrails in the loop', () => {
  it('deny hides the verb, refuses it if called anyway, and lets the model explain', async () => {
    const llm = new ScriptedLlmClient([
      testToolTurn('research.gather', { url: TEST_LANDING_URL }),
      testTurn({ message: { role: 'assistant', content: 'Research is turned off by your guardrails.' } }),
    ]);
    const { coordinator, research } = loop(llm, g({ 'research.gather': 'deny' }));
    const snapshot = await coordinator.start(req(), testCaller());
    expect(snapshot.status).toBe('completed');
    expect(research.calls).toBe(0);
    expect(llm.requests[0]?.tools?.map((t) => t.name) ?? []).not.toContain('research.gather');
    expect(systemOf(llm, 0)).toContain('Turned off by the gateway guardrails config (deployment-wide): research.gather.');
    expect(systemOf(llm, 0)).toContain('Each one raises an approval card');
    const toolMsg = llm.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(String(toolMsg?.content))).toMatchObject({ ok: false, code: 'guardrail' });
  });

  it('ask puts an approval card in front of a verb the code would run directly', async () => {
    const llm = new ScriptedLlmClient([testToolTurn('research.gather', { url: TEST_LANDING_URL })]);
    const { coordinator, research } = loop(llm, g({ 'research.gather': 'ask' }));
    const snapshot = await coordinator.start(req(), testCaller());
    expect(snapshot.status).toBe('awaiting_approval');
    expect((snapshot.needs?.[0] as { verb?: string }).verb).toBe('research.gather');
    expect(research.calls).toBe(0);
  });

  it('the guardrail iteration ceiling bounds the run and the model is told its budget', async () => {
    const llm = new ScriptedLlmClient([testTurn({ message: { role: 'assistant', content: 'Here is what I found.' } })]);
    const { coordinator } = loop(llm, g({}, { maxIterations: 2 }));
    const snapshot = await coordinator.start(testRunRequest({ userSuppliedInput: userLanding(), budget: { maxIterations: 6 } }), testCaller());
    expect(snapshot.status).toBe('completed');
    const system = systemOf(llm, 0);
    const last = llm.requests[0]?.messages.at(-1);
    expect(last).toMatchObject({ role: 'system' });
    expect(last?.content).toContain('[run budget] Loop 1 of at most 2;');
    expect(system).toContain('how many is your choice within the run budget');
    expect(system).not.toMatch(/must (end|finish) with a proposal/i);
  });
});
