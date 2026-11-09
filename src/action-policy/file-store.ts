import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stableStringify } from '../audit/canonical.js';
import { assertPublishable } from './evaluate.js';
import { ConfigError } from '../errors.js';
import type { ActionOutcomeBinding, ActionOutcomeStore, ActionPolicyStore } from './store.js';
import type { ActionOutcomeRecord, ActionPolicyDocument } from './types.js';

async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const buf = Buffer.from(body, 'utf8');
  const fd = openSync(tmp, 'w');
  try {
    let offset = 0;
    while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await rename(tmp, path);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export class FileActionPolicyStore implements ActionPolicyStore {
  constructor(private readonly dir: string) {}

  async list(workspaceId: string): Promise<ActionPolicyDocument[]> {
    try {
      const names = await readdir(this.dir);
      const rows: ActionPolicyDocument[] = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name.includes('.outcome.')) continue;
        const raw = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as ActionPolicyDocument;
        if (raw.workspaceId === workspaceId) rows.push(raw);
      }
      return rows;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async put(document: ActionPolicyDocument): Promise<void> {
    assertPublishable(document);
    await mkdir(this.dir, { recursive: true });
    const existing = (await this.list(document.workspaceId)).find((row) => row.policyId === document.policyId);
    if (existing && document.version !== existing.version + 1) {
      throw new ConfigError(`action policy ${document.policyId} version must be ${existing.version + 1}`);
    }
    if (!existing && document.version !== 1) {
      throw new ConfigError(`action policy ${document.policyId} must start at version 1`);
    }
    await atomicWrite(join(this.dir, `${digest({ policyId: document.policyId })}.json`), JSON.stringify(document));
  }

  async close(): Promise<void> {
    // files persist
  }
}

export class FileActionOutcomeStore implements ActionOutcomeStore {
  constructor(private readonly dir: string) {}

  async get(binding: ActionOutcomeBinding): Promise<ActionOutcomeRecord | undefined> {
    try {
      const raw = await readFile(this.pathOf(binding), 'utf8');
      return JSON.parse(raw) as ActionOutcomeRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async put(record: ActionOutcomeRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(this.pathOf(record), JSON.stringify(record));
  }

  async close(): Promise<void> {
    // files persist
  }

  private pathOf(binding: ActionOutcomeBinding): string {
    const key = {
      workspaceId: binding.workspaceId,
      userId: binding.userId,
      verb: binding.verb,
      probaCampaignId: binding.probaCampaignId,
      argsHash: binding.argsHash,
    };
    return join(this.dir, `${digest(key)}.outcome.json`);
  }
}
