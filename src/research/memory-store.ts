import { ConfigError } from '../errors.js';
import type { ResearchArtifactStore } from '../ports/research.js';
import type { ResearchBinding } from './input.js';
import { researchBindingKey } from './input.js';
import type { ResearchArtifact } from '../types/research.js';

export class MemoryResearchStore implements ResearchArtifactStore {
  private readonly rows = new Map<string, ResearchArtifact>();

  constructor(env: string) {
    if (env === 'production') {
      throw new ConfigError('in-memory research artifact store is not allowed when NODE_ENV=production');
    }
  }

  async get(binding: ResearchBinding, inputRevision: string): Promise<ResearchArtifact | undefined> {
    return this.rows.get(this.key(binding, inputRevision));
  }

  async put(artifact: ResearchArtifact): Promise<void> {
    this.rows.set(
      this.key(
        {
          workspaceId: artifact.workspaceId,
          userId: artifact.userId,
          goalId: artifact.goalId,
          threadId: artifact.threadId,
        },
        artifact.inputRevision
      ),
      artifact
    );
  }

  async list(binding: ResearchBinding): Promise<ResearchArtifact[]> {
    const prefix = `${researchBindingKey(binding)}:`;
    return [...this.rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row);
  }

  async close(): Promise<void> {
    this.rows.clear();
  }

  private key(binding: ResearchBinding, inputRevision: string): string {
    return `${researchBindingKey(binding)}:${inputRevision}`;
  }
}
