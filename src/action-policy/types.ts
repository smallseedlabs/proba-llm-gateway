/**
 * Owner-controlled action policies. Decisions never grant spend.
 * Evaluator dry-run proposals are not authority to execute.
 */

import { z } from 'zod';
import { AD_PLATFORMS } from '../types/limbs.js';

export const actionPolicyModeSchema = z.enum(['deny', 'approval', 'auto_with_limits']);
export type ActionPolicyMode = z.infer<typeof actionPolicyModeSchema>;

export const actionPolicyScopeSchema = z
  .object({
    platform: z.enum(AD_PLATFORMS).optional(),
    accountId: z.string().min(1).max(128).optional(),
    probaCampaignId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ActionPolicyScope = z.infer<typeof actionPolicyScopeSchema>;

export const actionPolicyLimitsSchema = z
  .object({
    maxDailyBudget: z.number().positive().optional(),
    maxDecreasePct: z.number().min(0).max(1).optional(),
    cooldownMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ActionPolicyLimits = z.infer<typeof actionPolicyLimitsSchema>;

export const actionPolicyDocumentSchema = z
  .object({
    policyId: z.string().min(1).max(128),
    version: z.number().int().positive(),
    workspaceId: z.string().min(1),
    ownerUserId: z.string().min(1),
    publishedAt: z.string().min(1),
    verb: z.string().min(1).max(128),
    mode: actionPolicyModeSchema,
    scope: actionPolicyScopeSchema,
    limits: actionPolicyLimitsSchema.optional(),
    allowCrossProviderMove: z.literal(false),
    delegationEnabled: z.literal(false),
  })
  .strict();
export type ActionPolicyDocument = z.infer<typeof actionPolicyDocumentSchema>;

export interface ActionOutcomeRecord {
  workspaceId: string;
  userId: string;
  verb: string;
  probaCampaignId: string;
  argsHash: string;
  policyId: string | null;
  policyVersion: number | null;
  mode: ActionPolicyMode;
  outcome: 'denied' | 'approval_required' | 'auto_executed' | 'cooldown';
  occurredAt: string;
  cooldownUntil: string;
  grantsSpend: false;
}

export type ActionPolicyGateCode =
  | 'policy_deny'
  | 'cross_provider_move'
  | 'delegation_refused'
  | 'auto_spend_clamped'
  | 'proposal_bounds'
  | 'cooldown'
  | 'scope_mismatch'
  | 'invalid_document';

export interface ActionPolicyResult {
  mode: ActionPolicyMode | 'catalog';
  requiresHubApproval: boolean;
  grantsSpend: false;
  policyId: string | null;
  policyVersion: number | null;
  clampedFromAuto: boolean;
  gate?: { code: ActionPolicyGateCode; message: string };
  immutable: {
    authIsolation: true;
    freshReadiness: true;
    runBudget: true;
    researchUrlAcceptance: true;
  };
}

export const IMMUTABLE_GATES = {
  authIsolation: true as const,
  freshReadiness: true as const,
  runBudget: true as const,
  researchUrlAcceptance: true as const,
};
