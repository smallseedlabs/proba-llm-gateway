/**
 * Schema, permission and allowlist checks. Separated from provider adapters.
 * A deny here is final: the executor must not be called.
 */

import type { VerbDefinition } from '../types/limbs.js';
import type { CreativeRules } from '../limbs/creative-draft.js';

export interface PolicyContext {
  workspaceId: string;
  userId: string;
  goalId?: string;
  threadId?: string;
  userSuppliedInput?: { landingPageUrl: string; creative?: Record<string, unknown>; targeting?: Record<string, unknown> };
  /** Accepted research for this goal and landing URL (creative.draft_post claims must cite its findings). */
  acceptedResearch?: {
    artifactId: string;
    version: number;
    findingIds: readonly string[];
    brandNames?: readonly string[];
    imageUrls?: readonly string[];
  };
  /** Effective creative rules after operator guardrails (tighten-only). */
  creativeRules?: CreativeRules;
}

export type PolicyDecision =
  | { allowed: true; verb: VerbDefinition; args: Record<string, unknown> }
  | { allowed: false; code: 'schema' | 'allowlist' | 'permission' | 'unknown_verb' | 'user_input' | 'creative_missing' | 'creative_invalid' | 'research_not_accepted'; reason: string };

export interface PolicyEngine {
  evaluate(toolName: string, rawArgs: unknown, ctx: PolicyContext): PolicyDecision;
}
