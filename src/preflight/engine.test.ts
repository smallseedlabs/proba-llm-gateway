import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyPreflightToRecord, runPreflight } from './engine.js';
import { testConfig } from '../testing/config.js';
import { AdjustableClock, RecordingAdsDomain, ScriptedLlmClient } from '../testing/doubles.js';
import { testRunRequest, testTurn } from '../testing/fixtures.js';
import { emptyUsageTotals } from '../types/usage.js';
import { RunUsageLedger } from '../usage/reservations.js';
import type { RunRecord } from '../ports/run-store.js';
import type { HubRunRequest } from '../types/run.js';

function recordOf(request: HubRunRequest): RunRecord {
  return {
    key: 'k',
    runId: randomUUID(),
    callerIss: 'proba-hub',
    callerSub: 'hub',
    idempotencyKey: request.traceId,
    fingerprint: 'f',
    state: 'running',
    request,
    messages: [],
    iteration: 0,
    usage: emptyUsageTotals(),
    llmTurns: [],
    toolTurns: [],
    domainState: {},
    events: [],
    publishedEventIds: [],
    updatedAt: new Date().toISOString(),
  };
}

describe('preflight graph engine', () => {
  it('reuses still-fresh Ads evidence across brain iterations and re-probes when stale', async () => {
    const ads = new RecordingAdsDomain();
    const llm = new ScriptedLlmClient([testTurn(), testTurn()]);
    const clock = new AdjustableClock();
    const config = testConfig({ ads: { ...testConfig().ads, preflightFreshnessMs: 5_000 } });
    const request = testRunRequest({ stepType: 'launch_campaign' });
    const record = recordOf(request);
    const usage = new RunUsageLedger({ ...config.limits, contextBudgetTokens: config.context.maxBudgetTokens });
    const signal = new AbortController().signal;
    const deps = { config, clock, ads, llm };

    const first = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(first.allowed).toBe(true);
    applyPreflightToRecord(record, first);
    const second = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(second.allowed).toBe(true);
    expect(second.evaluated.some((row) => row.id === 'ads.service' && row.reused)).toBe(true);
    expect(ads.preflightCalls).toBe(1);

    clock.advance(8_000);
    const third = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(third.allowed).toBe(true);
    expect(ads.preflightCalls).toBe(2);
  });

  it('does not query Ads for analysis/planning and does not call the LLM quota client as a paid completion', async () => {
    const ads = new RecordingAdsDomain();
    ads.billing = {
      kind: 'verified',
      mode: 'billing_eligibility',
      eligible: false,
      asOf: new Date().toISOString(),
      source: 'ads_domain',
    };
    const llm = new ScriptedLlmClient([testTurn()]);
    const request = testRunRequest({ stepType: 'interpret_message' });
    const record = recordOf(request);
    const config = testConfig();
    const decision = await runPreflight(
      { config, clock: new AdjustableClock(), ads, llm },
      request,
      record,
      new RunUsageLedger({ ...config.limits, contextBudgetTokens: config.context.maxBudgetTokens }),
      new AbortController().signal,
      { phase: 'brain' }
    );
    expect(decision.allowed).toBe(true);
    expect(ads.preflightCalls).toBe(0);
    expect(llm.completeCalls).toBe(0);
  });

  it('blocks spend-increase when funds are insufficient and permits pause on the same ineligible claim', async () => {
    const ads = new RecordingAdsDomain();
    ads.mappingReady = true;
    ads.campaignRunning = true;
    ads.billing = {
      kind: 'verified',
      mode: 'billing_eligibility',
      eligible: false,
      asOf: new Date().toISOString(),
      source: 'ads_domain',
    };
    const llm = new ScriptedLlmClient([testTurn()]);
    const config = testConfig();
    const deps = { config, clock: new AdjustableClock(), ads, llm };
    const usage = new RunUsageLedger({ ...config.limits, contextBudgetTokens: config.context.maxBudgetTokens });
    const signal = new AbortController().signal;

    const launch = testRunRequest({ stepType: 'launch_campaign' });
    const blocked = await runPreflight(deps, launch, recordOf(launch), usage, signal, { phase: 'brain' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.needs.some((need) => need.capability === 'ads.billing')).toBe(true);

    const pauseReq = testRunRequest({
      command: {
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'control',
        payload: { action: 'pause', target: 'camp-1' },
        sentAt: new Date().toISOString(),
      },
    });
    const pause = await runPreflight(deps, pauseReq, recordOf(pauseReq), usage, signal, { phase: 'brain' });
    expect(pause.allowed).toBe(true);
    expect(pause.relaxed.some((row) => row.capability === 'ads.billing')).toBe(true);
    expect(llm.completeCalls).toBe(0);
  });
});
