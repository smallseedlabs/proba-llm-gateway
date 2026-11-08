import { mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ResearchArtifactStore } from '../ports/research.js';
import type { ResearchBinding } from './input.js';
import { researchBindingKey } from './input.js';
import { researchArtifactSchema, type ResearchArtifact } from '../types/research.js';

/**
 * Local file artifact store. Same single-replica caveat as FileRunStore.
 * Not a protocol DB and not shared across Swarm replicas.
 */
export class FileResearchStore implements ResearchArtifactStore {
  constructor(private readonly dir: string) {}

  async get(binding: ResearchBinding, inputRevision: string): Promise<ResearchArtifact | undefined> {
    try {
      const raw = await readFile(this.pathOf(binding, inputRevision), 'utf8');
      const parsed = researchArtifactSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async put(artifact: ResearchArtifact): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathOf(
      {
        workspaceId: artifact.workspaceId,
        userId: artifact.userId,
        goalId: artifact.goalId,
        threadId: artifact.threadId,
      },
      artifact.inputRevision
    );
    const tmp = `${path}.${process.pid}.tmp`;
    const buf = Buffer.from(JSON.stringify(artifact), 'utf8');
    const fd = openSync(tmp, 'w');
    try {
      let offset = 0;
      while (offset < buf.length) {
        offset += writeSync(fd, buf, offset, buf.length - offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    await rename(tmp, path);
    const committed = openSync(path, 'r+');
    try {
      fsyncSync(committed);
    } finally {
      closeSync(committed);
    }
    try {
      await unlink(tmp);
    } catch {
      // renamed
    }
  }

  async list(binding: ResearchBinding): Promise<ResearchArtifact[]> {
    try {
      const prefix = researchBindingKey(binding);
      const names = (await readdir(this.dir)).filter((name) => name.startsWith(prefix) && name.endsWith('.json'));
      const out: ResearchArtifact[] = [];
      for (const name of names) {
        const raw = await readFile(join(this.dir, name), 'utf8');
        const parsed = researchArtifactSchema.safeParse(JSON.parse(raw));
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async close(): Promise<void> {
    // files persist
  }

  private pathOf(binding: ResearchBinding, inputRevision: string): string {
    return join(this.dir, `${researchBindingKey(binding)}.${inputRevision}.json`);
  }
}
