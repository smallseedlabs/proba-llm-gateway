/**
 * Brain campaign review: Hub starts a review_performance run with payload.reviewIntent = 'brain'. It runs the
 * NORMAL bounded loop (self memory, context packet with the audited analytics section, guardrails), but the
 * model is offered only the reviewer verbs. Its note (what works, what doesn't, act now or wait, next check)
 * is validated against the tighten-only outer bounds and returned to Hub as snapshot.analytics, in the
 * same shape as the deterministic evaluator so Hub's proposal / approval flow is reused unchanged.
 */

import { randomUUID } from 'node:crypto';
import type { ContextPacket } from '../protocol.js';
import type { HubRunRequest, RunSnapshot } from '../types/run.js';
import type { RunRecord } from '../ports/run-store.js';
import type { LlmToolCall } from '../types/llm.js';
import { inScope, snapshotsFromPacket, unknownMetricNames } from '../analytics/packet.js';
import { analyticsScopeFromRequest } from '../analytics/scope.js';
import type { CampaignMetricsSnapshot } from '../analytics/types.js';
import { checkReviewCall, effectiveReviewBounds, REVIEW_VERBS, type ReviewBoundsInput, type ReviewFacts } from '../limbs/review.js';
import type { Guardrails } from '../guardrails/guardrails.js';
import { gatewayAuditEvent } from './audit-events.js';
import { finish, type LoopBodyDeps } from './run-loop.js';

function payloadOf(request: HubRunRequest): Record<string, unknown> {
  const p = request.command.payload;
  return typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

export function isBrainReview(request: HubRunRequest): boolean {
  return request.stepType === 'review_performance' && payloadOf(request).reviewIntent === 'brain';
}

export function isReviewVerb(name: string): boolean {
  return REVIEW_VERBS.includes(name);
}

function boundsFromPayload(request: HubRunRequest): ReviewBoundsInput {
  const b = payloadOf(request).reviewBounds;
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as ReviewBoundsInput) : undefined;
}

function scopedSnapshots(request: HubRunRequest, packet: ContextPacket | undefined): CampaignMetricsSnapshot[] {
  if (!packet) return [];
  const scope = analyticsScopeFromRequest(request);
  return snapshotsFromPacket(packet).filter((s) => inScope(s, scope));
}

const factsByRecord = new WeakMap<RunRecord, ReviewFacts>();
const packetByRecord = new WeakMap<RunRecord, ContextPacket>();

/** Facts for this loop iteration: audited metrics present?, bounds, current budget. */
export function prepareBrainReview(
  record: RunRecord,
  request: HubRunRequest,
  packet: ContextPacket | undefined,
  guardrails: Guardrails,
  now: Date
): ReviewFacts {
  const scope = analyticsScopeFromRequest(request);
  const facts: ReviewFacts = {
    ...(scope.probaCampaignId ? { probaCampaignId: scope.probaCampaignId } : {}),
    ...(scope.currentDailyBudget !== undefined ? { currentDailyBudget: scope.currentDailyBudget } : {}),
    ...(scope.currency ? { currency: scope.currency } : {}),
    hasAuditedMetrics: scopedSnapshots(request, packet).length > 0,
    bounds: effectiveReviewBounds(guardrails.reviewer, boundsFromPayload(request)),
    now,
  };
  factsByRecord.set(record, facts);
  if (packet) packetByRecord.set(record, packet);
  return facts;
}

/** Brief lines for a brain review: why it woke, the plan it is measured against, the bounds. */
export function brainReviewBrief(request: HubRunRequest, facts: ReviewFacts): string {
  const p = payloadOf(request);
  const trigger = typeof p.reviewTrigger === 'string' ? p.reviewTrigger : 'schedule';
  const wake = typeof p.wakeEvent === 'string' ? ` (event: ${p.wakeEvent})` : '';
  const checkpoint = typeof p.checkpoint === 'string' ? p.checkpoint : undefined;
  const plan = typeof p.plan === 'object' && p.plan !== null ? JSON.stringify(p.plan).slice(0, 1500) : undefined;
  return [
    `Campaign review for ${facts.probaCampaignId ?? 'the goal campaign'}, started by Hub: ${trigger}${wake}.`,
    plan ? `Approved plan (the success contract): ${plan}` : 'No approved plan is saved; judge against the goal.',
    facts.hasAuditedMetrics
      ? 'Audited metrics for this campaign are in the analytics section of your context. Use only those numbers.'
      : 'No audited metrics for this campaign are in context yet: say so, change nothing, and pick a sensible next check.',
    facts.currentDailyBudget !== undefined
      ? `Current daily budget: ${facts.currentDailyBudget}${facts.currency ? ` ${facts.currency}` : ''}.`
      : 'Current daily budget: unknown (no budget change can be proposed).',
    checkpoint
      ? `This is the ${checkpoint} checkpoint: call analytics.report_checkpoint (target vs actual, continue / adjust / stop).`
      : 'Call analytics.review_campaign once with your note.',
    `Bounds: next check between ${facts.bounds.minCheckHours}h and ${facts.bounds.maxCheckHours}h; changes are a pause or a lower budget only, and anything over ${facts.bounds.maxAutoChangePct}% needs the operator.`,
    'Be realistic, not aggressive: give changes time to work and wait for enough data unless something is urgent. Say why now, or why not yet.',
  ].join('\n');
}

