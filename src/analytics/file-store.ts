import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify } from '../audit/canonical.js';
import type { AnalyticsDecisionStore, AnalyticsDecisionBinding } from './store.js';
import type { AnalyticsDecisionRecord } from './types.js';

/**
 * Local file decision store. Same single-replica caveat as FileRunStore.
 * Not a shared ClickHouse table and not Hub cadence state.
 */
export class FileAnalyticsStore implements AnalyticsDecisionStore {
  constructor(private readonly dir: string) {}

  async get(binding: AnalyticsDecisionBinding): Promise<AnalyticsDecisionRecord | undefined> {
    try {
      const raw = await readFile(this.pathOf(binding), 'utf8');
      return JSON.parse(raw) as AnalyticsDecisionRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async put(record: AnalyticsDecisionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathOf(record);
    const tmp = `${path}.${process.pid}.tmp`;
    const buf = Buffer.from(JSON.stringify(record), 'utf8');
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

  async close(): Promise<void> {
    // files persist
  }

  private pathOf(binding: AnalyticsDecisionBinding): string {
    const key = {
      workspaceId: binding.workspaceId,
      userId: binding.userId,
      probaCampaignId: binding.probaCampaignId,
    };
    const digest = createHash('sha256').update(stableStringify(key)).digest('hex');
    return join(this.dir, `${digest}.json`);
  }
}
