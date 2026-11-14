import { describe, expect, it } from 'vitest';
import { CHECKPOINT_VERB, checkReviewCall, effectiveReviewBounds, REVIEW_LOCKS, REVIEW_VERB, type ReviewFacts } from './review.js';

const now = new Date('2026-11-14T10:00:00.000Z');
const facts: ReviewFacts = {
  probaCampaignId: 'camp-1',
  currentDailyBudget: 5,
  currency: 'USD',
  hasAuditedMetrics: true,
  bounds: effectiveReviewBounds(),
  now,
};
const base = {
  summary: '80 clicks at 0.53 USD CPC over 7 days.',
  whyNowOrNotYet: 'Only 3 days of data after the last change; too early to judge.',
  nextCheckInHours: 48,
  nextCheckReason: 'two more days of clicks',
};

describe('reviewer outer bounds (tighten-only)', () => {
  it('only narrows the code locks; a min above the max checks sooner', () => {
    expect(effectiveReviewBounds()).toEqual({ ...REVIEW_LOCKS });
    expect(effectiveReviewBounds({ minCheckHours: 0.1, maxCheckHours: 999, maxAutoChangePct: 80 })).toEqual({ ...REVIEW_LOCKS });
    expect(effectiveReviewBounds({ minCheckHours: 6, maxCheckHours: 72 }, { maxAutoChangePct: 10 })).toEqual({ minCheckHours: 6, maxCheckHours: 72, maxAutoChangePct: 10 });
    expect(effectiveReviewBounds({ minCheckHours: 48 }, { maxCheckHours: 24 })).toMatchObject({ minCheckHours: 24, maxCheckHours: 24 });
  });

  it('clamps the next check into the bounds instead of refusing', () => {
    const r = checkReviewCall(REVIEW_VERB, { ...base, decision: 'wait', nextCheckInHours: 1000 }, facts);
    expect(r.ok && r.note.nextCheckInHours).toBe(168);
    expect(r.ok && r.note.clamped).toBe(true);
    expect(r.ok && r.note.nextCheckAt).toBe('2026-11-21T10:00:00.000Z');
  });
});

describe('analytics.review_campaign', () => {
  it('records a wait note with no change', () => {
    const r = checkReviewCall(REVIEW_VERB, { ...base, decision: 'wait', working: ['CTR 1.6%'], notWorking: [] }, facts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).toMatchObject({ kind: 'review', decision: 'wait', probaCampaignId: 'camp-1', nextCheckInHours: 48, clamped: false });
    expect(r.note.proposal).toBeUndefined();
  });

  it('turns a budget decrease into a dry-run proposal and marks it within the auto limit', () => {
    const r = checkReviewCall(REVIEW_VERB, { ...base, decision: 'change', change: { action: 'lower_budget', dailyBudget: 4 } }, facts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note.proposal).toMatchObject({ verb: 'ads.update_campaign', dryRun: true, grantsSpend: false, changePct: 20, withinAutoLimit: true });
    expect(r.note.proposal?.args).toEqual({ probaCampaignId: 'camp-1', dailyBudget: 4, currency: 'USD' });
    const big = checkReviewCall(REVIEW_VERB, { ...base, decision: 'change', change: { action: 'lower_budget', dailyBudget: 2 } }, facts);
    expect(big.ok && big.note.proposal?.withinAutoLimit).toBe(false);
  });

  it('refuses increases, unknown budgets, other campaigns and mismatched decisions', () => {
    expect(checkReviewCall(REVIEW_VERB, { ...base, decision: 'change', change: { action: 'lower_budget', dailyBudget: 6 } }, facts).ok).toBe(false);
    expect(checkReviewCall(REVIEW_VERB, { ...base, decision: 'change', change: { action: 'raise_budget', dailyBudget: 6 } }, facts).ok).toBe(false);
    const unknown = { ...facts, currentDailyBudget: undefined };
    const r = checkReviewCall(REVIEW_VERB, { ...base, decision: 'change', change: { action: 'lower_budget', dailyBudget: 1 } }, unknown);
    expect(!r.ok && r.reason).toMatch(/unknown/);
    expect(checkReviewCall(REVIEW_VERB, { ...base, decision: 'keep', probaCampaignId: 'other' }, facts).ok).toBe(false);
    expect(checkReviewCall(REVIEW_VERB, { ...base, decision: 'change' }, facts).ok).toBe(false);
    expect(checkReviewCall(REVIEW_VERB, { ...base, decision: 'keep', change: { action: 'pause' } }, facts).ok).toBe(false);
    expect(checkReviewCall(REVIEW_VERB, { ...base, decision: 'keep', whyNowOrNotYet: '' }, facts).ok).toBe(false);
  });
});

describe('analytics.report_checkpoint', () => {
  const cp = { ...base, checkpoint: 'day3', metric: 'clicks', target: 200, actual: 80, status: 'behind', recommendation: 'adjust', tweaks: ['try r/hiking'] };

  it('records target vs actual', () => {
    const r = checkReviewCall(CHECKPOINT_VERB, cp, facts);
    expect(r.ok && r.note).toMatchObject({ kind: 'checkpoint', decision: 'keep', checkpoint: { checkpoint: 'day3', target: 200, actual: 80, status: 'behind' } });
  });

  it('never states a metric without audited numbers in context', () => {
    const none = { ...facts, hasAuditedMetrics: false };
    expect(checkReviewCall(CHECKPOINT_VERB, cp, none).ok).toBe(false);
    expect(checkReviewCall(CHECKPOINT_VERB, { ...cp, actual: null, status: 'unknown' }, none).ok).toBe(true);
  });

  it('a stop recommendation must carry a pause the operator can approve', () => {
    expect(checkReviewCall(CHECKPOINT_VERB, { ...cp, recommendation: 'stop' }, facts).ok).toBe(false);
    const r = checkReviewCall(CHECKPOINT_VERB, { ...cp, recommendation: 'stop', change: { action: 'pause' } }, facts);
    expect(r.ok && r.note.proposal?.verb).toBe('ads.pause_campaign');
    expect(r.ok && r.note.decision).toBe('change');
  });
});
