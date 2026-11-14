/**
 * Operator guardrails: configuration that can only TIGHTEN what the code and the deployment allow.
 *
 * Layers, loosest first; each may only narrow the one before it:
 *   1. Code locks: the verb catalog (allowlisted, requiresApproval) and the hard maxima of GATEWAY_MAX_* parsing.
 *   2. Deployment limits: GATEWAY_MAX_ITERATIONS / _LLM_CALLS / _TOOL_CALLS / _*_TOKENS / _COST_USD (`config.limits`).
 *   3. The versioned guardrails file (GATEWAY_GUARDRAILS_FILE, default config/guardrails.json).
 *   4. Env overrides: GATEWAY_VERB_POLICY (`verb=allow|ask|deny,...`) and GATEWAY_GUARDRAIL_MAX_* .
 * Anything that would loosen a lower layer (a higher limit, `allow` on a verb that needs approval, any mode on a verb that is not
 * allowlisted, a less strict verb mode than the file) is refused at start-up with a ConfigError; it is never silently clamped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigError } from '../errors.js';
import { VERB_CATALOG } from '../limbs/catalog.js';
import type { LimitsConfig } from '../types/config.js';
import type { UsageLimits } from '../ports/usage.js';
import { CREATIVE_LOCKS, LOCKED_BANNED_PHRASES, type CreativeRules } from '../limbs/creative-draft.js';

export const VERB_MODES = ['allow', 'ask', 'deny'] as const;
export type VerbMode = (typeof VERB_MODES)[number];
const STRICTNESS: Record<VerbMode, number> = { allow: 0, ask: 1, deny: 2 };

export const GUARDRAIL_LIMIT_KEYS = ['maxIterations', 'maxLlmCalls', 'maxToolCalls', 'maxPromptTokens', 'maxCompletionTokens', 'maxTotalTokens', 'maxCostUsd'] as const;
export type GuardrailLimitKey = (typeof GUARDRAIL_LIMIT_KEYS)[number];
export type GuardrailLimits = Partial<Record<GuardrailLimitKey, number>>;

const positiveInt = z.number().int().positive();
export const guardrailsFileSchema = z
  .object({
    schema: z.literal('proba.gateway-guardrails/v1'),
    version: z.string().regex(/^[0-9A-Za-z.\-_]{1,64}$/),
    description: z.string().max(2000).optional(),
    verbs: z.record(z.string(), z.enum(VERB_MODES)).default({}),
    limits: z
      .object({
        maxIterations: positiveInt.optional(),
        maxLlmCalls: positiveInt.optional(),
        maxToolCalls: positiveInt.optional(),
        maxPromptTokens: positiveInt.optional(),
        maxCompletionTokens: positiveInt.optional(),
        maxTotalTokens: positiveInt.optional(),
        maxCostUsd: z.number().positive().optional(),
      })
      .strict()
      .default({}),
    /** creative.draft_post checks: lower length caps and EXTRA banned phrases (the code list can never be removed). */
    creative: z
      .object({
        maxHeadlineChars: positiveInt.optional(),
        maxBodyChars: positiveInt.optional(),
        bannedPhrases: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GuardrailsFile = z.infer<typeof guardrailsFileSchema>;

export interface Guardrails {
  /** Version of the file in force, `none` when no file was loaded. */
  version: string;
  source: string;
  /** Effective mode per verb, only for verbs the guardrails mention. */
  verbs: Readonly<Record<string, VerbMode>>;
  /** Effective ceilings, only for limits the guardrails set. */
  limits: Readonly<GuardrailLimits>;
  /** Operator creative tightening (lower caps, extra banned phrases); absent means the code locks only. */
  creative?: Readonly<{ maxHeadlineChars?: number; maxBodyChars?: number; bannedPhrases?: readonly string[] }>;
}

export const NO_GUARDRAILS: Guardrails = Object.freeze({ version: 'none', source: 'none', verbs: Object.freeze({}), limits: Object.freeze({}) });

/** The shipped file: config/guardrails.json at the package root (dist/guardrails -> ../../config, src/guardrails -> ../../config). */
export const DEFAULT_GUARDRAILS_FILE = fileURLToPath(new URL('../../config/guardrails.json', import.meta.url));

/** The mode the code itself gives a verb: `deny` when not allowlisted, `ask` when it needs approval, otherwise `allow`. */
export function lockedVerbMode(name: string): VerbMode {
  const verb = VERB_CATALOG.find((v) => v.name === name);
  if (!verb || !verb.allowlisted) return 'deny';
  return verb.requiresApproval ? 'ask' : 'allow';
}

function checkVerbs(verbs: Record<string, VerbMode>, origin: string): void {
  for (const [name, mode] of Object.entries(verbs)) {
    if (!VERB_CATALOG.some((v) => v.name === name)) throw new ConfigError(`${origin}: unknown verb "${name}"`);
    const locked = lockedVerbMode(name);
    if (STRICTNESS[mode] < STRICTNESS[locked]) {
      throw new ConfigError(`${origin}: "${name}=${mode}" would loosen the code lock (${locked}); guardrails can only tighten`);
    }
  }
}

/** Deployment limit for a key; `null` means unbounded (tokens, cost), which any positive guardrail tightens. */
function lockedLimit(limits: LimitsConfig, key: GuardrailLimitKey): number | null {
  return limits[key];
}

function checkLimits(candidate: GuardrailLimits, ceiling: (key: GuardrailLimitKey) => number | null, origin: string, against: string): void {
  for (const key of GUARDRAIL_LIMIT_KEYS) {
    const value = candidate[key];
    if (value === undefined) continue;
    const max = ceiling(key);
    if (max !== null && value > max) {
      throw new ConfigError(`${origin}: ${key}=${value} would loosen ${against} (${max}); guardrails can only tighten`);
    }
  }
}

function checkCreative(creative: GuardrailsFile['creative'], origin: string): void {
  if (!creative) return;
  if (creative.maxHeadlineChars !== undefined && creative.maxHeadlineChars > CREATIVE_LOCKS.maxHeadlineChars) {
    throw new ConfigError(`${origin}: creative.maxHeadlineChars=${creative.maxHeadlineChars} would loosen the code lock (${CREATIVE_LOCKS.maxHeadlineChars}); guardrails can only tighten`);
  }
  if (creative.maxBodyChars !== undefined && creative.maxBodyChars > CREATIVE_LOCKS.maxBodyChars) {
    throw new ConfigError(`${origin}: creative.maxBodyChars=${creative.maxBodyChars} would loosen the code lock (${CREATIVE_LOCKS.maxBodyChars}); guardrails can only tighten`);
  }
}

/** Effective creative.draft_post rules: the stricter of the code locks and the guardrails; banned phrases are additive. */
export function creativeRulesFrom(guardrails: Guardrails): CreativeRules {
  const c = guardrails.creative;
  const extra = (c?.bannedPhrases ?? []).map((p) => p.toLowerCase());
  return {
    maxHeadlineChars: Math.min(CREATIVE_LOCKS.maxHeadlineChars, c?.maxHeadlineChars ?? CREATIVE_LOCKS.maxHeadlineChars),
    maxBodyChars: Math.min(CREATIVE_LOCKS.maxBodyChars, c?.maxBodyChars ?? CREATIVE_LOCKS.maxBodyChars),
    bannedPhrases: [...new Set([...LOCKED_BANNED_PHRASES, ...extra])],
  };
}

function parseVerbPolicy(raw: string | undefined): Record<string, VerbMode> {
  const out: Record<string, VerbMode> = {};
  if (!raw?.trim()) return out;
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, mode] = part.split('=').map((s) => s?.trim());
    if (!name || !mode || !(VERB_MODES as readonly string[]).includes(mode)) {
      throw new ConfigError(`GATEWAY_VERB_POLICY: "${part}" must be verb=allow|ask|deny`);
    }
    out[name] = mode as VerbMode;
  }
  return out;
}

