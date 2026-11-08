import type { RunRecord, RunStore } from '../ports/run-store.js';

/** In-memory run store. Refused when NODE_ENV=production. */
export class MemoryRunStore implements RunStore {
  private readonly records = new Map<string, RunRecord>();
  private readonly byRunId = new Map<string, string>();

  constructor(nodeEnv: string = process.env.NODE_ENV ?? 'development') {
    if (nodeEnv === 'production') {
      throw new Error('MemoryRunStore is not allowed when NODE_ENV=production');
    }
  }

  async get(key: string): Promise<RunRecord | undefined> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : undefined;
  }

  async getByRunId(runId: string): Promise<RunRecord | undefined> {
    const key = this.byRunId.get(runId);
    return key ? this.get(key) : undefined;
  }

  async put(record: RunRecord): Promise<void> {
    this.records.set(record.key, structuredClone(record));
    this.byRunId.set(record.runId, record.key);
  }

  async unpublished(): Promise<RunRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.events.some((e) => !r.publishedEventIds.includes(e.eventId)))
      .map((r) => structuredClone(r));
  }

  async markPublished(key: string, eventId: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;
    if (!record.publishedEventIds.includes(eventId)) record.publishedEventIds.push(eventId);
  }

  async close(): Promise<void> {
    this.records.clear();
    this.byRunId.clear();
  }
}
