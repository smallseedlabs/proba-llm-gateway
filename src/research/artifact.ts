import { randomUUID } from 'node:crypto';
import type { ResearchArtifactStore } from '../ports/research.js';
import type { ResearchProviderResult } from '../ports/research.js';
import type { ResearchArtifact } from '../types/research.js';
import type { CapabilityNeed } from '../types/preflight.js';
import type { ResearchBinding } from './input.js';
import { inputRevisionForUrl } from './input.js';

export function sourcesAreComplete(result: Extract<ResearchProviderResult, { ok: true }>): boolean {
  if (result.sources.length === 0) return false;
  const ids = new Set(result.sources.map((row) => row.sourceId));
  return result.findings.every((finding) => finding.sourceIds.length > 0 && finding.sourceIds.every((id) => ids.has(id)));
}

export function canAccept(artifact: ResearchArtifact): boolean {
  if (artifact.status !== 'awaiting_acceptance' && artifact.status !== 'accepted') return false;
  if (artifact.sources.length === 0) return false;
  const ids = new Set(artifact.sources.map((row) => row.sourceId));
  return artifact.findings.every((finding) => finding.sourceIds.length > 0 && finding.sourceIds.every((id) => ids.has(id)));
}

export function nextVersion(existing: ResearchArtifact | undefined): number {
  return (existing?.version ?? 0) + 1;
}

export function artifactFromProvider(input: {
  binding: ResearchBinding;
  landingPageUrl: string;
  providerName: string;
  now: string;
  existing?: ResearchArtifact;
  result: ResearchProviderResult;
}): ResearchArtifact {
  const inputRevision = inputRevisionForUrl(input.landingPageUrl);
  const base = {
    artifactId: input.existing?.artifactId ?? randomUUID(),
    version: nextVersion(input.existing),
    workspaceId: input.binding.workspaceId,
    userId: input.binding.userId,
    goalId: input.binding.goalId,
    threadId: input.binding.threadId,
    landingPageUrl: input.landingPageUrl,
    inputRevision,
    providerName: input.providerName,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  if (!input.result.ok) {
    return {
      ...base,
      status: 'failed',
      sources: [],
      findings: [],
      assumptions: [],
      unknowns: [{ id: 'u-failed', text: input.result.message }],
      errorCode: input.result.code,
      errorMessage: input.result.message,
    };
  }
  if (!sourcesAreComplete(input.result)) {
    return {
      ...base,
      status: 'failed',
      sources: input.result.sources,
      findings: [],
      assumptions: input.result.assumptions,
      unknowns: [
        ...input.result.unknowns,
        { id: 'u-unsourced', text: 'Provider result omitted source provenance; findings were discarded' },
      ],
      errorCode: 'unsourced_findings',
      errorMessage: 'Research findings without source provenance are not stored',
    };
  }
  return {
    ...base,
    status: 'awaiting_acceptance',
    sources: input.result.sources,
    findings: input.result.findings,
    assumptions: input.result.assumptions,
    unknowns: input.result.unknowns,
  };
}

export async function acceptArtifact(
  store: ResearchArtifactStore,
  artifact: ResearchArtifact,
  askId: string,
  now: string
): Promise<ResearchArtifact | undefined> {
  if (!canAccept(artifact)) return undefined;
  const next: ResearchArtifact = {
    ...artifact,
    status: 'accepted',
    acceptedAt: now,
    acceptedByAskId: askId,
    updatedAt: now,
  };
  await store.put(next);
  return next;
}

export async function invalidateArtifact(
  store: ResearchArtifactStore,
  artifact: ResearchArtifact,
  now: string
): Promise<ResearchArtifact> {
  const next: ResearchArtifact = {
    ...artifact,
    status: 'invalidated',
    acceptedAt: undefined,
    acceptedByAskId: undefined,
    updatedAt: now,
  };
  await store.put(next);
  return next;
}

export function researchAcceptedNeed(artifact: ResearchArtifact | undefined, landingPageUrl: string | undefined): CapabilityNeed | undefined {
  if (!landingPageUrl) {
    return {
      type: 'capability',
      capability: 'research.accepted',
      state: 'missing',
      message:
        'ads.create_campaign requires Hub userSuppliedInput.landingPageUrl (exact user URL). Model-invented URLs are refused. There is no default landing URL',
      question: 'Collect the campaign landing page URL from the operator UI and send it as userSuppliedInput.landingPageUrl',
    };
  }
  if (!artifact) {
    return {
      type: 'capability',
      capability: 'research.accepted',
      state: 'missing',
      message:
        'No source-backed research artifact exists for this workspace/user/goal/thread and URL revision. Context packets are not research',
      question: 'Run research.gather against the user-supplied URL, then accept the current artifact before ads.create_campaign',
    };
  }
  if (artifact.status === 'failed') {
    return {
      type: 'capability',
      capability: 'research.accepted',
      state: 'unavailable',
      message: artifact.errorMessage ?? 'Research provider failed; citations were not invented',
    };
  }
  if (artifact.status === 'invalidated') {
    return {
      type: 'capability',
      capability: 'research.accepted',
      state: 'stale',
      message: 'Research acceptance was invalidated after an edit; gather and accept the current URL revision again',
    };
  }
  if (artifact.status !== 'accepted' || !canAccept(artifact)) {
    return {
      type: 'capability',
      capability: 'research.accepted',
      state: 'missing',
      message: 'The current research artifact is not accepted. ads.create_campaign cannot bypass review',
      question: 'Hub/web must present findings, assumptions, and unknowns for operator acceptance of this artifact version',
    };
  }
  if (artifact.landingPageUrl !== landingPageUrl) {
    return {
      type: 'capability',
      capability: 'research.accepted',
      state: 'stale',
      message: 'Accepted research URL does not match the current user-supplied landing page',
    };
  }
  return undefined;
}
