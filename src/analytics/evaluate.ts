/**
 * Deterministic analytics evaluator. No Ads POST, no LLM, no spend grant.
 */

import { randomUUID } from 'node:crypto';
import type { ContextPacket } from '../protocol.js';
import { canonicalArgsHash } from '../audit/canonical.js';
import type { AnalyticsDecisionRecord, AnalyticsEvaluateResult, AnalyticsEvaluatorConfig, AnalyticsGateCode, AnalyticsProposal } from './types.js';
import { hasNoAnalyticsGap, inScope, snapshotsFromPacket, unknownMetricNames } from './packet.js';
import { analyticsScopeFromRequest } from './scope.js';
import { cooldownGate, firstSnapshotGate, proposalBoundsGate, staleDecisionGate } from './gates.js';
import type { HubRunRequest } from '../types/run.js';

export interface EvaluateAnalyticsInput {
  request: HubRunRequest;
  packet: ContextPacket;
  last?: AnalyticsDecisionRecord;
  now: Date;
  config: AnalyticsEvaluatorConfig;
  idempotencyKey: string;
}

function fail(
  _input: EvaluateAnalyticsInput,
  scope: ReturnType<typeof analyticsScopeFromRequest>,
  snapshots: AnalyticsEvaluateResult['snapshots'],
  code: AnalyticsGateCode,
  message: string,
  outcome: 'no_action' | 'blocked'
): AnalyticsEvaluateResult {
  return {
    outcome,
    grantsSpend: false,
    decisionId: randomUUID(),
    asOf: snapshots[0]?.asOf ?? null,
    campaignDecisionVersion: snapshots[0]?.asOf ?? null,
    scope,
    unknownMetrics: snapshots.flatMap(unknownMetricNames),
    gate: { code, message },
    snapshots,
    reply: `analytics ${outcome}: ${message}`,
  };
}

function campaignKey(scope: ReturnType<typeof analyticsScopeFromRequest>, snapshots: AnalyticsEvaluateResult['snapshots']): string {
  return scope.probaCampaignId ?? snapshots[0]?.probaCampaignId ?? snapshots[0]?.campaignId ?? scope.goalId ?? 'unknown';
}

export function evaluateAnalytics(input: EvaluateAnalyticsInput): AnalyticsEvaluateResult {
  const scope = analyticsScopeFromRequest(input.request);
  if (input.packet.workspaceId !== input.request.workspaceId) {
    return fail(input, scope, [], 'scope_workspace', 'context packet workspaceId does not match the Hub run', 'blocked');
  }
  if (input.packet.userId !== input.request.userId) {
    return fail(input, scope, [], 'scope_actor', 'context packet userId does not match the Hub run actor', 'blocked');
  }

  const all = snapshotsFromPacket(input.packet);
  const snapshots = all.filter((row) => inScope(row, scope));
  if (snapshots.length === 0) {
    if (all.length > 0) {
      return fail(
        input,
        scope,
        [],
        'scope_campaign',
        'analytics items exist but none match tenant/provider/account/campaign scope',
        'blocked'
      );
    }
    const missing = hasNoAnalyticsGap(input.packet)
      ? 'context gap no_analytics_for_campaign; missing metrics stay unknown, not zero'
      : 'no in-scope analytics items in the context packet';
    return fail(input, scope, [], 'missing_metrics', missing, 'no_action');
  }

  const primary = snapshots[0];
  const now = input.now;
  const snapGate = firstSnapshotGate(primary, now, input.config);
  if (snapGate) {
    const outcome = snapGate.code === 'unknown_freshness' ? 'blocked' : 'no_action';
    return fail(input, scope, snapshots, snapGate.code, snapGate.message, outcome);
  }

  const cool = cooldownGate(input.last, now);
  if (cool) return fail(input, scope, snapshots, cool.code, cool.message, 'no_action');
  const stale = staleDecisionGate(input.last, primary.asOf);
  if (stale) return fail(input, scope, snapshots, stale.code, stale.message, 'blocked');

  const bounds = proposalBoundsGate({
    intent: scope.reviewIntent,
    dailyBudget: scope.dailyBudget,
    currentDailyBudget: scope.currentDailyBudget,
    config: input.config,
  });
  if (bounds) return fail(input, scope, snapshots, bounds.code, bounds.message, 'blocked');

  const unknownMetrics = snapshots.flatMap(unknownMetricNames);
  const campaignId = campaignKey(scope, snapshots);
  const decisionId = randomUUID();
  const asOf = primary.asOf;

  if (scope.reviewIntent === 'report') {
    return {
      outcome: 'report',
      grantsSpend: false,
      decisionId,
      asOf,
      campaignDecisionVersion: asOf,
      scope,
      unknownMetrics,
      snapshots,
      reply: `analytics report for ${campaignId}; unknown metrics: ${unknownMetrics.join(',') || 'none'}`,
    };
  }

  const proposal: AnalyticsProposal =
    scope.reviewIntent === 'propose_pause'
      ? {
          dryRun: true,
          grantsSpend: false,
          verb: 'ads.pause_campaign',
          args: { probaCampaignId: campaignId },
          argsHash: canonicalArgsHash({ probaCampaignId: campaignId }),
        }
      : {
          dryRun: true,
          grantsSpend: false,
          verb: 'ads.update_campaign',
          args: { probaCampaignId: campaignId, dailyBudget: scope.dailyBudget, currency: scope.currency },
          argsHash: canonicalArgsHash({
            probaCampaignId: campaignId,
            dailyBudget: scope.dailyBudget,
            currency: scope.currency,
          }),
        };

  return {
    outcome: 'dry_run_proposal',
    grantsSpend: false,
    decisionId,
    asOf,
    campaignDecisionVersion: asOf,
    scope,
    unknownMetrics,
    proposal,
    snapshots,
    reply: `analytics dry-run proposal ${proposal.verb} (not executed, grantsSpend=false) argsHash=${proposal.argsHash}`,
  };
}

export function decisionRecordFromResult(
  result: AnalyticsEvaluateResult,
  input: { now: Date; cooldownMs: number; idempotencyKey: string; packetHash?: string }
): AnalyticsDecisionRecord | undefined {
  const probaCampaignId = result.scope.probaCampaignId ?? result.snapshots[0]?.probaCampaignId ?? result.snapshots[0]?.campaignId;
  if (!probaCampaignId || !result.asOf) return undefined;
  return {
    workspaceId: result.scope.workspaceId,
    userId: result.scope.userId,
    probaCampaignId,
    goalId: result.scope.goalId,
    decisionId: result.decisionId,
    outcome: result.outcome,
    asOf: result.asOf,
    campaignDecisionVersion: result.campaignDecisionVersion ?? result.asOf,
    cooldownUntil: new Date(input.now.getTime() + input.cooldownMs).toISOString(),
    idempotencyKey: input.idempotencyKey,
    argsHash: result.proposal?.argsHash,
    occurredAt: input.now.toISOString(),
    packetHash: input.packetHash,
  };
}