const ENV_LIMITS: Record<GuardrailLimitKey, string> = {
  maxIterations: 'GATEWAY_GUARDRAIL_MAX_ITERATIONS',
  maxLlmCalls: 'GATEWAY_GUARDRAIL_MAX_LLM_CALLS',
  maxToolCalls: 'GATEWAY_GUARDRAIL_MAX_TOOL_CALLS',
  maxPromptTokens: 'GATEWAY_GUARDRAIL_MAX_PROMPT_TOKENS',
  maxCompletionTokens: 'GATEWAY_GUARDRAIL_MAX_COMPLETION_TOKENS',
  maxTotalTokens: 'GATEWAY_GUARDRAIL_MAX_TOTAL_TOKENS',
  maxCostUsd: 'GATEWAY_GUARDRAIL_MAX_COST_USD',
};

function envLimits(env: NodeJS.ProcessEnv): GuardrailLimits {
  const out: GuardrailLimits = {};
  for (const key of GUARDRAIL_LIMIT_KEYS) {
    const raw = env[ENV_LIMITS[key]]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    const ok = key === 'maxCostUsd' ? Number.isFinite(n) && n > 0 : Number.isInteger(n) && n > 0;
    if (!ok) throw new ConfigError(`${ENV_LIMITS[key]} must be a positive ${key === 'maxCostUsd' ? 'number' : 'integer'}`);
    out[key] = n;
  }
  return out;
}

export function parseGuardrailsFile(raw: unknown, origin: string): GuardrailsFile {
  const parsed = guardrailsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${origin}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim());
  }
  return parsed.data;
}

