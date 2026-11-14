/**
 * The campaign reviewer is NOT a separate service: it is a system-initiated run of the normal brain
 * loop (same self memory, context packet with AUDITED analytics, verbs and guardrails), started by Hub.
 * The brain judges when a change is warranted and when to look again; these checks only enforce the
 * outer bounds, which are tighten-only:
 *   - next check within [minCheckHours, maxCheckHours] (clamped, never refused);
 *   - changes it proposes are reversible decreases (pause or lower budget) and go to Hub as dry-run
 *     proposals; nothing here executes. withinAutoLimit marks a change no larger than maxAutoChangePct;
 *   - no metric value may be stated when the packet carries no audited analytics (unknown stays unknown).
 */

import { canonicalArgsHash } from '../audit/canonical.js';

export const REVIEW_VERB = 'analytics.review_campaign';
export const CHECKPOINT_VERB = 'analytics.report_checkpoint';
export const REVIEW_VERBS: readonly string[] = Object.freeze([REVIEW_VERB, CHECKPOINT_VERB]);

/** Code locks: guardrails and Hub may only narrow these (raise min, lower max, lower the auto change). */
export const REVIEW_LOCKS = Object.freeze({ minCheckHours: 1, maxCheckHours: 168, maxAutoChangePct: 20 });

export interface ReviewBounds {
  minCheckHours: number;
  maxCheckHours: number;
  maxAutoChangePct: number;
}

export type ReviewBoundsInput = Partial<ReviewBounds> | undefined;

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Stricter of the code locks, the operator guardrails and the Hub request. A min above the max checks sooner. */
export function effectiveReviewBounds(...layers: ReviewBoundsInput[]): ReviewBounds {
  let min: number = REVIEW_LOCKS.minCheckHours;
  let max: number = REVIEW_LOCKS.maxCheckHours;
  let pct: number = REVIEW_LOCKS.maxAutoChangePct;
  for (const layer of layers) {
    if (!layer) continue;
    const lmin = finitePositive(layer.minCheckHours);
    const lmax = finitePositive(layer.maxCheckHours);
    const lpct = finitePositive(layer.maxAutoChangePct);
    if (lmin !== undefined) min = Math.max(min, lmin);
    if (lmax !== undefined) max = Math.min(max, lmax);
    if (lpct !== undefined) pct = Math.min(pct, lpct);
  }
  if (min > max) min = max;
  return { minCheckHours: min, maxCheckHours: max, maxAutoChangePct: pct };
}

export const CHECKPOINTS = ['day3', 'day7', 'final'] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];
const DECISIONS = ['keep', 'change', 'wait'] as const;
const STATUSES = ['ahead', 'on_track', 'behind', 'unknown'] as const;
const RECOMMENDATIONS = ['continue', 'adjust', 'stop'] as const;
const CHANGES = ['pause', 'lower_budget'] as const;

export interface ReviewFacts {
  probaCampaignId?: string;
  currentDailyBudget?: number;
  currency?: string;
  /** True only when the context packet carries audited analytics for this campaign. */
  hasAuditedMetrics: boolean;
  bounds: ReviewBounds;
  now: Date;
}

export interface ReviewProposal {
  dryRun: true;
  grantsSpend: false;
  verb: 'ads.pause_campaign' | 'ads.update_campaign';
  args: Record<string, unknown>;
  argsHash: string;
  /** Percent decrease of the daily budget (100 for a pause). */
  changePct: number;
  withinAutoLimit: boolean;
}

export interface ReviewCheckpoint {
  checkpoint: Checkpoint;
  metric: string;
  target: number | null;
  actual: number | null;
  status: (typeof STATUSES)[number];
  recommendation: (typeof RECOMMENDATIONS)[number];
  tweaks: string[];
}

export interface ReviewNote {
  kind: 'review' | 'checkpoint';
  probaCampaignId: string;
  summary: string;
  working: string[];
  notWorking: string[];
  decision: (typeof DECISIONS)[number];
  whyNowOrNotYet: string;
  proposal?: ReviewProposal;
  checkpoint?: ReviewCheckpoint;
  nextCheckInHours: number;
  nextCheckAt: string;
  nextCheckReason: string;
  /** True when the brain asked for a time outside the bounds and it was moved inside. */
  clamped: boolean;
}

export type ReviewCheck = { ok: true; note: ReviewNote } | { ok: false; reason: string };

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

