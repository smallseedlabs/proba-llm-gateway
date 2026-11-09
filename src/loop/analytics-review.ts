/**
 * review_performance path: Context packet → deterministic evaluator.
 * Zero LLM complete calls, zero Ads POSTs, grantsSpend always false.
 * Owner action policies (including auto_with_limits) are not authority here.
 */

import type { CapabilityNeed } from '../types/preflight.js';
import type { HubRunRequest, RunSnapshot } from '../types/run.js';
import type { RunRecord } from '../ports/run-store.js';
import type { RunUsageLedger } from '../usage/reservations.js';
import type { Cancellation } from '../ports/cancellation.js';
import { applyPreflightToRecord, graphAuditDetails, runPreflight } from '../preflight/engine.js';
import { evaluateAnalytics, decisionRecordFromResult } from '../analytics/evaluate.js';
import { snapshotsFromPacket } from '../analytics/packet.js';
import { analyticsScopeFromRequest } from '../analytics/scope.js';
import type { AnalyticsEvaluatorConfig } from '../analytics/types.js';
import { gatewayAuditEvent } from './audit-events.js';
import { finish, type LoopBodyDeps } from './run-loop.js';
import { BudgetExhaustedError, RequestValidationError } from '../errors.js';

export function analyticsConfigOf(deps: LoopBodyDeps): AnalyticsEvaluatorConfig {
  const cfg = deps.config.analytics;
  return {
    maxAgeMs: cfg.maxAgeMs,
    minImpressions: cfg.minImpressions,
    minObservations: cfg.minObservations,
    minWindowCoverage: cfg.minWindowCoverage,
    cooldownMs: cfg.cooldownMs,
    maxProposalDailyBudget: cfg.maxProposalDailyBudget,
    maxProposalDecreasePct: cfg.maxProposalDecreasePct,
  };
}

