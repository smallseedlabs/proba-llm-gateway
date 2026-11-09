import type { ActionPolicyDocument, ActionOutcomeRecord } from './types.js';

export interface ActionPolicyBinding {
  workspaceId: string;
  ownerUserId: string;
  verb: string;
}

export interface ActionOutcomeBinding {
  workspaceId: string;
  userId: string;
  verb: string;
  probaCampaignId: string;
  argsHash: string;
}

export interface ActionPolicyStore {
  list(workspaceId: string): Promise<ActionPolicyDocument[]>;
  put(document: ActionPolicyDocument): Promise<void>;
  close(): Promise<void>;
}

export interface ActionOutcomeStore {
  get(binding: ActionOutcomeBinding): Promise<ActionOutcomeRecord | undefined>;
  put(record: ActionOutcomeRecord): Promise<void>;
  close(): Promise<void>;
}
