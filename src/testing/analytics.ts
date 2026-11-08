/**
 * FAKE: in-process analytics Context fixtures for tests.
 * Does not call audit-api, providers, or a live crawler.
 */

import type { ContextPacket } from '../protocol.js';
import { testContextPacket, TEST_GOAL_ID, TEST_USER_ID } from './fixtures.js';

export const FAKE_ANALYTICS_LABEL = 'FAKE: in-process analytics context fixture';
export const FAKE_PROVIDER_CAMPAIGN = 'prov-camp-1';
export const FAKE_ACCOUNT = 'acct-1';
export const FAKE_PROBA_CAMPAIGN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

export function fakeCampaignMetricsData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: 'seedbed',
    userId: TEST_USER_ID,
    kind: 'campaign_metrics',
    window: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z' },
    platform: 'reddit',
    accountId: FAKE_ACCOUNT,
    campaignId: FAKE_PROVIDER_CAMPAIGN,
    probaCampaignId: FAKE_PROBA_CAMPAIGN,
    currency: 'USD',
    impressions: 5000,
    clicks: 80,
    spend: 42.5,
    conversions: 3,
    observationCount: 168,
    ...overrides,
  };
}

export function fakeAnalyticsPacket(overrides: {
  asOf?: string;
  data?: Record<string, unknown>;
  gaps?: ContextPacket['gaps'];
  workspaceId?: string;
  userId?: string;
} = {}): ContextPacket {
  const asOf = overrides.asOf ?? new Date().toISOString();
  return testContextPacket({
    workspaceId: overrides.workspaceId ?? 'seedbed',
    userId: overrides.userId ?? TEST_USER_ID,
    goalId: TEST_GOAL_ID,
    gaps: overrides.gaps ?? [],
    sections: [
      {
        kind: 'analytics',
        priority: 2,
        tokens: 40,
        items: [
          {
            itemId: 'fake.analytics.campaign',
            sourceRef: { source: 'fake-test-analytics', id: FAKE_PROVIDER_CAMPAIGN },
            trust: 'derived',
            observedAt: asOf,
            data: fakeCampaignMetricsData(overrides.data),
          },
        ],
      },
    ],
    manifest: {
      sources: { analytics: { requested: true, returned: 1, included: 1, dropped: 0, droppedReasons: {}, cacheHit: false, latencyMs: 1, tokens: 40 } },
      totals: { returned: 1, included: 1, dropped: 0, tokens: 40, gaps: overrides.gaps?.length ?? 0, latencyMs: 1 },
      droppedItemIds: [],
    },
  });
}