export async function runAnalyticsReview(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest,
  cancellation: Cancellation,
  usage: RunUsageLedger
): Promise<RunSnapshot> {
  cancellation.throwIfAborted();
  const preflight = await runPreflight(
    { config: deps.config, clock: deps.clock, ads: deps.ads, llm: deps.llm, context: deps.context, researchStore: deps.researchStore },
    request,
    record,
    usage,
    cancellation.signal,
    { phase: 'evaluate' }
  );
  applyPreflightToRecord(record, preflight);
  record.events.push(
    gatewayAuditEvent(request, {
      action: preflight.allowed ? 'command.processed' : 'policy.denied',
      outcome: preflight.allowed ? 'success' : 'denied',
      occurredAt: deps.clock.isoNow(),
      errorCode: preflight.allowed ? undefined : 'preflight_blocked',
      errorMessage: preflight.allowed ? undefined : preflight.needs[0]?.message,
      details: graphAuditDetails(preflight),
    })
  );
  await deps.persist(record);
  if (!preflight.allowed) {
    const budget = preflight.needs.find((need) => need.capability === 'run.budget');
    if (budget?.state === 'insufficient') throw new BudgetExhaustedError(budget.message);
    return finish(
      deps,
      record,
      'blocked',
      [],
      { code: 'preflight_blocked', message: preflight.needs[0]?.message ?? 'preflight blocked', retryable: true },
      preflight.needs as CapabilityNeed[]
    );
  }

  const packet = await loadPacket(deps, record, request, cancellation, usage);
  const scope = analyticsScopeFromRequest(request);
  const preview = snapshotsFromPacket(packet);
  const campaignId = scope.probaCampaignId ?? preview[0]?.probaCampaignId ?? preview[0]?.campaignId;
  const last = campaignId
    ? await deps.analyticsStore.get({
        workspaceId: request.workspaceId,
        userId: request.userId,
        probaCampaignId: campaignId,
      })
    : undefined;

  const result = evaluateAnalytics({
    request,
    packet,
    last,
    now: deps.clock.now(),
    config: analyticsConfigOf(deps),
    idempotencyKey: record.idempotencyKey,
  });

  record.events.push(
    gatewayAuditEvent(request, {
      action: 'brain.decision_made',
      outcome: result.outcome === 'blocked' ? 'denied' : 'success',
      occurredAt: deps.clock.isoNow(),
      details: {
        evaluator: 'analytics',
        decisionId: result.decisionId,
        outcome: result.outcome,
        grantsSpend: false,
        dryRun: result.proposal?.dryRun ?? false,
        asOf: result.asOf,
        campaignDecisionVersion: result.campaignDecisionVersion,
        unknownMetrics: result.unknownMetrics,
        gate: result.gate,
        proposal: result.proposal
          ? { verb: result.proposal.verb, argsHash: result.proposal.argsHash, dryRun: true, grantsSpend: false }
          : undefined,
        packetId: packet.packetId,
        packetHash: packet.packetHash,
      },
    })
  );

  const persisted = decisionRecordFromResult(result, {
    now: deps.clock.now(),
    cooldownMs: deps.config.analytics.cooldownMs,
    idempotencyKey: record.idempotencyKey,
    packetHash: packet.packetHash,
  });
  if (persisted && result.gate?.code !== 'cooldown' && result.gate?.code !== 'stale_decision') {
    await deps.analyticsStore.put(persisted);
  }

  record.analytics = {
    decisionId: result.decisionId,
    outcome: result.outcome,
    grantsSpend: false,
    asOf: result.asOf,
    ...(persisted?.probaCampaignId ? { probaCampaignId: persisted.probaCampaignId } : {}),
    ...(persisted?.platform ? { platform: persisted.platform } : {}),
    ...(persisted?.accountId ? { accountId: persisted.accountId } : {}),
    ...(result.scope.providerCampaignId ? { providerCampaignId: result.scope.providerCampaignId } : {}),
    ...(persisted && result.gate?.code !== 'cooldown' && result.gate?.code !== 'stale_decision'
      ? { reviewWindowUntil: persisted.cooldownUntil }
      : {}),
    unknownMetrics: result.unknownMetrics,
    ...(result.gate ? { gate: result.gate } : {}),
    metrics: result.snapshots.map((m) => ({
      sourceItemId: m.sourceItemId,
      platform: m.platform,
      accountId: m.accountId,
      campaignId: m.campaignId,
      asOf: m.asOf,
      ...(m.currency ? { currency: m.currency } : {}),
      impressions: m.impressions,
      clicks: m.clicks,
      spend: m.spend,
      conversions: m.conversions,
    })),
    ...(result.proposal && persisted && result.gate === undefined
      ? {
          proposal: {
            dryRun: true as const,
            grantsSpend: false as const,
            verb: result.proposal.verb,
            args: result.proposal.args,
            argsHash: result.proposal.argsHash,
          },
        }
      : {}),
  };

  const status = result.outcome === 'blocked' ? 'blocked' : 'completed';
  return finish(
    deps,
    record,
    status,
    [
      {
        type: 'decision',
        decision: result.outcome === 'dry_run_proposal' ? 'change' : result.outcome === 'blocked' ? 'kill' : 'keep',
        target: persisted?.probaCampaignId ?? request.goalId ?? request.workspaceId,
        evidence: result.snapshots.map((s) => s.sourceItemId),
        confidence: result.unknownMetrics.length === 0 ? 1 : 0,
        recommendation: result.reply,
      },
      { type: 'reply', text: result.reply },
    ],
    result.outcome === 'blocked'
      ? { code: result.gate?.code ?? 'analytics_blocked', message: result.reply, retryable: false }
      : undefined
  );
}

async function loadPacket(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest,
  cancellation: Cancellation,
  usage: RunUsageLedger
) {
  const testSkip = deps.config.env === 'test' && !request.actAsAssertion;
  if (!testSkip && (!request.actAsAssertion || !request.goalId || !request.threadId)) {
    throw new RequestValidationError('context enrichment requires actAsAssertion, goalId and threadId');
  }
  const assertion = request.actAsAssertion ?? 'test';
  const packet = await deps.context.build(
    {
      traceId: request.traceId,
      workspaceId: request.workspaceId,
      userId: request.userId,
      goalId: request.goalId!,
      threadId: request.threadId!,
      stepId: request.stepId,
      stepType: request.stepType,
      budgetTokens: usage.contextBudgetTokens(),
    },
    { assertion, signal: cancellation.signal }
  );
  record.events.push(
    gatewayAuditEvent(request, {
      action: 'brain.context_attached',
      outcome: 'success',
      occurredAt: deps.clock.isoNow(),
      details: { packetId: packet.packetId, packetHash: packet.packetHash, stepId: request.stepId, stepType: request.stepType },
    })
  );
  return packet;
}
