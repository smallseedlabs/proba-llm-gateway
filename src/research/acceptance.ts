import type { ResumeApproval } from '../types/run.js';
import type { ResearchArtifact } from '../types/research.js';
import type { PendingApproval } from '../ports/run-store.js';
import { acceptArtifact, invalidateArtifact } from './artifact.js';
import type { ResearchArtifactStore } from '../ports/research.js';

export function isResearchAcceptPending(pending: PendingApproval | undefined): boolean {
  return pending?.verbName === 'research.accept';
}

export async function applyResearchResume(input: {
  store: ResearchArtifactStore;
  artifact: ResearchArtifact | undefined;
  pending: PendingApproval;
  resume: ResumeApproval;
  now: string;
}): Promise<'accepted' | 'rejected' | 'invalidated' | 'mismatch'> {
  const args = input.pending.args;
  if (
    !input.artifact ||
    input.artifact.artifactId !== args.artifactId ||
    input.artifact.version !== args.version ||
    input.artifact.inputRevision !== args.inputRevision
  ) {
    return 'mismatch';
  }
  if (input.resume.choice === 'approve' && input.resume.approved !== false) {
    const accepted = await acceptArtifact(input.store, input.artifact, input.resume.askId, input.now);
    return accepted ? 'accepted' : 'mismatch';
  }
  if (input.resume.choice === 'edit') {
    await invalidateArtifact(input.store, input.artifact, input.now);
    return 'invalidated';
  }
  return 'rejected';
}
