/**
 * User-approval hook. Hub owns the UI, pause, and emergency stop.
 *
 * This gate never silently approves. No resume in the request => pending.
 * Grant requires an authenticated Hub `resume` whose askId matches the bound
 * operation. Execution uses the bound args, never resume.values or LLM text.
 * Test doubles may grant only when the test supplies an explicit resume.
 */

import type { ResumeApproval } from '../types/run.js';
import type { VerbDefinition } from '../types/limbs.js';

export interface ApprovalIntent {
  askId: string;
  runId: string;
  workspaceId: string;
  verb: VerbDefinition;
  args: Record<string, unknown>;
  argsHash: string;
  risk: VerbDefinition['risk'];
}

export type ApprovalDecision =
  | { status: 'granted'; resume: ResumeApproval }
  | { status: 'rejected'; resume: ResumeApproval }
  | { status: 'pending' };

export interface ApprovalGate {
  decide(intent: ApprovalIntent, resume?: ResumeApproval): ApprovalDecision;
}
