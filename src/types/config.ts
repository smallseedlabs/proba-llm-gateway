import type { Guardrails } from '../guardrails/guardrails.js';
export const GATEWAY_SERVICE_NAME = 'gateway';

export type RuntimeEnv = 'development' | 'test' | 'production';

export type AuditPublisherKind = 'redis' | 'log';

export interface ListenConfig {
  host: string;
  port: number;
}

export interface AuthConfig {
  /** JWKS of Hub's gateway-caller service keys (public only). */
  hubPublicKeyFile: string;
  allowedIssuers: readonly string[];
  allowedSubjects: readonly string[];
  /**
   * JWKS of Hub act-as assertion keys. Used only to verify a forwarded
   * assertion before sending it to the context bridge. Gateway is not an
   * act-as audience; `proba-context` is.
   */
  hubAssertionPublicKeyFile: string;
}

export interface LlmClientConfig {
  /** Internal proba-llm base URL, no path. Swarm default http://llm:3600. */
  baseUrl: string;
  allowedHosts: readonly string[];
  timeoutMs: number;
  /**
   * PKCS#8 PEM used to mint EdDSA tokens for proba-llm
   * (`iss=proba-gateway`, `aud=proba-llm`, `sub=gateway` by default).
   * There is no DeepSeek (or other vendor) key in this process.
   */
  signingKeyFile: string;
  signingKeyId: string;
  tokenIssuer: string;
  tokenSubject: string;
  tokenTtlSeconds: number;
  /**
   * When proba-llm has no `/v1/quota` (404) or the body is not authoritative:
   * `allow_with_run_budget` (default) still applies local token/iteration caps;
   * unknown is not a verified credit balance. `refuse` blocks paid model calls.
   */
  quotaUnknownPolicy: 'allow_with_run_budget' | 'refuse';
}

export interface ActionPolicyConfig {
  /** Per-action cooldown after auto_with_limits execute. Owner document may tighten. */
  cooldownMs: number;
  storeDir: string;
  outcomeStoreDir: string;
}

export interface AnalyticsConfig {
  /** Max age of Context analytics asOf. Stale → no_action, not a zero fill. */
  maxAgeMs: number;
  minImpressions: number;
  minObservations: number;
  /** 0–1 fraction of expected hourly buckets. Unknown coverage is not assumed complete. */
  minWindowCoverage: number;
  cooldownMs: number;
  /** Optional ceiling on dry-run cap proposals. Unset = no extra ceiling besides decrease %. */
  maxProposalDailyBudget: number | null;
  /** Max fraction a cap may decrease currentDailyBudget. Unset = no decrease ceiling. */
  maxProposalDecreasePct: number | null;
  storeDir: string;
}

export interface ResearchConfig {
  /**
   * Opt-in public URL fetch. Default false: unconfigured provider fails
   * closed and does not invent citations. Not a paid ad action.
   */
  httpFetchEnabled: boolean;
  timeoutMs: number;
  maxBytes: number;
  storeDir: string;
}

export interface AdsDomainConfig {
  /** Empty means unconfigured — ads verbs fail closed. HTTP so a later Ads service can plug in. */
  baseUrl: string;
  allowedHosts: readonly string[];
  timeoutMs: number;
  tokenAudience: string;
  /**
   * When the Ads domain cannot verify provider funds: refuse mutating Ads work.
   * Never invent a balance.
   */
  unknownBalancePolicy: 'refuse_mutating';
  /**
   * `billing_eligibility` accepts an authoritative eligible/ineligible flag.
   * `exact_balance` requires a verified exact_balance claim. Eligibility is
   * not an exact balance.
   */
  billingRequirement: 'billing_eligibility' | 'exact_balance';
  preflightFreshnessMs: number;
}

export interface ContextClientConfig {
  /** Context bridge base URL, no path. Local default http://127.0.0.1:3500. */
  baseUrl: string;
  allowedHosts: readonly string[];
  timeoutMs: number;
  /** Cap applied to ContextRequest.budgetTokens; must be configured, not a free quota. */
  maxBudgetTokens: number | null;
}

export interface LimitsConfig {
  maxRequestBytes: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  maxIterations: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  maxPromptTokens: number | null;
  maxCompletionTokens: number | null;
  maxTotalTokens: number | null;
  /**
   * Optional whole-run USD ceiling. Unset (`null`) is the default: no monetary
   * cap, unknown cost stays explicit, token/iteration caps still apply.
   * When set, the next paid LLM call is dispatched only if a conservative
   * cost bound (authoritative unit prices × this-call token caps) fits the
   * remaining ceiling. Unknown pricing/cost is never $0 and there is no
   * first-call grace. This is not a product-wide deny and is not a $2 default.
   */
  maxCostUsd: number | null;
  /**
   * Tokens reserved for the model response when computing ContextRequest.budgetTokens.
   * Not a protocol field; the bridge still sees `budgetTokens` only.
   */
  responseTokenReserve: number;
}

export interface AuditConfig {
  kind: AuditPublisherKind;
  stream: string;
  redisUrl: string;
  contentEnabled: boolean;
  contentMaskPii: boolean;
  maxStreamLength: number;
}

export interface GatewayServiceConfig {
  env: RuntimeEnv;
  logLevel: string;
  listen: ListenConfig;
  auth: AuthConfig;
  llm: LlmClientConfig;
  context: ContextClientConfig;
  ads: AdsDomainConfig;
  research: ResearchConfig;
  analytics: AnalyticsConfig;
  actionPolicy: ActionPolicyConfig;
  limits: LimitsConfig;
  /** Operator guardrails (file + env) that only tighten verbs and limits. Absent = none. */
  guardrails?: Guardrails;
  audit: AuditConfig;
  runStoreDir: string;
}
