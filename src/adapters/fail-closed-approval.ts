/**
 * Hub-owned approval hook. Missing resume is pending, never granted.
 * `edit` is not treated as approve. Execution args stay the bound proposal;
 * resume.values are ignored. Test doubles may grant only with an explicit resume.
 */

import type { ApprovalDecision, ApprovalGate, ApprovalIntent } from '../ports/approval.js';
import type { ResumeApproval } from '../types/run.js';
import { canonicalArgsHash } from '../audit/canonical.js';

export class FailClosedApprovalGate implements ApprovalGate {
  decide(intent: ApprovalIntent, resume?: ResumeApproval): ApprovalDecision {
    if (!resume) return { status: 'pending' };
    if (resume.askId !== intent.askId) return { status: 'pending' };
    if (intent.argsHash !== canonicalArgsHash(intent.args)) return { status: 'pending' };
    if (resume.choice === 'approve' && resume.approved !== false) {
      return { status: 'granted', resume };
    }
    return { status: 'rejected', resume };
  }
}