function list(value: unknown, maxItems: number, maxLen: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const t = text(item, maxLen);
    if (!t) return null;
    out.push(t);
  }
  return out;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function checkProposal(raw: unknown, facts: ReviewFacts, campaignId: string): ReviewProposal | string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'change must be an object {action, dailyBudget?}';
  const row = raw as Record<string, unknown>;
  const action = oneOf(row.action, CHANGES);
  if (!action) return 'change.action must be pause or lower_budget (increases and new launches need the operator, not the reviewer)';
  if (action === 'pause') {
    const args = { probaCampaignId: campaignId };
    return { dryRun: true, grantsSpend: false, verb: 'ads.pause_campaign', args, argsHash: canonicalArgsHash(args), changePct: 100, withinAutoLimit: false };
  }
  const current = facts.currentDailyBudget;
  if (current === undefined) return 'the current daily budget is unknown, so a budget change cannot be proposed (unknown is not zero)';
  const next = finitePositive(row.dailyBudget);
  if (next === undefined || next >= current) return `change.dailyBudget must be a positive decrease from the current ${current}`;
  const changePct = Math.round(((current - next) / current) * 10_000) / 100;
  const args = { probaCampaignId: campaignId, dailyBudget: next, ...(facts.currency ? { currency: facts.currency } : {}) };
  return {
    dryRun: true,
    grantsSpend: false,
    verb: 'ads.update_campaign',
    args,
    argsHash: canonicalArgsHash(args),
    changePct,
    withinAutoLimit: changePct <= facts.bounds.maxAutoChangePct,
  };
}

/** Validate a reviewer verb call and turn it into the note Hub stores (clamped next check, dry-run change). */
export function checkReviewCall(name: string, args: Record<string, unknown>, facts: ReviewFacts): ReviewCheck {
  const campaignId = text(args.probaCampaignId, 128) ?? facts.probaCampaignId;
  if (!campaignId) return { ok: false, reason: 'probaCampaignId is required' };
  if (facts.probaCampaignId && campaignId !== facts.probaCampaignId) {
    return { ok: false, reason: `this review is scoped to campaign ${facts.probaCampaignId}` };
  }
  const summary = text(args.summary, 600);
  if (!summary) return { ok: false, reason: 'summary is required (1-600 chars)' };
  const working = list(args.working, 5, 200);
  const notWorking = list(args.notWorking, 5, 200);
  if (!working || !notWorking) return { ok: false, reason: 'working/notWorking must be lists of up to 5 short strings' };
  const whyNowOrNotYet = text(args.whyNowOrNotYet, 400);
  if (!whyNowOrNotYet) return { ok: false, reason: 'whyNowOrNotYet is required: say why you act now, or why you are waiting' };
  const nextCheckReason = text(args.nextCheckReason, 200);
  if (!nextCheckReason) return { ok: false, reason: 'nextCheckReason is required' };
  const asked = finitePositive(args.nextCheckInHours);
  if (asked === undefined) return { ok: false, reason: 'nextCheckInHours must be a positive number' };
  const hours = Math.min(facts.bounds.maxCheckHours, Math.max(facts.bounds.minCheckHours, asked));

  const proposal = checkProposal(args.change, facts, campaignId);
  if (typeof proposal === 'string') return { ok: false, reason: proposal };

  let decision = oneOf(args.decision, DECISIONS);
  let checkpoint: ReviewCheckpoint | undefined;
  if (name === CHECKPOINT_VERB) {
    const cp = oneOf(args.checkpoint, CHECKPOINTS);
    const metric = text(args.metric, 64);
    const status = oneOf(args.status, STATUSES);
    const recommendation = oneOf(args.recommendation, RECOMMENDATIONS);
    const target = nullableNumber(args.target);
    const actual = nullableNumber(args.actual);
    const tweaks = list(args.tweaks, 5, 200);
    if (!cp || !metric || !status || !recommendation || target === undefined || actual === undefined || !tweaks) {
      return { ok: false, reason: 'checkpoint, metric, status, recommendation are required; target/actual are numbers or null; tweaks up to 5' };
    }
    if (!facts.hasAuditedMetrics && (actual !== null || status !== 'unknown')) {
      return { ok: false, reason: 'no audited metrics are in context: actual must be null and status unknown (never estimate metrics)' };
    }
    if (recommendation === 'stop' && proposal?.verb !== 'ads.pause_campaign') {
      return { ok: false, reason: 'a stop recommendation must carry change {action: "pause"} so the operator can approve it' };
    }
    checkpoint = { checkpoint: cp, metric, target, actual, status, recommendation, tweaks };
    decision = decision ?? (proposal ? 'change' : 'keep');
  }
  if (!decision) return { ok: false, reason: 'decision must be keep, change or wait' };
  if (proposal && decision !== 'change') return { ok: false, reason: 'a change needs decision "change"' };
  if (!proposal && decision === 'change') return { ok: false, reason: 'decision "change" needs a change {action, dailyBudget?}' };

  return {
    ok: true,
    note: {
      kind: checkpoint ? 'checkpoint' : 'review',
      probaCampaignId: campaignId,
      summary,
      working,
      notWorking,
      decision,
      whyNowOrNotYet,
      ...(proposal ? { proposal } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      nextCheckInHours: hours,
      nextCheckAt: new Date(facts.now.getTime() + hours * 3_600_000).toISOString(),
      nextCheckReason,
      clamped: hours !== asked,
    },
  };
}
