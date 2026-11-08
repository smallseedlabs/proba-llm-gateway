import { describe, expect, it } from 'vitest';
import { evaluateAnalytics } from './evaluate.js';
import { sampleGate } from './gates.js';
import { fakeAnalyticsPacket, fakeCampaignMetricsData, FAKE_PROBA_CAMPAIGN } from '../testing/analytics.js';
import { testRunRequest } from '../testing/fixtures.js';
import type { AnalyticsEvaluatorConfig } from './types.js';

const config: AnalyticsEvaluatorConfig = {
  maxAgeMs: 6 * 60 * 60 * 1000,
  minImpressions: 100,
  minObservations: 12,
  minWindowCoverage: 0.5,
  cooldownMs: 60_000,
  maxProposalDailyBudget: 50,
  maxProposalDecreasePct: 0.5,
};

function req(payload: Record<string, unknown> = {}) {
  return testRunRequest({
    stepType: 'review_performance',
    command: {
      kind: 'command',
      clientMsgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      type: 'send_message',
      payload: { text: 'review', probaCampaignId: FAKE_PROBA_CAMPAIGN, platform: 'reddit', ...payload },
      sentAt: new Date().toISOString(),
    },
  });
}

describe('analytics evaluator (deterministic, no spend)', () => {
  it('reports sourced metrics and never treats missing numbers as zero', () => {
    const now = new Date();
    const result = evaluateAnalytics({
      request: req(),
      packet: fakeAnalyticsPacket({ asOf: now.toISOString() }),
      now,
      config,
      idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(result.outcome).toBe('report');
    expect(result.grantsSpend).toBe(false);
    expect(result.unknownMetrics).toEqual([]);
  });

  it('keeps null impressions unknown instead of a zero sample', () => {
    const snapshot = {
      kind: 'campaign_metrics' as const,
      workspaceId: 'seedbed',
      userId: '11111111-1111-4111-8111-111111111111',
      platform: 'reddit',
      accountId: 'a',
      campaignId: 'c',
      asOf: new Date().toISOString(),
      impressions: 'unknown' as const,
      clicks: 'unknown' as const,
      spend: 'unknown' as const,
      conversions: 'unknown' as const,
      observationCount: 'unknown' as const,
      sourceItemId: 'x',
    };
    expect(sampleGate(snapshot, 100, 12)?.code).toBe('unknown_sample');
  });

  it('blocks workspace/actor/provider scope mismatches', () => {
    const now = new Date();
    const packet = fakeAnalyticsPacket({ asOf: now.toISOString(), workspaceId: 'other-ws' });
    const result = evaluateAnalytics({
      request: req(),
      packet,
      now,
      config,
      idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect(result.outcome).toBe('blocked');
    expect(result.gate?.code).toBe('scope_workspace');
    expect(result.grantsSpend).toBe(false);
  });

  it('blocks account/campaign snapshots that are not in Hub scope', () => {
    const now = new Date();
    const result = evaluateAnalytics({
      request: req({ accountId: 'other-account' }),
      packet: fakeAnalyticsPacket({ asOf: now.toISOString() }),
      now,
      config,
      idempotencyKey: 'abababab-abab-4aba-8aba-abababababab',
    });
    expect(result.outcome).toBe('blocked');
    expect(result.gate?.code).toBe('scope_campaign');
    expect(result.grantsSpend).toBe(false);
  });

  it('no_action when Context has no_analytics_for_campaign', () => {
    const now = new Date();
    const packet = fakeAnalyticsPacket({
      asOf: now.toISOString(),
      gaps: [{ code: 'no_analytics_for_campaign', source: 'analytics', reason: 'none yet' }],
      data: fakeCampaignMetricsData({ kind: 'not_metrics' }),
    });
    const result = evaluateAnalytics({
      request: req(),
      packet,
      now,
      config,
      idempotencyKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    expect(result.outcome).toBe('no_action');
    expect(result.gate?.code).toBe('missing_metrics');
  });

  it('dry-run pause proposal does not execute or grant spend', () => {
    const now = new Date();
    const result = evaluateAnalytics({
      request: req({ reviewIntent: 'propose_pause' }),
      packet: fakeAnalyticsPacket({ asOf: now.toISOString() }),
      now,
      config,
      idempotencyKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    expect(result.outcome).toBe('dry_run_proposal');
    expect(result.proposal).toMatchObject({ dryRun: true, grantsSpend: false, verb: 'ads.pause_campaign' });
  });

  it('rejects a cap increase as a spend grant', () => {
    const now = new Date();
    const result = evaluateAnalytics({
      request: req({ reviewIntent: 'propose_cap', dailyBudget: 80, currentDailyBudget: 40 }),
      packet: fakeAnalyticsPacket({ asOf: now.toISOString() }),
      now,
      config,
      idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    expect(result.outcome).toBe('blocked');
    expect(result.gate?.code).toBe('proposal_bounds');
  });

  it('no_action when asOf is older than maxAgeMs (unknown is not treated as fresh)', () => {
    const now = new Date('2026-11-08T18:00:00.000Z');
    const result = evaluateAnalytics({
      request: req(),
      packet: fakeAnalyticsPacket({ asOf: '2026-11-07T00:00:00.000Z' }),
      now,
      config,
      idempotencyKey: '34343434-3434-4343-8343-343434343434',
    });
    expect(result.outcome).toBe('no_action');
    expect(result.gate?.code).toBe('stale');
  });

  it('allows a dry-run cap decrease that stays inside bounds and still grants no spend', () => {
    const now = new Date();
    const result = evaluateAnalytics({
      request: req({ reviewIntent: 'propose_cap', dailyBudget: 30, currentDailyBudget: 40, currency: 'USD' }),
      packet: fakeAnalyticsPacket({ asOf: now.toISOString() }),
      now,
      config,
      idempotencyKey: '12121212-1212-4121-8121-121212121212',
    });
    expect(result.outcome).toBe('dry_run_proposal');
    expect(result.grantsSpend).toBe(false);
    expect(result.proposal).toMatchObject({ dryRun: true, verb: 'ads.update_campaign' });
  });
});
