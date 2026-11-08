import { ConfigError } from '../errors.js';
import type { AnalyticsDecisionStore, AnalyticsDecisionBinding } from './store.js';
import type { AnalyticsDecisionRecord } from './types.js';

function keyOf(binding: AnalyticsDecisionBinding): string {
  return `${binding.workspaceId}\n${binding.userId}\n${binding.probaCampaignId}`;
}

/** FAKE in-process store. Production refuses this adapter. */
export class MemoryAnalyticsStore implements AnalyticsDecisionStore {
  private readonly rows = new Map<string, AnalyticsDecisionRecord>();

  constructor(env: string) {
    if (env === 'production') {
      throw new ConfigError('in-memory analytics decision store is not allowed when NODE_ENV=production');
    }
  }

  async get(binding: AnalyticsDecisionBinding): Promise<AnalyticsDecisionRecord | undefined> {
    return this.rows.get(keyOf(binding));
  }

  async put(record: AnalyticsDecisionRecord): Promise<void> {
    this.rows.set(keyOf(record), record);
  }

  async close(): Promise<void> {
    this.rows.clear();
  }
}
