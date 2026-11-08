/**
 * Research executor/provider port. Context enrichment is not research.
 * Unconfigured implementations fail honestly and never invent citations.
 * Test doubles may return sourced fixtures only when NODE_ENV=test.
 */

import type { ResearchArtifact, ResearchAssumption, ResearchFinding, ResearchSource, ResearchUnknown } from '../types/research.js';
import type { ResearchBinding } from '../research/input.js';

export interface ResearchQuery {
  workspaceId: string;
  userId: string;
  goalId: string;
  threadId: string;
  landingPageUrl: string;
  signal?: AbortSignal;
}

export type ResearchProviderResult =
  | {
      ok: true;
      sources: ResearchSource[];
      findings: ResearchFinding[];
      assumptions: ResearchAssumption[];
      unknowns: ResearchUnknown[];
    }
  | { ok: false; code: string; message: string };

export interface ResearchProviderPort {
  readonly name: string;
  readonly configured: boolean;
  research(query: ResearchQuery): Promise<ResearchProviderResult>;
}

export interface ResearchArtifactStore {
  get(binding: ResearchBinding, inputRevision: string): Promise<ResearchArtifact | undefined>;
  put(artifact: ResearchArtifact): Promise<void>;
  list(binding: ResearchBinding): Promise<ResearchArtifact[]>;
  close(): Promise<void>;
}
