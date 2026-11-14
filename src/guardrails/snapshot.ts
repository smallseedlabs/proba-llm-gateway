/**
 * Effective guardrails as the Portal editor sees them, plus validate-and-write
 * of the override file. The same tighten-only checks as start-up: a write that
 * would loosen a code lock or a GATEWAY_MAX_* deployment limit is refused and
 * the file is left unchanged.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ConfigError } from '../errors.js';
import { VERB_CATALOG } from '../limbs/catalog.js';
import type { LimitsConfig } from '../types/config.js';
import type { GatewayServiceConfig } from '../types/config.js';
import {
  allowedVerbModes,
  assertTightenOnly,
  deploymentLimit,
  GUARDRAIL_LIMIT_KEYS,
  loadGuardrails,
  lockedVerbMode,
  parseGuardrailsFile,
  readEnvGuardrailLimits,
  readEnvVerbPolicy,
  verbMode,
  type GuardrailLimitKey,
  type GuardrailLimits,
  type Guardrails,
  type GuardrailsFile,
  type VerbMode,
} from './guardrails.js';

export const EFFECTIVE_SCHEMA = 'proba.gateway-guardrails/v1-effective' as const;

export interface VerbSnapshot {
  name: string;
  locked: VerbMode;
  file: VerbMode | null;
  env: VerbMode | null;
  effective: VerbMode;
  allowedModes: VerbMode[];
}

export interface GuardrailsSnapshot {
  schema: typeof EFFECTIVE_SCHEMA;
  fileVersion: string;
  version: string;
  source: string;
  writable: boolean;
  lockedLimits: Record<GuardrailLimitKey, number | null>;
  fileLimits: GuardrailLimits;
  envLimits: GuardrailLimits;
  effectiveLimits: GuardrailLimits;
  verbs: VerbSnapshot[];
}

function lockedLimits(limits: LimitsConfig): Record<GuardrailLimitKey, number | null> {
  const out = {} as Record<GuardrailLimitKey, number | null>;
  for (const key of GUARDRAIL_LIMIT_KEYS) out[key] = deploymentLimit(limits, key);
  return out;
}

export function toSnapshot(args: {
  limits: LimitsConfig;
  effective: Guardrails;
  file?: GuardrailsFile;
  envVerbs: Record<string, VerbMode>;
  envLimits: GuardrailLimits;
  writable: boolean;
}): GuardrailsSnapshot {
  const fileVerbs = args.file?.verbs ?? {};
  const fileLimits: GuardrailLimits = args.file?.limits ?? {};
  return {
    schema: EFFECTIVE_SCHEMA,
    fileVersion: args.file?.version ?? 'none',
    version: args.effective.version,
    source: args.effective.source,
    writable: args.writable,
    lockedLimits: lockedLimits(args.limits),
    fileLimits,
    envLimits: args.envLimits,
    effectiveLimits: { ...args.effective.limits },
    verbs: VERB_CATALOG.map((verb) => ({
      name: verb.name,
      locked: lockedVerbMode(verb.name),
      file: fileVerbs[verb.name] ?? null,
      env: args.envVerbs[verb.name] ?? null,
      effective: verbMode(args.effective, verb.name),
      allowedModes: allowedVerbModes(verb.name),
    })),
  };
}

export function nextFileVersion(now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `${day}.portal`;
}

/** Parse and tighten-only-validate a write body. Unknown keys and loosening are refused. */
export function parseGuardrailsWrite(raw: unknown, limits: LimitsConfig, origin: string): GuardrailsFile {
  const body = raw && typeof raw === 'object' ? { schema: 'proba.gateway-guardrails/v1', version: nextFileVersion(), ...(raw as Record<string, unknown>) } : raw;
  const file = parseGuardrailsFile(body, origin);
  assertTightenOnly(file, limits, origin);
  return file;
}

export function writeGuardrailsFile(path: string, file: GuardrailsFile): void {
  const body = `${JSON.stringify(file, null, 2)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export class GuardrailsController {
  constructor(
    private readonly config: GatewayServiceConfig,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  private writablePath(): string | null {
    const path = this.env.GATEWAY_GUARDRAILS_FILE?.trim() || this.config.guardrailsFile?.trim();
    return path || null;
  }

  snapshot(): GuardrailsSnapshot {
    const path = this.writablePath();
    let file: GuardrailsFile | undefined;
    if (path) {
      try {
        file = parseGuardrailsFile(JSON.parse(readFileSync(path, 'utf8')), path);
      } catch {
        // Effective config is still authoritative; the editor can replace a missing or unreadable file.
        file = undefined;
      }
    }
    return toSnapshot({
      limits: this.config.limits,
      effective: this.config.guardrails ?? { version: 'none', source: 'none', verbs: {}, limits: {} },
      file,
      envVerbs: readEnvVerbPolicy(this.env),
      envLimits: readEnvGuardrailLimits(this.env),
      writable: Boolean(path),
    });
  }

  /**
   * Validate, write the override file, and reload the in-memory effective guardrails
   * so later runs pick up the change. Env overrides still apply and can only tighten.
   */
  replace(raw: unknown): GuardrailsSnapshot {
    const path = this.writablePath();
    if (!path) {
      throw new ConfigError('GATEWAY_GUARDRAILS_FILE must be set to a writable override file before guardrails can be edited');
    }
    const file = parseGuardrailsWrite(raw, this.config.limits, 'guardrails write');
    writeGuardrailsFile(path, file);
    const next = loadGuardrails(this.env, this.config.limits);
    this.config.guardrails = next;
    return this.snapshot();
  }
}