function readFile(path: string): GuardrailsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`GATEWAY_GUARDRAILS_FILE ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseGuardrailsFile(raw, path);
}

/**
 * Build the effective guardrails from the file and env, refusing anything that loosens the code locks, the deployment limits or
 * (for env) the file. `file` may be given directly (tests); otherwise GATEWAY_GUARDRAILS_FILE, else the shipped default if present.
 */
export function loadGuardrails(env: NodeJS.ProcessEnv, limits: LimitsConfig, options: { file?: GuardrailsFile; defaultFile?: string } = {}): Guardrails {
  const explicit = env.GATEWAY_GUARDRAILS_FILE?.trim();
  const defaultFile = options.defaultFile ?? DEFAULT_GUARDRAILS_FILE;
  let file: GuardrailsFile | undefined = options.file;
  let source = options.file ? 'inline' : 'none';
  if (!file && explicit) {
    file = readFile(explicit);
    source = explicit;
  } else if (!file && existsSync(defaultFile)) {
    file = readFile(defaultFile);
    source = defaultFile;
  }

  const fileVerbs = file?.verbs ?? {};
  const fileLimits: GuardrailLimits = file?.limits ?? {};
  checkVerbs(fileVerbs, `guardrails file ${source}`);
  checkCreative(file?.creative, `guardrails file ${source}`);
  checkLimits(fileLimits, (k) => lockedLimit(limits, k), `guardrails file ${source}`, 'the deployment limit GATEWAY_MAX_*');

  const envVerbs = parseVerbPolicy(env.GATEWAY_VERB_POLICY);
  checkVerbs(envVerbs, 'GATEWAY_VERB_POLICY');
  for (const [name, mode] of Object.entries(envVerbs)) {
    const fromFile = fileVerbs[name];
    if (fromFile && STRICTNESS[mode] < STRICTNESS[fromFile]) {
      throw new ConfigError(`GATEWAY_VERB_POLICY: "${name}=${mode}" would loosen the guardrails file (${fromFile}); env can only tighten`);
    }
  }
  const envLim = envLimits(env);
  checkLimits(
    envLim,
    (k) => {
      const f = fileLimits[k];
      const l = lockedLimit(limits, k);
      return f === undefined ? l : l === null ? f : Math.min(f, l);
    },
    'GATEWAY_GUARDRAIL_MAX_*',
    'the guardrails file / deployment limit'
  );

  const verbs: Record<string, VerbMode> = { ...fileVerbs };
  for (const [name, mode] of Object.entries(envVerbs)) verbs[name] = mode;
  const effective: GuardrailLimits = {};
  for (const key of GUARDRAIL_LIMIT_KEYS) {
    const values = [fileLimits[key], envLim[key]].filter((v): v is number => v !== undefined);
    if (values.length > 0) effective[key] = Math.min(...values);
  }
  return Object.freeze({
    version: file?.version ?? (Object.keys(envVerbs).length + Object.keys(envLim).length > 0 ? 'env' : 'none'),
    source: [source, ...(Object.keys(envVerbs).length + Object.keys(envLim).length > 0 ? ['env'] : [])].join('+'),
    verbs: Object.freeze(verbs),
    limits: Object.freeze(effective),
    ...(file?.creative ? { creative: Object.freeze({ ...file.creative }) } : {}),
  });
}

/** The effective mode of a verb: the stricter of the code lock and the guardrails. */
export function verbMode(guardrails: Guardrails, name: string): VerbMode {
  const locked = lockedVerbMode(name);
  const configured = guardrails.verbs[name];
  if (!configured) return locked;
  return STRICTNESS[configured] >= STRICTNESS[locked] ? configured : locked;
}

/** Run limits after the guardrails: every configured ceiling lowers the merged (deployment + Hub run budget) limit, never raises it. */
export function applyGuardrailLimits(limits: UsageLimits, guardrails: Guardrails): UsageLimits {
  const out = { ...limits };
  for (const key of GUARDRAIL_LIMIT_KEYS) {
    const ceiling = guardrails.limits[key];
    if (ceiling === undefined) continue;
    const current = out[key];
    out[key] = current === null ? ceiling : Math.min(current, ceiling);
  }
  return out;
}

/** Modes at least as strict as the code lock: the only values a file may set for this verb. */
export function allowedVerbModes(name: string): VerbMode[] {
  const locked = lockedVerbMode(name);
  return VERB_MODES.filter((mode) => STRICTNESS[mode] >= STRICTNESS[locked]);
}

/** Refuse a candidate file that would loosen the code locks or the deployment GATEWAY_MAX_* limits. */
export function assertTightenOnly(file: GuardrailsFile, limits: LimitsConfig, origin: string): void {
  checkVerbs(file.verbs ?? {}, origin);
  checkCreative(file.creative, origin);
  checkLimits(file.limits ?? {}, (k) => lockedLimit(limits, k), origin, 'the deployment limit GATEWAY_MAX_*');
}

export function readEnvVerbPolicy(env: NodeJS.ProcessEnv): Record<string, VerbMode> {
  return parseVerbPolicy(env.GATEWAY_VERB_POLICY);
}

export function readEnvGuardrailLimits(env: NodeJS.ProcessEnv): GuardrailLimits {
  return envLimits(env);
}

/** Deployment GATEWAY_MAX_* ceiling for a key; `null` means unbounded. */
export function deploymentLimit(limits: LimitsConfig, key: GuardrailLimitKey): number | null {
  return lockedLimit(limits, key);
}
