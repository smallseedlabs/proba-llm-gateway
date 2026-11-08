import type { AnalyticsDecisionRecord } from './types.js';

export interface AnalyticsDecisionBinding {
  workspaceId: string;
  userId: string;
  probaCampaignId: string;
}

export interface AnalyticsDecisionStore {
  get(binding: AnalyticsDecisionBinding): Promise<AnalyticsDecisionRecord | undefined>;
  put(record: AnalyticsDecisionRecord): Promise<void>;
  close(): Promise<void>;
}