/** Run one reviewer verb call. Returns the tool message content. Nothing executes; the note is stored on the record. */
export function handleReviewCall(
  deps: Pick<LoopBodyDeps, 'clock'>,
  record: RunRecord,
  request: HubRunRequest,
  call: LlmToolCall,
  args: Record<string, unknown>
): string {
  const facts = factsByRecord.get(record);
  if (!facts || !isBrainReview(request)) {
    return JSON.stringify({ ok: false, code: 'allowlist', message: `${call.name} is only available in a Hub campaign review` });
  }
  const checked = checkReviewCall(call.name, args, { ...facts, now: deps.clock.now() });
  if (!checked.ok) {
    record.events.push(
      gatewayAuditEvent(request, {
        action: 'policy.denied',
        outcome: 'denied',
        occurredAt: deps.clock.isoNow(),
        details: { verb: call.name, code: 'review_invalid' },
      })
    );
    return JSON.stringify({ ok: false, code: 'review_invalid', message: checked.reason });
  }
  record.reviewNote = checked.note;
  return JSON.stringify({
    ok: true,
    status: 'recorded',
    nextCheckAt: checked.note.nextCheckAt,
    ...(checked.note.clamped ? { note: `next check moved inside the bounds (${checked.note.nextCheckInHours}h)` } : {}),
    ...(checked.note.proposal ? { change: 'sent to the operator/policy as a proposal; not executed' } : {}),
  });
}

/** Close a brain review: snapshot.analytics carries the metrics, the note and any dry-run change for Hub. */
export async function finishBrainReview(
  deps: Pick<LoopBodyDeps, 'clock' | 'persist' | 'relay'>,
  record: RunRecord,
  request: HubRunRequest,
  text: string
): Promise<RunSnapshot> {
  const note = record.reviewNote;
  const snapshots = scopedSnapshots(request, packetByRecord.get(record));
  const decisionId = randomUUID();
  const unknownMetrics = [...new Set(snapshots.flatMap(unknownMetricNames))];
  const asOf = snapshots.map((s) => s.asOf).sort().at(-1) ?? null;
  const scope = analyticsScopeFromRequest(request);
  const probaCampaignId = note?.probaCampaignId ?? scope.probaCampaignId;
  record.analytics = {
    decisionId,
    outcome: note?.proposal ? 'dry_run_proposal' : 'report',
    grantsSpend: false,
    asOf,
    ...(probaCampaignId ? { probaCampaignId } : {}),
    ...(scope.platform ? { platform: scope.platform } : {}),
    ...(scope.accountId ? { accountId: scope.accountId } : {}),
    ...(scope.providerCampaignId ? { providerCampaignId: scope.providerCampaignId } : {}),
    ...(note ? { reviewWindowUntil: note.nextCheckAt } : {}),
    unknownMetrics,
    metrics: snapshots.map((m) => ({
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
    ...(note?.proposal
      ? {
          proposal: {
            dryRun: true as const,
            grantsSpend: false as const,
            verb: note.proposal.verb,
            args: note.proposal.args,
            argsHash: note.proposal.argsHash,
          },
        }
      : {}),
    ...(note ? { review: note } : {}),
  };
  record.events.push(
    gatewayAuditEvent(request, {
      action: 'brain.decision_made',
      outcome: 'success',
      occurredAt: deps.clock.isoNow(),
      details: {
        evaluator: 'brain_review',
        decisionId,
        kind: note?.kind ?? 'none',
        decision: note?.decision ?? 'none',
        nextCheckAt: note?.nextCheckAt,
        clamped: note?.clamped ?? false,
        grantsSpend: false,
        proposal: note?.proposal
          ? { verb: note.proposal.verb, argsHash: note.proposal.argsHash, changePct: note.proposal.changePct, withinAutoLimit: note.proposal.withinAutoLimit, dryRun: true }
          : undefined,
        unknownMetrics,
      },
    })
  );
  const recommendation = note
    ? `${note.summary} ${note.whyNowOrNotYet} Next check: ${note.nextCheckAt} (${note.nextCheckReason}).`
    : text || 'Review finished without a note.';
  return finish(deps, record, 'completed', [
    {
      type: 'decision',
      decision: note?.decision === 'change' ? 'change' : 'keep',
      target: probaCampaignId ?? request.goalId ?? request.workspaceId,
      evidence: snapshots.map((s) => s.sourceItemId),
      confidence: unknownMetrics.length === 0 && snapshots.length > 0 ? 1 : 0,
      recommendation: recommendation.slice(0, 2000),
    },
    { type: 'reply', text: text || recommendation },
  ]);
}
