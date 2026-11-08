/**
 * FAKE: in-process owner action-policy fixtures for tests.
 * Does not call Hub, Ads, or a live permission API.
 */

import type { ActionPolicyDocument } from '../action-policy/types.js';
import { TEST_USER_ID } from './fixtures.js';

export const FAKE_ACTION_POLICY_LABEL = 'FAKE: in-process owner action policy fixture';
export const FAKE_POLICY_CAMPAIGN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

export function fakeActionPolicy(overrides: Partial<ActionPolicyDocument> = {}): ActionPolicyDocument {
  return {
    policyId: 'policy-pause-auto',
    version: 1,
    workspaceId: 'seedbed',
    ownerUserId: TEST_USER_ID,
    publishedAt: new Date().toISOString(),
    verb: 'ads.pause_campaign',
    mode: 'auto_with_limits',
    scope: { platform: 'reddit', probaCampaignId: FAKE_POLICY_CAMPAIGN },
    limits: { cooldownMs: 60_000, maxDecreasePct: 0.5 },
    allowCrossProviderMove: false,
    delegationEnabled: false,
    ...overrides,
  };
}
