/**
 * Deterministic analytics evaluator types. Decisions never grant spend.
 * Missing/null metrics stay unknown — never coerced to 0.
 */

import { z } from 'zod';

export const analyticsOutcomeSchema = z.enum(['report', 'no_action', 'blocked', 'dry_run_proposal']);
export type AnalyticsOutcome = z.infer<typeof analyticsOutcomeSchema>;

export const analyticsReviewIntentSchema = z.enum(['report', 'propose_pause', 'propose_cap']);
export type AnalyticsReviewIntent = z.infer<typeof analyticsReviewIntentSchema>;

export const analyticsGateCodeSchema = z.enum([
  'scope_workspace',
  'scope_actor',
  'scope_campaign',
  'scope_provider',
  'missing_metrics',
  'unknown_freshness',
  'stale',
  'unknown_sample',
  'insufficient_sample',
  'unknown_coverage',
  'insufficient_coverage',
  'cooldown',
  'stale_decision',
  'proposal_bounds',
  'unknown_metric',
]);
export type AnalyticsGateCode = z.infer<typeof analyticsGateCodeSchema>;

export interface AnalyticsScope {
  workspaceId: string;
  userId: string;
  goalId?: string;
  probaCampaignId?: string;
  platform?: string;
  accountId?: string;
  providerCampaignId?: string;
}

export interface CampaignMetricsSnapshot {
  kind: 'campaign_metrics';
  workspaceId: string;
  userId: string;
  platform: string;
  accountId: string;
  /** Provider campaign id in Context/audit observations. */
  campaignId: string;
  /** Proba campaign id when the packet or Hub payload supplies it. */
  probaCampaignId?: string;
  asOf: string;
  window?: { from: string; to: string };
  currency?: string;
  impressions: number | 'unknown';
  clicks: number | 'unknown';
  spend: number | 'unknown';
  conversions: number | 'unknown';
  observationCount: number | 'unknown';
  sourceItemId: string;
}

export interface AnalyticsProposal {
  dryRun: true;
  grantsSpend: false;
  verb: 'ads.pause_campaign' | 'ads.update_campaign';
  args: Record<string, unknown>;
  argsHash: string;
}

export interface AnalyticsDecisionRecord {
  workspaceId: string;
  userId: string;
  probaCampaignId: string;
  goalId?: string;
  decisionId: string;
  outcome: AnalyticsOutcome;
  asOf: string;
  campaignDecisionVersion: string;
  cooldownUntil: string;
  idempotencyKey: string;
  argsHash?: string;
  occurredAt: string;
  packetHash?: string;
}

export interface AnalyticsEvaluateResult {
  outcome: AnalyticsOutcome;
  grantsSpend: false;
  decisionId: string;
  asOf: string | null;
  campaignDecisionVersion: string | null;
  scope: AnalyticsScope;
  unknownMetrics: string[];
  gate?: { code: AnalyticsGateCode; message: string };
  proposal?: AnalyticsProposal;
  snapshots: CampaignMetricsSnapshot[];
  reply: string;
}

export interface AnalyticsEvaluatorConfig {
  maxAgeMs: number;
  minImpressions: number;
  minObservations: number;
  minWindowCoverage: number;
  cooldownMs: number;
  maxProposalDailyBudget: number | null;
  maxProposalDecreasePct: number | null;
}
