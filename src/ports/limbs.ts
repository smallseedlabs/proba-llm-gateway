/**
 * Limb execution port. The LLM never implements this.
 *
 * Runtime executors that are not test doubles MUST fail closed when no
 * domain adapter is configured. Returning a successful result without
 * performing the real side effect is forbidden.
 */

import type { VerbDefinition } from '../types/limbs.js';
import type { ApprovalDecision } from './approval.js';

export interface LimbCall {
  callId: string;
  verb: VerbDefinition;
  args: Record<string, unknown>;
  /** Required for side-effecting verbs; retries reuse it and never re-execute on completed/ambiguous. */
  idempotencyKey: string;
}

export interface LimbExecutionContext {
  workspaceId: string;
  userId: string;
  goalId?: string;
  threadId?: string;
  traceId: string;
  signal: AbortSignal;
  approval: ApprovalDecision;
  /** Durable domain state for this run (page URL, Proba campaign ids). */
  domainState: Record<string, unknown>;
}

export type LimbResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string };

export interface LimbExecutor {
  readonly name: string;
  execute(call: LimbCall, ctx: LimbExecutionContext): Promise<LimbResult>;
}
