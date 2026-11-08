/**
 * Resolve owner action policy. Cannot relax auth, isolation, freshness,
 * run.budget, or research/URL acceptance. Auto-with-limits never grants spend.
 */

import { spendClassForVerb } from '../preflight/graph.js';
import type { VerbDefinition } from '../types/limbs.js';
import type { HubRunRequest } from '../types/run.js';
import { ConfigError } from '../errors.js';
import {
  IMMUTABLE_GATES,
  actionPolicyDocumentSchema,
  type ActionOutcomeRecord,
  type ActionPolicyDocument,
  type ActionPolicyResult,
} from './types.js';

const SAFE_AUTO_VERBS = new Set(['ads.pause_campaign', 'ads.update_campaign']);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function assertPublishable(document: ActionPolicyDocument): void {
  const parsed = actionPolicyDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new ConfigError(`action policy document is invalid: ${parsed.error.issues[0]?.message ?? 'schema'}`);
  }
  if (document.delegationEnabled) {
    throw new ConfigError('delegation is disabled by default and cannot be activated on an action policy');
  }
  if (document.allowCrossProviderMove) {
    throw new ConfigError('cross-provider budget movement is a separate explicit action; it cannot be a policy side effect');
  }
  if (document.mode === 'auto_with_limits' && !SAFE_AUTO_VERBS.has(document.verb)) {
    throw new ConfigError(`auto_with_limits is not publishable for ${document.verb}; spend-increase stays approval/deny`);
  }
}

