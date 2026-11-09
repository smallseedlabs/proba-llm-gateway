import { ConfigError } from '../errors.js';
import { assertPublishable } from './evaluate.js';
import type { ActionOutcomeBinding, ActionOutcomeStore, ActionPolicyStore } from './store.js';
import type { ActionOutcomeRecord, ActionPolicyDocument } from './types.js';

function outcomeKey(binding: ActionOutcomeBinding): string {
  return `${binding.workspaceId}\n${binding.userId}\n${binding.verb}\n${binding.probaCampaignId}\n${binding.argsHash}`;
}

/** FAKE in-process stores. Production refuses these adapters. */
export class MemoryActionPolicyStore implements ActionPolicyStore {
  private readonly rows = new Map<string, ActionPolicyDocument>();

  constructor(env: string) {
    if (env === 'production') {
      throw new ConfigError('in-memory action policy store is not allowed when NODE_ENV=production');
    }
  }

  async list(workspaceId: string): Promise<ActionPolicyDocument[]> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId);
  }

  async put(document: ActionPolicyDocument): Promise<void> {
    assertPublishable(document);
    const current = this.rows.get(document.policyId);
    if (current && document.version !== current.version + 1) {
      throw new ConfigError(`action policy ${document.policyId} version must be ${current.version + 1}`);
    }
    if (!current && document.version !== 1) {
      throw new ConfigError(`action policy ${document.policyId} must start at version 1`);
    }
    this.rows.set(document.policyId, document);
  }

  async close(): Promise<void> {
    this.rows.clear();
  }
}

export class MemoryActionOutcomeStore implements ActionOutcomeStore {
  private readonly rows = new Map<string, ActionOutcomeRecord>();

  constructor(env: string) {
    if (env === 'production') {
      throw new ConfigError('in-memory action outcome store is not allowed when NODE_ENV=production');
    }
  }

  async get(binding: ActionOutcomeBinding): Promise<ActionOutcomeRecord | undefined> {
    return this.rows.get(outcomeKey(binding));
  }

  async put(record: ActionOutcomeRecord): Promise<void> {
    this.rows.set(outcomeKey(record), record);
  }

  async close(): Promise<void> {
    this.rows.clear();
  }
}
