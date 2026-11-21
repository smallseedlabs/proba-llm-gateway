import { describe, expect, it } from 'vitest';
import { buildOwnOutcomePostmortem } from './postmortem.js';

describe('H4-06 own-outcome post-mortem memory proposal', () => {
  it('emits own_outcome memory proposal with evidenceCampaignId and preserves null metrics', () => {
    const empty = buildOwnOutcomePostmortem({
      campaignId: 'cmp-0',
      goalId: 'g-1',
      platform: 'reddit',
      objective: 'CLICKS',
      spendUsd: 0,
      impressions: null,
      clicks: null,
      conversions: null,
      creativeFormat: 'IMAGE',
    });
    expect(empty).toBeNull();

    const proposal = buildOwnOutcomePostmortem({
      campaignId: 'cmp-1',
      goalId: 'g-1',
      platform: 'reddit',
      objective: 'CLICKS',
      spendUsd: 24.5,
      impressions: 1200,
      clicks: 18,
      conversions: null,
      creativeFormat: 'VIDEO',
      now: new Date('2026-11-21T22:00:00Z'),
    });
    expect(proposal).not.toBeNull();
    expect(proposal).toMatchObject({
      sourceKind: 'own_outcome',
      trust: 0.85,
      status: 'approved',
      evidenceCampaignId: 'cmp-1',
      metrics: {
        spendUsd: 24.5,
        impressions: 1200,
        clicks: 18,
        conversions: null,
        ctr: 0.015,
      },
    });
  });
});
