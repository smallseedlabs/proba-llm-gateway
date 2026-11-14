import { readFileSync } from 'node:fs';
import { ConfigError } from './errors.js';
import { loadGuardrails } from './guardrails/guardrails.js';
import {
  ADS_AUDIENCE,
  DEFAULT_CALLER_ISSUERS,
  DEFAULT_CALLER_SUBJECTS,
  DEFAULT_LLM_TOKEN_ISSUER,
  DEFAULT_LLM_TOKEN_SUBJECT,
  SERVICE_TOKEN_MAX_TTL_SECONDS,
} from './auth/constants.js';
import type { AuditPublisherKind, GatewayServiceConfig, RuntimeEnv } from './types/config.js';

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(raw);
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function envOptionalInt(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function envOptionalNumber(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive number`);
  return parsed;
}

function envList(env: NodeJS.ProcessEnv, name: string, fallback: readonly string[]): string[] {
  const raw = env[name]?.trim();
  if (!raw) return [...fallback];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function envSecret(env: NodeJS.ProcessEnv, name: string): string {
  const filePath = env[`${name}_FILE`]?.trim();
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new ConfigError(`${name}_FILE is set but could not be read (${filePath}): ${(err as Error).message}`);
    }
  }
  return (env[name] ?? '').trim();
}

function parseBillingRequirement(raw: string | undefined): 'billing_eligibility' | 'exact_balance' {
  const value = (raw ?? 'billing_eligibility').trim();
  if (value === 'billing_eligibility' || value === 'exact_balance') return value;
  throw new ConfigError('ADS_BILLING_REQUIREMENT must be billing_eligibility or exact_balance');
}

function parseQuotaUnknownPolicy(raw: string | undefined): 'allow_with_run_budget' | 'refuse' {
  const value = (raw ?? 'allow_with_run_budget').trim();
  if (value === 'allow_with_run_budget' || value === 'refuse') return value;
  throw new ConfigError('LLM_QUOTA_UNKNOWN_POLICY must be allow_with_run_budget or refuse');
}

function runtimeEnv(raw: string | undefined): RuntimeEnv {
  const value = (raw ?? 'development').trim().toLowerCase();
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new ConfigError(`NODE_ENV must be development, test or production (got "${raw}")`);
}

/**
 * Load config from the environment. Secrets come from `NAME_FILE` (Swarm/GCP mount)
 * or `NAME`. There is no LLM vendor key here — that stays in proba-llm.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayServiceConfig {
  if (env.DEEPSEEK_API_KEY || env.LLM_API_KEY || env.DEEPSEEK_API_KEY_FILE || env.LLM_API_KEY_FILE) {
    throw new ConfigError('LLM vendor keys do not belong in the gateway; keep them solely in proba-llm');
  }

  const nodeEnv = runtimeEnv(env.NODE_ENV);
  const publisherRaw = (env.AUDIT_PUBLISHER ?? (nodeEnv === 'production' ? 'redis' : 'log')).trim().toLowerCase();
  if (publisherRaw !== 'redis' && publisherRaw !== 'log') {
    throw new ConfigError(`AUDIT_PUBLISHER must be redis or log (got "${publisherRaw}")`);
  }
  const auditKind = publisherRaw as AuditPublisherKind;
  if (nodeEnv === 'production' && auditKind === 'log') {
    throw new ConfigError('AUDIT_PUBLISHER=log is not allowed when NODE_ENV=production');
  }

  const redisUrl = envSecret(env, 'REDIS_URL') || (env.REDIS_URL ?? '').trim();
  const hubPublicKeyFile = (env.HUB_SERVICE_PUBLIC_KEY_FILE ?? '').trim();
  const hubAssertionPublicKeyFile = (env.HUB_ASSERTION_PUBLIC_KEY_FILE ?? '').trim();
  const signingKeyFile = (env.GATEWAY_LLM_PRIVATE_KEY_FILE ?? '').trim();
  const signingKeyId = (env.GATEWAY_LLM_KEY_ID ?? '').trim();
  const llmBaseUrl = (env.LLM_BASE_URL ?? '').trim();
  const contextBaseUrl = (env.CONTEXT_BRIDGE_URL ?? '').trim();

  if (nodeEnv === 'production') {
    if (!hubPublicKeyFile) throw new ConfigError('HUB_SERVICE_PUBLIC_KEY_FILE is required when NODE_ENV=production');
    if (!hubAssertionPublicKeyFile) throw new ConfigError('HUB_ASSERTION_PUBLIC_KEY_FILE is required when NODE_ENV=production');
    if (!signingKeyFile) throw new ConfigError('GATEWAY_LLM_PRIVATE_KEY_FILE is required when NODE_ENV=production');
    if (!signingKeyId) throw new ConfigError('GATEWAY_LLM_KEY_ID is required when NODE_ENV=production');
    if (!llmBaseUrl) throw new ConfigError('LLM_BASE_URL is required when NODE_ENV=production');
    if (!contextBaseUrl) throw new ConfigError('CONTEXT_BRIDGE_URL is required when NODE_ENV=production');
    if (auditKind === 'redis' && !redisUrl) throw new ConfigError('REDIS_URL or REDIS_URL_FILE is required when AUDIT_PUBLISHER=redis');
  }

  const runStoreDir = (env.RUN_STORE_DIR ?? (nodeEnv === 'test' ? '' : 'data/runs')).trim();
  if (nodeEnv === 'production' && !runStoreDir) {
    throw new ConfigError('RUN_STORE_DIR is required when NODE_ENV=production');
  }
  const researchStoreDir = (env.RESEARCH_STORE_DIR ?? (nodeEnv === 'test' ? '' : 'data/research')).trim();
  if (nodeEnv === 'production' && !researchStoreDir) {
    throw new ConfigError('RESEARCH_STORE_DIR is required when NODE_ENV=production');
  }
  const analyticsStoreDir = (env.ANALYTICS_STORE_DIR ?? (nodeEnv === 'test' ? '' : 'data/analytics')).trim();
  if (nodeEnv === 'production' && !analyticsStoreDir) {
    throw new ConfigError('ANALYTICS_STORE_DIR is required when NODE_ENV=production');
  }
  const actionPolicyStoreDir = (env.ACTION_POLICY_STORE_DIR ?? (nodeEnv === 'test' ? '' : 'data/action-policies')).trim();
  if (nodeEnv === 'production' && !actionPolicyStoreDir) {
    throw new ConfigError('ACTION_POLICY_STORE_DIR is required when NODE_ENV=production');
  }
  const actionOutcomeStoreDir = (env.ACTION_OUTCOME_STORE_DIR ?? (nodeEnv === 'test' ? '' : 'data/action-outcomes')).trim();
  if (nodeEnv === 'production' && !actionOutcomeStoreDir) {
    throw new ConfigError('ACTION_OUTCOME_STORE_DIR is required when NODE_ENV=production');
  }

  if (env.INGRESS_PUBLIC?.trim() === 'true') {
    throw new ConfigError('INGRESS_PUBLIC=true is refused: proba-llm-gateway is an internal service with no public ingress default');
  }

  const host = (env.HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1')).trim();
  const port = envInt(env, 'PORT', 3700, 1, 65535);

  const config: GatewayServiceConfig = {
    env: nodeEnv,
    logLevel: (env.LOG_LEVEL ?? 'info').trim() || 'info',
    listen: { host, port },
    auth: {
      hubPublicKeyFile,
      allowedIssuers: envList(env, 'CALLER_ISSUERS', DEFAULT_CALLER_ISSUERS),
      allowedSubjects: envList(env, 'CALLER_SUBJECTS', DEFAULT_CALLER_SUBJECTS),
      hubAssertionPublicKeyFile,
    },
    llm: {
      baseUrl: llmBaseUrl,
      allowedHosts: envList(env, 'LLM_ALLOWED_HOSTS', nodeEnv === 'production' ? ['llm'] : []),
      timeoutMs: envInt(env, 'LLM_TIMEOUT_MS', 60_000, 100, 300_000),
      signingKeyFile,
      signingKeyId,
      tokenIssuer: (env.LLM_TOKEN_ISSUER ?? DEFAULT_LLM_TOKEN_ISSUER).trim() || DEFAULT_LLM_TOKEN_ISSUER,
      tokenSubject: (env.LLM_TOKEN_SUBJECT ?? DEFAULT_LLM_TOKEN_SUBJECT).trim() || DEFAULT_LLM_TOKEN_SUBJECT,
      tokenTtlSeconds: envInt(env, 'LLM_TOKEN_TTL_SECONDS', 60, 1, SERVICE_TOKEN_MAX_TTL_SECONDS),
      quotaUnknownPolicy: parseQuotaUnknownPolicy(env.LLM_QUOTA_UNKNOWN_POLICY),
    },
    context: {
      baseUrl: contextBaseUrl,
      allowedHosts: envList(env, 'CONTEXT_ALLOWED_HOSTS', nodeEnv === 'production' ? ['context'] : []),
      timeoutMs: envInt(env, 'CONTEXT_TIMEOUT_MS', 10_000, 100, 60_000),
      maxBudgetTokens: envOptionalInt(env, 'CONTEXT_MAX_BUDGET_TOKENS', 1, 1_000_000),
    },
    ads: {
      baseUrl: (env.ADS_DOMAIN_URL ?? '').trim(),
      allowedHosts: envList(env, 'ADS_DOMAIN_ALLOWED_HOSTS', nodeEnv === 'production' ? ['ads'] : []),
      timeoutMs: envInt(env, 'ADS_DOMAIN_TIMEOUT_MS', 15_000, 100, 120_000),
      tokenAudience: (env.ADS_TOKEN_AUDIENCE ?? ADS_AUDIENCE).trim() || ADS_AUDIENCE,
      unknownBalancePolicy: 'refuse_mutating',
      billingRequirement: parseBillingRequirement(env.ADS_BILLING_REQUIREMENT),
      preflightFreshnessMs: envInt(env, 'ADS_PREFLIGHT_FRESHNESS_MS', 15_000, 1_000, 300_000),
    },
    research: {
      httpFetchEnabled: envBool(env, 'RESEARCH_HTTP_FETCH', false),
      timeoutMs: envInt(env, 'RESEARCH_FETCH_TIMEOUT_MS', 5_000, 100, 30_000),
      maxBytes: envInt(env, 'RESEARCH_FETCH_MAX_BYTES', 262_144, 1024, 2_000_000),
      storeDir: researchStoreDir,
    },
    analytics: {
      maxAgeMs: envInt(env, 'ANALYTICS_MAX_AGE_MS', 6 * 60 * 60 * 1000, 1_000, 30 * 24 * 60 * 60 * 1000),
      minImpressions: envInt(env, 'ANALYTICS_MIN_IMPRESSIONS', 100, 0, 1_000_000_000),
      minObservations: envInt(env, 'ANALYTICS_MIN_OBSERVATIONS', 12, 0, 1_000_000),
      minWindowCoverage: (() => {
        const raw = env.ANALYTICS_MIN_WINDOW_COVERAGE?.trim();
        if (!raw) return 0.5;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new ConfigError('ANALYTICS_MIN_WINDOW_COVERAGE must be between 0 and 1');
        }
        return parsed;
      })(),
      cooldownMs: envInt(env, 'ANALYTICS_COOLDOWN_MS', 6 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000),
      maxProposalDailyBudget: envOptionalNumber(env, 'ANALYTICS_MAX_PROPOSAL_DAILY_BUDGET'),
      maxProposalDecreasePct: (() => {
        const raw = env.ANALYTICS_MAX_PROPOSAL_DECREASE_PCT?.trim();
        if (!raw) return 0.5;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new ConfigError('ANALYTICS_MAX_PROPOSAL_DECREASE_PCT must be between 0 and 1');
        }
        return parsed;
      })(),
      storeDir: analyticsStoreDir,
    },
    actionPolicy: {
      cooldownMs: envInt(env, 'ACTION_POLICY_COOLDOWN_MS', 6 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000),
      storeDir: actionPolicyStoreDir,
      outcomeStoreDir: actionOutcomeStoreDir,
    },
    limits: {
      maxRequestBytes: envInt(env, 'GATEWAY_MAX_REQUEST_BYTES', 262_144, 1024, 2_000_000),
      rateLimitMax: envInt(env, 'GATEWAY_RATE_LIMIT_MAX', 60, 1, 10_000),
      rateLimitWindowMs: envInt(env, 'GATEWAY_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
      maxIterations: envInt(env, 'GATEWAY_MAX_ITERATIONS', 8, 1, 64),
      maxLlmCalls: envInt(env, 'GATEWAY_MAX_LLM_CALLS', 8, 1, 64),
      maxToolCalls: envInt(env, 'GATEWAY_MAX_TOOL_CALLS', 16, 1, 256),
      maxPromptTokens: envOptionalInt(env, 'GATEWAY_MAX_PROMPT_TOKENS', 1, 10_000_000),
      maxCompletionTokens: envInt(env, 'GATEWAY_MAX_COMPLETION_TOKENS', 4000, 1, 10_000_000),
      maxTotalTokens: envOptionalInt(env, 'GATEWAY_MAX_TOTAL_TOKENS', 1, 20_000_000),
      maxCostUsd: envOptionalNumber(env, 'GATEWAY_MAX_COST_USD'),
      responseTokenReserve: envInt(env, 'GATEWAY_RESPONSE_TOKEN_RESERVE', 512, 0, 128_000),
    },
    audit: {
      kind: auditKind,
      stream: (env.AUDIT_STREAM ?? 'proba.audit.events').trim() || 'proba.audit.events',
      redisUrl,
      contentEnabled: envBool(env, 'AUDIT_CONTENT_ENABLED', true),
      contentMaskPii: envBool(env, 'AUDIT_CONTENT_MASK_PII', true),
      maxStreamLength: envInt(env, 'AUDIT_MAX_STREAM_LENGTH', 100_000, 0, 10_000_000),
    },
    runStoreDir,
    admin: {
      firebaseProjectId: (env.FIREBASE_PROJECT_ID ?? '').trim(),
      adminEmails: envList(env, 'GATEWAY_ADMIN_EMAILS', []).map((e) => e.toLowerCase()),
      corsOrigins: envList(env, 'GATEWAY_CORS_ORIGINS', []),
      workspaceId: (env.GATEWAY_ADMIN_WORKSPACE_ID ?? 'seedbed').trim() || 'seedbed',
    },
    guardrailsFile: (env.GATEWAY_GUARDRAILS_FILE ?? '').trim() || undefined,
  };
  return { ...config, guardrails: loadGuardrails(env, config.limits) };
}
