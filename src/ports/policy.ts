/**
 * Schema, permission and allowlist checks. Separated from provider adapters.
 * A deny here is final: the executor must not be called.
 */

import type { VerbDefinition } from '../types/limbs.js';

export interface PolicyContext {
  workspaceId: string;
  userId: string;
  goalId?: string;
}

export type PolicyDecision =
  | { allowed: true; verb: VerbDefinition; args: Record<string, unknown> }
  | { allowed: false; code: 'schema' | 'allowlist' | 'permission' | 'unknown_verb'; reason: string };

export interface PolicyEngine {
  evaluate(toolName: string, rawArgs: unknown, ctx: PolicyContext): PolicyDecision;
}
