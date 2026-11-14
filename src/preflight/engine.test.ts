import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyPreflightToRecord, mutateIntent, runPreflight } from './engine.js';
import { operationManifest } from './graph.js';
import { testConfig } from '../testing/config.js';
import { AdjustableClock, RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { ContextClientError } from '../ports/context.js';
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
    const deps = { config, clock, ads, llm, context: new ScriptedContextPort() };

    const first = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(first.allowed).toBe(true);
    applyPreflightToRecord(record, first);
    const second = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(second.allowed).toBe(true);
    expect(second.evaluated.some((row) => row.id === 'ads.service' && row.reused)).toBe(true);
    expect(second.evaluated.some((row) => row.id === 'context.ready' && row.reused)).toBe(true);
    expect(ads.preflightCalls).toBe(1);
    expect(deps.context.pings).toBe(1);

    clock.advance(8_000);
    const third = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(third.allowed).toBe(true);
    expect(ads.preflightCalls).toBe(2);
    expect(deps.context.pings).toBe(2);
  });

  it('reuses still-fresh Context readiness and re-probes after expiry, blocking when it is down', async () => {
    const ads = new RecordingAdsDomain();
    const llm = new ScriptedLlmClient([testTurn()]);
    const clock = new AdjustableClock();
    const config = testConfig({ ads: { ...testConfig().ads, preflightFreshnessMs: 5_000 } });
    const request = testRunRequest({ stepType: 'interpret_message' });
    const record = recordOf(request);
    const usage = new RunUsageLedger({ ...config.limits, contextBudgetTokens: config.context.maxBudgetTokens });
    const signal = new AbortController().signal;
    const context = new ScriptedContextPort();
    const deps = { config, clock, ads, llm, context };

    const first = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(first.allowed).toBe(true);
    applyPreflightToRecord(record, first);
    const second = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(second.allowed).toBe(true);
    expect(second.evaluated.some((row) => row.id === 'context.ready' && row.reused)).toBe(true);
    expect(context.pings).toBe(1);

    clock.advance(8_000);
    context.pingError = new ContextClientError('unreachable', 'context bridge went down after cache expiry');
    const staleDown = await runPreflight(deps, request, record, usage, signal, { phase: 'brain' });
    expect(staleDown.allowed).toBe(false);
    expect(staleDown.needs.some((need) => need.capability === 'context.ready' && need.state === 'unavailable')).toBe(true);
    expect(context.pings).toBe(2);
    expect(llm.completeCalls).toBe(0);
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
      { config, clock: new AdjustableClock(), ads, llm, context: new ScriptedContextPort() },
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
    const deps = { config, clock: new AdjustableClock(), ads, llm, context: new ScriptedContextPort() };
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

  it('blocks paid model dispatch when Context is missing, down, or identity is incomplete', async () => {
    const ads = new RecordingAdsDomain();
    const llm = new ScriptedLlmClient([testTurn()]);
    const clock = new AdjustableClock();
    const usageFor = (config: ReturnType<typeof testConfig>) =>
      new RunUsageLedger({ ...config.limits, contextBudgetTokens: config.context.maxBudgetTokens });
    const signal = new AbortController().signal;
    const request = testRunRequest({ stepType: 'interpret_message' });

    const missingUrl = testConfig({ context: { ...testConfig().context, baseUrl: '' } });
    const missing = await runPreflight(
      { config: missingUrl, clock, ads, llm, context: new ScriptedContextPort() },
      request,
      recordOf(request),
      usageFor(missingUrl),
      signal,
      { phase: 'brain' }
    );
    expect(missing.allowed).toBe(false);
    expect(missing.needs.some((need) => need.capability === 'context.ready' && need.state === 'missing')).toBe(true);
    expect(llm.completeCalls).toBe(0);

    const down = new ScriptedContextPort();
    down.pingError = new ContextClientError('unreachable', 'context bridge down');
    const blockedDown = await runPreflight(
      { config: testConfig(), clock, ads, llm, context: down },
      request,
      recordOf(request),
      usageFor(testConfig()),
      signal,
      { phase: 'brain' }
    );
    expect(blockedDown.allowed).toBe(false);
    expect(blockedDown.needs.some((need) => need.capability === 'context.ready' && need.state === 'unavailable')).toBe(true);
    expect(llm.completeCalls).toBe(0);

    const noGoal = testRunRequest({ stepType: 'interpret_message', goalId: undefined, threadId: undefined });
    const blockedId = await runPreflight(
      { config: testConfig(), clock, ads, llm, context: new ScriptedContextPort() },
      noGoal,
      recordOf(noGoal),
      usageFor(testConfig()),
      signal,
      { phase: 'brain' }
    );
    expect(blockedId.allowed).toBe(false);
    expect(blockedId.needs.some((need) => need.capability === 'context.ready')).toBe(true);
    expect(llm.completeCalls).toBe(0);

    const prod = testConfig({ env: 'development' });
    const blockedActAs = await runPreflight(
      { config: prod, clock, ads, llm, context: new ScriptedContextPort() },
      request,
      recordOf(request),
      usageFor(prod),
      signal,
      { phase: 'brain' }
    );
    expect(blockedActAs.allowed).toBe(false);
    expect(blockedActAs.needs.some((need) => need.capability === 'context.ready' && need.state === 'unauthorized')).toBe(
      true
    );
    expect(llm.completeCalls).toBe(0);
  });

  it('keeps unknown quota explicit, never invents a balance, and refuses when policy says so', async () => {
    const ads = new RecordingAdsDomain();
    const llm = new ScriptedLlmClient([testTurn()]);
    const clock = new AdjustableClock();
    const signal = new AbortController().signal;
    const request = testRunRequest({ stepType: 'interpret_message' });
    const base = testConfig();
    const usage = new RunUsageLedger({ ...base.limits, contextBudgetTokens: base.context.maxBudgetTokens });

    const allowedUnknown = await runPreflight(
      { config: base, clock, ads, llm, context: new ScriptedContextPort() },
      request,
      recordOf(request),
      usage,
      signal,
      { phase: 'brain' }
    );
    expect(allowedUnknown.allowed).toBe(true);
    expect(allowedUnknown.llmQuota.kind).toBe('unknown');
    expect(llm.completeCalls).toBe(0);
    expect(llm.quotaCalls).toBeGreaterThan(0);

    llm.quotaClaim = { kind: 'unavailable', reason: 'proba-llm /v1/quota returned HTTP 503' };
    const downQuota = await runPreflight(
      { config: base, clock, ads, llm, context: new ScriptedContextPort() },
      request,
      recordOf(request),
      usage,
      signal,
      { phase: 'brain' }
    );
    expect(downQuota.allowed).toBe(false);
    expect(downQuota.needs.some((need) => need.capability === 'llm.service')).toBe(true);
    expect(llm.completeCalls).toBe(0);

    const refuseCfg = testConfig({ llm: { ...testConfig().llm, quotaUnknownPolicy: 'refuse' } });
    llm.quotaClaim = { kind: 'unknown', reason: 'proba-llm has no quota endpoint; /ready is not a credit balance' };
    const refused = await runPreflight(
      { config: refuseCfg, clock, ads, llm, context: new ScriptedContextPort() },
      request,
      recordOf(request),
      new RunUsageLedger({ ...refuseCfg.limits, contextBudgetTokens: refuseCfg.context.maxBudgetTokens }),
      signal,
      { phase: 'brain' }
    );
    expect(refused.allowed).toBe(false);
    expect(refused.needs.some((need) => need.capability === 'llm.quota' && need.state === 'unknown')).toBe(true);
    expect(llm.completeCalls).toBe(0);
  });

  it('blocks a USD ceiling before any paid call when pricing is unknown, and allows only a fitting bound', async () => {
    const ads = new RecordingAdsDomain();
    const llm = new ScriptedLlmClient([testTurn()]);
    const clock = new AdjustableClock();
    const signal = new AbortController().signal;
    const request = testRunRequest({ stepType: 'interpret_message' });
    const capped = testConfig({ limits: { ...testConfig().limits, maxCostUsd: 1 } });
    const usageFor = (config: ReturnType<typeof testConfig>) =>
      new RunUsageLedger({ ...config.limits, contextBudgetTokens: config.context.maxBudgetTokens });

    const unknownPricing = await runPreflight(
      { config: capped, clock, ads, llm, context: new ScriptedContextPort() },
      request,
      recordOf(request),
      usageFor(capped),
      signal,
      { phase: 'brain' }
    );
    expect(unknownPricing.allowed).toBe(false);
    expect(unknownPricing.needs.some((need) => need.capability === 'run.budget' && need.state === 'unknown')).toBe(true);
    expect(llm.completeCalls).toBe(0);

    llm.pricingClaim = {
      kind: 'verified',
      promptUsdPerMillion: 0.15,
      completionUsdPerMillion: 0.6,
      version: 'test-v1',
    };
    const fitting = await runPreflight(
      { config: capped, clock, ads, llm, context: new ScriptedContextPort() },
      request,
      recordOf(request),
      usageFor(capped),
      signal,
      { phase: 'brain' }
    );
    expect(fitting.allowed).toBe(true);
    expect(llm.completeCalls).toBe(0);

    const tight = testConfig({ limits: { ...testConfig().limits, maxCostUsd: 0.000001 } });
    const insufficient = await runPreflight(
      { config: tight, clock, ads, llm, context: new ScriptedContextPort() },
      request,
      recordOf(request),
      usageFor(tight),
      signal,
      { phase: 'brain' }
    );
    expect(insufficient.allowed).toBe(false);
    expect(insufficient.needs.some((need) => need.capability === 'run.budget' && need.state === 'insufficient')).toBe(
      true
    );
    expect(llm.completeCalls).toBe(0);
  });
});


