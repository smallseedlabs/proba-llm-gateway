export interface CampaignOutcomeInput {
  campaignId: string;
  goalId: string;
  platform: 'reddit' | 'meta' | 'google';
  objective: string;
  spendUsd: number;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  creativeFormat: 'IMAGE' | 'VIDEO' | 'TEXT';
  now?: Date;
}

export interface OwnOutcomeMemoryProposal {
  sourceKind: 'own_outcome';
  trust: number;
  status: 'approved';
  evidenceCampaignId: string;
  lastVerifiedAt: string;
  summary: string;
  metrics: {
    spendUsd: number;
    impressions: number | null;
    clicks: number | null;
    conversions: number | null;
    ctr: number | null;
  };
}

/**
 * Builds an own-outcome post-mortem memory proposal from real campaign metrics.
 * Requires non-zero impressions or spend before emitting; missing metrics stay null.
 */
export function buildOwnOutcomePostmortem(
  input: CampaignOutcomeInput
): OwnOutcomeMemoryProposal | null {
  if (input.spendUsd <= 0 && (input.impressions === null || input.impressions <= 0)) {
    return null;
  }
  const ctr =
    input.impressions !== null && input.impressions > 0 && input.clicks !== null
      ? Number((input.clicks / input.impressions).toFixed(4))
      : null;

  const ctrText = ctr !== null ? `${(ctr * 100).toFixed(2)}% CTR` : 'CTR unknown';
  const convText =
    input.conversions !== null ? `${input.conversions} conversions` : 'conversions unknown';

  return {
    sourceKind: 'own_outcome',
    trust: 0.85,
    status: 'approved',
    evidenceCampaignId: input.campaignId,
    lastVerifiedAt: (input.now ?? new Date()).toISOString(),
    summary: `[${input.platform}] ${input.creativeFormat} (${input.objective}) spent $${input.spendUsd.toFixed(2)}: ${ctrText}, ${convText}.`,
    metrics: {
      spendUsd: input.spendUsd,
      impressions: input.impressions,
      clicks: input.clicks,
      conversions: input.conversions,
      ctr,
    },
  };
}