function scopeScore(doc: ActionPolicyDocument, args: Record<string, unknown>, request: HubRunRequest): number | undefined {
  const payload = asRecord(request.command.payload);
  const campaign = asString(args.probaCampaignId) ?? asString(payload?.probaCampaignId);
  const account = asString(args.accountId) ?? asString(payload?.accountId);
  const platform = asString(args.platform) ?? asString(payload?.platform);
  if (doc.scope.probaCampaignId && doc.scope.probaCampaignId !== campaign) return undefined;
  if (doc.scope.accountId && doc.scope.accountId !== account) return undefined;
  if (doc.scope.platform && doc.scope.platform !== platform) return undefined;
  let score = 0;
  if (doc.scope.probaCampaignId) score += 4;
  if (doc.scope.accountId) score += 2;
  if (doc.scope.platform) score += 1;
  return score;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function selectDocument(
  documents: ActionPolicyDocument[],
  request: HubRunRequest,
  verb: string,
  args: Record<string, unknown>
): ActionPolicyDocument | undefined {
  const eligible = documents.filter((doc) => {
    if (doc.workspaceId !== request.workspaceId) return false;
    if (doc.ownerUserId !== request.userId) return false;
    if (doc.verb !== verb) return false;
    if (doc.delegationEnabled || doc.allowCrossProviderMove) return false;
    return scopeScore(doc, args, request) !== undefined;
  });
  eligible.sort((a, b) => {
    const sa = scopeScore(a, args, request) ?? -1;
    const sb = scopeScore(b, args, request) ?? -1;
    if (sb !== sa) return sb - sa;
    return b.version - a.version;
  });
  return eligible[0];
}

function isCrossProviderMove(args: Record<string, unknown>): boolean {
  if (asString(args.fromPlatform) && asString(args.toPlatform) && args.fromPlatform !== args.toPlatform) return true;
  if (asString(args.targetPlatform) && asString(args.platform) && args.targetPlatform !== args.platform) return true;
  if (asString(args.sourceAccountId) && asString(args.accountId) && args.sourceAccountId !== args.accountId) return true;
  return false;
}

function currentDailyBudgetOf(args: Record<string, unknown>, request: HubRunRequest): number | undefined {
  const payload = asRecord(request.command.payload);
  // Catalog forbids currentDailyBudget on tool args (additionalProperties: false).
  // Unknown current is not zero: Hub/context payload must supply it.
  return asNumber(payload?.currentDailyBudget) ?? asNumber(args.currentDailyBudget);
}

function capDecreaseIssue(
  args: Record<string, unknown>,
  request: HubRunRequest,
  limits: ActionPolicyDocument['limits']
): { code: 'proposal_bounds'; message: string } | undefined {
  const dailyBudget = asNumber(args.dailyBudget);
  if (dailyBudget === undefined) {
    return {
      code: 'proposal_bounds',
      message: 'auto_with_limits on ads.update_campaign applies only to known cap decreases; name/URL/targeting stay Hub approval',
    };
  }
  if (asString(args.name) || asString(args.landingPageUrl)) {
    return {
      code: 'proposal_bounds',
      message: 'auto_with_limits cannot skip Hub approval for name or landing URL edits; exact URL acceptance is immutable',
    };
  }
  const current = currentDailyBudgetOf(args, request);
  if (current === undefined) {
    return { code: 'proposal_bounds', message: 'auto cap requires currentDailyBudget; unknown current is not zero' };
  }
  if (dailyBudget > current) {
    return { code: 'proposal_bounds', message: 'auto_with_limits cannot increase dailyBudget; that would grant spend' };
  }
  if (limits?.maxDailyBudget !== undefined && dailyBudget > limits.maxDailyBudget) {
    return { code: 'proposal_bounds', message: 'proposed dailyBudget exceeds policy maxDailyBudget' };
  }
  if (limits?.maxDecreasePct !== undefined && current > 0) {
    const pct = (current - dailyBudget) / current;
    if (pct > limits.maxDecreasePct) {
      return { code: 'proposal_bounds', message: 'proposed decrease exceeds policy maxDecreasePct' };
    }
  }
  return undefined;
}

function result(
  partial: Omit<ActionPolicyResult, 'grantsSpend' | 'immutable'>
): ActionPolicyResult {
  return { ...partial, grantsSpend: false, immutable: IMMUTABLE_GATES };
}

export function evaluateActionPolicy(input: {
  verb: VerbDefinition;
  args: Record<string, unknown>;
  request: HubRunRequest;
  documents: ActionPolicyDocument[];
  last?: ActionOutcomeRecord;
  now: Date;
}): ActionPolicyResult {
  if (input.verb.limb !== 'ads') {
    return result({
      mode: 'catalog',
      requiresHubApproval: input.verb.requiresApproval,
      policyId: null,
      policyVersion: null,
      clampedFromAuto: false,
    });
  }

  if (input.verb.name === 'ads.move_budget' || isCrossProviderMove(input.args)) {
    return result({
      mode: 'deny',
      requiresHubApproval: true,
      policyId: null,
      policyVersion: null,
      clampedFromAuto: false,
      gate: {
        code: 'cross_provider_move',
        message: 'cross-provider or cross-account budget movement is not a side effect; it requires an explicit separate authorization',
      },
    });
  }

  const match = selectDocument(input.documents, input.request, input.verb.name, input.args);
  const mode = match?.mode ?? 'approval';
  const spendClass = spendClassForVerb(input.verb.name, input.args);

  if (mode === 'deny') {
    return result({
      mode: 'deny',
      requiresHubApproval: true,
      policyId: match?.policyId ?? null,
      policyVersion: match?.version ?? null,
      clampedFromAuto: false,
      gate: { code: 'policy_deny', message: `${input.verb.name} is denied by owner policy` },
    });
  }

  if (mode === 'auto_with_limits') {
    if (!SAFE_AUTO_VERBS.has(input.verb.name) || (spendClass === 'spend_increase' && input.verb.name !== 'ads.update_campaign')) {
      return result({
        mode: 'approval',
        requiresHubApproval: true,
        policyId: match?.policyId ?? null,
        policyVersion: match?.version ?? null,
        clampedFromAuto: true,
        gate: {
          code: 'auto_spend_clamped',
          message: 'auto_with_limits cannot apply to spend-increase; Hub approval is still required and spend is not granted',
        },
      });
    }
    if (input.verb.name === 'ads.update_campaign') {
      const bounds = capDecreaseIssue(input.args, input.request, match?.limits);
      if (bounds) {
        return result({
          mode: 'approval',
          requiresHubApproval: true,
          policyId: match?.policyId ?? null,
          policyVersion: match?.version ?? null,
          clampedFromAuto: true,
          gate: bounds,
        });
      }
    }
    if (input.last) {
      const until = Date.parse(input.last.cooldownUntil);
      if (Number.isFinite(until) && input.now.getTime() < until) {
        return result({
          mode: 'deny',
          requiresHubApproval: true,
          policyId: match?.policyId ?? null,
          policyVersion: match?.version ?? null,
          clampedFromAuto: false,
          gate: { code: 'cooldown', message: `action ${input.verb.name} is in cooldown until ${input.last.cooldownUntil}` },
        });
      }
    }
    return result({
      mode: 'auto_with_limits',
      requiresHubApproval: false,
      policyId: match?.policyId ?? null,
      policyVersion: match?.version ?? null,
      clampedFromAuto: false,
    });
  }

  return result({
    mode: 'approval',
    requiresHubApproval: true,
    policyId: match?.policyId ?? null,
    policyVersion: match?.version ?? null,
    clampedFromAuto: false,
  });
}

export function campaignIdOf(args: Record<string, unknown>, request: HubRunRequest): string {
  const payload = asRecord(request.command.payload);
  return asString(args.probaCampaignId) ?? asString(payload?.probaCampaignId) ?? request.goalId ?? request.workspaceId;
}