describe('mutateIntent', () => {
  it('does not require a campaign mapping or billing to execute creative.draft_post', () => {
    const intent = mutateIntent({
      verb: 'creative.draft_post',
      args: { headline: 'Hello', body: 'A specific Reddit post body.' },
    });
    expect(intent).toMatchObject({ kind: 'read_or_plan', requiresAds: false, spendClass: 'none' });
    const manifest = operationManifest({ phase: 'mutate', intent });
    expect(manifest.requires).not.toContain('ads.blueprint');
    expect(manifest.requires).not.toContain('ads.billing');
    expect(manifest.requires).not.toContain('ads.service');
  });

  it('still requires billing and not a mapping when creating a campaign', () => {
    const intent = mutateIntent({
      verb: 'ads.create_campaign',
      args: { name: 'Spring', landingPageUrl: 'https://example.com', dailyBudget: 5, currency: 'USD', platform: 'reddit' },
    });
    expect(intent).toMatchObject({ kind: 'ads_mutate', mappingRequired: false, spendClass: 'spend_increase' });
    const manifest = operationManifest({ phase: 'mutate', intent });
    expect(manifest.requires).toContain('ads.billing');
    expect(manifest.requires).not.toContain('ads.blueprint');
  });

  it('requires a mapping for campaign mutations that target an existing campaign', () => {
    const intent = mutateIntent({ verb: 'ads.pause_campaign', args: { probaCampaignId: 'camp-1' } });
    expect(intent).toMatchObject({ kind: 'ads_mutate', mappingRequired: true });
    expect(operationManifest({ phase: 'mutate', intent }).requires).toContain('ads.blueprint');
  });
});
