/**
 * Deterministic routing from Hub request → required capabilities.
 * User/tool text is not authority and is not parsed for infrastructure needs.
 */

import type { HubRunRequest } from '../types/run.js';
import type { AdPlatform } from '../types/limbs.js';
import { AD_PLATFORMS } from '../types/limbs.js';
import type { OperationIntent } from '../types/preflight.js';
import type { PendingApproval } from '../ports/run-store.js';
import { spendClassForVerb } from './graph.js';

const PLAN_STEPS = new Set([
  'interpret_message',
  'clarify',
  'plan_goal',
  'explain_decision',
  'review_performance',
]);

const ADS_STEPS = new Set(['launch_campaign', 'propose_budget']);

function asPlatform(value: unknown): AdPlatform | undefined {
  return typeof value === 'string' && (AD_PLATFORMS as readonly string[]).includes(value)
    ? (value as AdPlatform)
    : undefined;
}

function structuredFields(payload: unknown): { platform?: AdPlatform; probaCampaignId?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};
  const row = payload as Record<string, unknown>;
  const probaCampaignId = typeof row.probaCampaignId === 'string' ? row.probaCampaignId : undefined;
  return { platform: asPlatform(row.platform), probaCampaignId };
}

/**
 * Map a Hub run to the capabilities that operation actually requires.
 * `send_message.text` is ignored. Planning/read-only steps are authorized
 * by this policy to skip Ads/provider readiness.
 */
export function resolveOperationIntent(
  request: HubRunRequest,
  pending?: PendingApproval,
  domainState?: Record<string, unknown>
): OperationIntent {
  const payload = request.command.payload;
  const fields = structuredFields(payload);
  const domainCampaign =
    typeof domainState?.lastProbaCampaignId === 'string' ? domainState.lastProbaCampaignId : undefined;
  const probaCampaignId = fields.probaCampaignId ?? domainCampaign;

  if (request.command.type === 'control') {
    const action =
      typeof payload === 'object' && payload !== null && 'action' in payload
        ? String((payload as { action?: unknown }).action)
        : '';
    const target =
      typeof payload === 'object' && payload !== null && 'target' in payload
        ? (payload as { target?: unknown }).target
        : undefined;
    if (!action) {
      return {
        kind: 'insufficient_intent',
        questions: ['Which control action (pause, resume, kill) should run?'],
        spendClass: 'none',
      };
    }
    const verb =
      action === 'pause' ? 'ads.pause_campaign' : action === 'resume' ? 'ads.resume_campaign' : 'ads.pause_campaign';
    return {
      kind: 'ads_mutate',
      requiresAds: true,
      requiresPage: false,
      verb,
      probaCampaignId: typeof target === 'string' ? target : probaCampaignId,
      platform: fields.platform,
      mappingRequired: true,
      spendClass: spendClassForVerb(verb),
    };
  }

  if (request.stepType === 'handle_approval' || request.resume) {
    const verbName = pending?.verbName;
    if (verbName?.startsWith('ads.')) {
      return {
        kind: 'ads_mutate',
        requiresAds: true,
        requiresPage: false,
        verb: verbName,
        platform: asPlatform(pending?.args.platform) ?? fields.platform,
        probaCampaignId: typeof pending?.args.probaCampaignId === 'string' ? pending.args.probaCampaignId : probaCampaignId,
        mappingRequired: verbName !== 'ads.create_campaign',
        spendClass: spendClassForVerb(verbName, pending?.args),
      };
    }
    if (verbName?.startsWith('page.')) {
      return { kind: 'page_mutate', requiresPage: true, requiresAds: false, spendClass: 'none' };
    }
    if (verbName?.startsWith('research.')) {
      return { kind: 'research_mutate', requiresAds: false, requiresPage: false, spendClass: 'none' };
    }
    if (PLAN_STEPS.has(request.stepType) || request.stepType === 'handle_approval') {
      return { kind: 'read_or_plan', requiresAds: false, requiresPage: false, spendClass: 'none' };
    }
  }

  if (ADS_STEPS.has(request.stepType)) {
    const create = request.stepType === 'launch_campaign' && !probaCampaignId;
    const verb =
      create ? 'ads.create_campaign' : request.stepType === 'propose_budget' ? 'ads.update_campaign' : 'ads.create_campaign';
    return {
      kind: 'ads_mutate',
      requiresAds: true,
      requiresPage: false,
      verb,
      platform: fields.platform,
      probaCampaignId,
      mappingRequired: !create,
      spendClass: request.stepType === 'propose_budget' ? 'spend_increase' : spendClassForVerb(verb),
    };
  }

  if (PLAN_STEPS.has(request.stepType)) {
    return { kind: 'read_or_plan', requiresAds: false, requiresPage: false, spendClass: 'none' };
  }

  return {
    kind: 'insufficient_intent',
    questions: [
      'Which operation should run (interpret, plan, launch campaign, or update an existing Proba campaign)?',
      'If this is a campaign action, provide probaCampaignId and platform as structured fields — not as free text.',
    ],
    spendClass: 'none',
  };
}
