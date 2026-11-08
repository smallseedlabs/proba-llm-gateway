/**
 * Typed preflight outcomes. Provider/ad spend, LLM service quota, and Proba
 * run token/cost budgets are distinct claims. Balance is `verified` only when
 * an authoritative Ads-domain adapter says so — never inferred from config
 * or /ready.
 */

import { z } from 'zod';
import type { AdPlatform } from './limbs.js';

export const capabilityStateSchema = z.enum([
  'ready',
  'missing',
  'unavailable',
  'unauthorized',
  'unknown',
  'stale',
  'insufficient',
]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const billingModeSchema = z.enum(['billing_eligibility', 'exact_balance', 'none']);
export type BillingMode = z.infer<typeof billingModeSchema>;

export const unknownBalancePolicySchema = z.enum(['refuse_mutating']);
export type UnknownBalancePolicy = z.infer<typeof unknownBalancePolicySchema>;

export const billingRequirementSchema = z.enum(['billing_eligibility', 'exact_balance']);
export type BillingRequirement = z.infer<typeof billingRequirementSchema>;

export const balanceClaimKindSchema = z.enum(['verified', 'unsupported', 'unknown', 'unavailable', 'not_queried']);
export type BalanceClaimKind = z.infer<typeof balanceClaimKindSchema>;

export const adsBillingClaimSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('verified'),
        mode: z.enum(['billing_eligibility', 'exact_balance']),
        eligible: z.boolean(),
        asOf: z.string().datetime(),
        source: z.literal('ads_domain'),
        currency: z.string().min(1).max(8).optional(),
        amount: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('unsupported'),
        lockedPolicy: unknownBalancePolicySchema,
        reason: z.string().min(1),
      })
      .strict(),
    z.object({ kind: z.literal('unknown'), reason: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('not_queried') }).strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.kind === 'verified' && value.mode !== 'exact_balance' && value.amount !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount is only valid with exact_balance' });
    }
  });
export type AdsBillingClaim = z.infer<typeof adsBillingClaimSchema>;

export const adsPreflightReportSchema = z
  .object({
    asOf: z.string().datetime(),
    freshUntil: z.string().datetime(),
    service: z
      .object({
        state: z.enum(['ready', 'missing', 'unavailable', 'unknown']),
        message: z.string().optional(),
      })
      .strict(),
    connection: z
      .object({
        state: z.enum(['ready', 'missing', 'unauthorized', 'unknown', 'unavailable']),
        platform: z.enum(['reddit', 'microsoft', 'google', 'meta']).optional(),
        message: z.string().optional(),
      })
      .strict(),
    permissions: z
      .object({
        state: z.enum(['ready', 'unauthorized', 'unknown', 'unavailable']),
        actions: z.array(z.string()).optional(),
        message: z.string().optional(),
      })
      .strict(),
    blueprint: z
      .object({
        state: z.enum(['ready', 'missing', 'unknown', 'not_required']),
        probaCampaignId: z.string().optional(),
        mapped: z.boolean().optional(),
        /** Observation only. Running/exists is never authorization. */
        running: z.boolean().optional(),
        message: z.string().optional(),
      })
      .strict(),
    billing: adsBillingClaimSchema,
  })
  .strict();
export type AdsPreflightReport = z.infer<typeof adsPreflightReportSchema>;

export const llmPricingClaimSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('verified'),
      promptUsdPerMillion: z.number().positive(),
      completionUsdPerMillion: z.number().positive(),
      version: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('unknown'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
]);
export type LlmPricingClaim = z.infer<typeof llmPricingClaimSchema>;

export const llmQuotaClaimSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('verified'),
      eligible: z.boolean(),
      asOf: z.string().datetime(),
      source: z.literal('proba-llm'),
    })
    .strict(),
  z.object({ kind: z.literal('unknown'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
]);
export type LlmQuotaClaim = z.infer<typeof llmQuotaClaimSchema>;

export const runBudgetClaimSchema = z
  .object({
    kind: z.literal('local_run_budget'),
    eligible: z.boolean(),
    message: z.string().optional(),
  })
  .strict();
export type RunBudgetClaim = z.infer<typeof runBudgetClaimSchema>;

export const capabilityNeedSchema = z
  .object({
    type: z.literal('capability'),
    capability: z.enum([
      'intent',
      'auth.workspace',
      'limb.manifest',
      'ads.service',
      'ads.connection',
      'ads.permissions',
      'ads.blueprint',
      'ads.billing',
      'llm.service',
      'llm.quota',
      'context.ready',
      'run.budget',
      'research.accepted',
    ]),
    state: capabilityStateSchema,
    claim: balanceClaimKindSchema.optional(),
    billingMode: billingModeSchema.optional(),
    message: z.string(),
    question: z.string().optional(),
  })
  .strict();
export type CapabilityNeed = z.infer<typeof capabilityNeedSchema>;

export interface AdsPreflightQuery {
  workspaceId: string;
  userId: string;
  goalId?: string;
  verb?: string;
  platform?: AdPlatform;
  probaCampaignId?: string;
  mappingRequired: boolean;
  signal?: AbortSignal;
}

export const spendClassSchema = z.enum(['none', 'safety_decrease', 'spend_increase']);
export type SpendClass = z.infer<typeof spendClassSchema>;

export const runPhaseSchema = z.enum(['brain', 'mutate']);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const prerequisiteIdSchema = z.enum([
  'intent',
  'auth.workspace',
  'run.budget',
  'limb.manifest',
  'ads.service',
  'ads.connection',
  'ads.permissions',
  'ads.blueprint',
  'ads.billing',
  'llm.quota',
  'context.ready',
  'research.accepted',
]);
export type PrerequisiteId = z.infer<typeof prerequisiteIdSchema>;

export type OperationIntent =
  | {
      kind: 'insufficient_intent';
      questions: string[];
      spendClass: 'none';
    }
  | {
      kind: 'read_or_plan';
      requiresAds: false;
      requiresPage: boolean;
      spendClass: 'none';
    }
  | {
      kind: 'page_mutate';
      requiresPage: true;
      requiresAds: false;
      spendClass: 'none';
    }
  | {
      kind: 'ads_mutate';
      requiresAds: true;
      requiresPage: boolean;
      verb?: string;
      platform?: AdPlatform;
      probaCampaignId?: string;
      mappingRequired: boolean;
      spendClass: SpendClass;
    }
  | {
      kind: 'research_mutate';
      requiresAds: false;
      requiresPage: false;
      spendClass: 'none';
    };

export interface PrerequisiteEvidence {
  id: PrerequisiteId;
  workspaceId: string;
  accountKey: string;
  operationId: string;
  observedAt: string;
  freshUntil: string;
  result: 'ready' | 'blocked' | 'relaxed' | 'unknown';
  reason: string;
}

export interface RelaxedCheck {
  capability: CapabilityNeed['capability'];
  reason: string;
}

export interface OperationManifest {
  id: string;
  phase: RunPhase;
  spendClass: SpendClass;
  requires: readonly PrerequisiteId[];
}

export interface PreflightDecision {
  allowed: boolean;
  intent: OperationIntent;
  manifest: OperationManifest;
  ads?: AdsPreflightReport;
  llmQuota: LlmQuotaClaim;
  runBudget: RunBudgetClaim;
  needs: CapabilityNeed[];
  relaxed: RelaxedCheck[];
  evidence: PrerequisiteEvidence[];
  evaluated: Array<{ id: PrerequisiteId; reused: boolean; result: PrerequisiteEvidence['result'] }>;
  offeredLimbs: readonly string[];
  asOf: string;
}
