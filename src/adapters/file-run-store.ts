import { mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord, RunStore } from '../ports/run-store.js';

/**
 * Local file outbox, analogous to proba-llm's turn store. Not a shared store:
 * Swarm replicas must stay 1 on one node labeled proba.gateway=true or a
 * retried key can re-enter the loop. fsync before resolve. This does not
 * prove durability of audit/DB and is not HA.
 */
export class FileRunStore implements RunStore {
  constructor(private readonly dir: string) {}

  private pathOf(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<RunRecord | undefined> {
    try {
      const raw = await readFile(this.pathOf(key), 'utf8');
      return JSON.parse(raw) as RunRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async getByRunId(runId: string): Promise<RunRecord | undefined> {
    const names = await this.jsonNames();
    for (const name of names) {
      const record = await this.get(name.slice(0, -5));
      if (record?.runId === runId) return record;
    }
    return undefined;
  }

  async put(record: RunRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathOf(record.key);
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
      // rename already moved it
    }
  }

  async unpublished(): Promise<RunRecord[]> {
    const names = await this.jsonNames();
    const out: RunRecord[] = [];
    for (const name of names) {
      const record = await this.get(name.slice(0, -5));
      if (record && record.events.some((e) => !record.publishedEventIds.includes(e.eventId))) out.push(record);
    }
    return out;
  }

  async markPublished(key: string, eventId: string): Promise<void> {
    const record = await this.get(key);
    if (!record) return;
    if (!record.publishedEventIds.includes(eventId)) {
      record.publishedEventIds.push(eventId);
      await this.put(record);
    }
  }

  async close(): Promise<void> {
    // files persist
  }

  private async jsonNames(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((name) => name.endsWith('.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
