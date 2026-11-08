import type { HubRunRequest } from '../types/run.js';
import { AD_PLATFORMS } from '../types/limbs.js';
import type { AnalyticsReviewIntent, AnalyticsScope } from './types.js';

const REVIEW_INTENTS = new Set<AnalyticsReviewIntent>(['report', 'propose_pause', 'propose_cap']);

function asPlatform(value: unknown): string | undefined {
  return typeof value === 'string' && (AD_PLATFORMS as readonly string[]).includes(value) ? value : undefined;
}

export function analyticsScopeFromRequest(request: HubRunRequest): AnalyticsScope & {
  reviewIntent: AnalyticsReviewIntent;
  dailyBudget?: number;
  currentDailyBudget?: number;
  currency?: string;
} {
  const payload = request.command.payload;
  const row =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const reviewIntentRaw = row.reviewIntent;
  const reviewIntent: AnalyticsReviewIntent =
    typeof reviewIntentRaw === 'string' && REVIEW_INTENTS.has(reviewIntentRaw as AnalyticsReviewIntent)
      ? (reviewIntentRaw as AnalyticsReviewIntent)
      : 'report';
  const dailyBudget = typeof row.dailyBudget === 'number' && Number.isFinite(row.dailyBudget) ? row.dailyBudget : undefined;
  const currentDailyBudget =
    typeof row.currentDailyBudget === 'number' && Number.isFinite(row.currentDailyBudget) ? row.currentDailyBudget : undefined;
  const currency = typeof row.currency === 'string' && row.currency.trim() !== '' ? row.currency.trim() : undefined;
  return {
    workspaceId: request.workspaceId,
    userId: request.userId,
    goalId: request.goalId,
    probaCampaignId: typeof row.probaCampaignId === 'string' ? row.probaCampaignId : undefined,
    platform: asPlatform(row.platform),
    accountId: typeof row.accountId === 'string' ? row.accountId : undefined,
    providerCampaignId: typeof row.providerCampaignId === 'string' ? row.providerCampaignId : undefined,
    reviewIntent,
    dailyBudget,
    currentDailyBudget,
    currency,
  };
}
