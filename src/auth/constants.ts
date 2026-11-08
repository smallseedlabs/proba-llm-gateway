/**
 * Service-token contracts.
 *
 * Inbound (Hub → gateway): audience is this service. Caller identity is the
 * verified issuer+subject allowlist (deployment-controlled; default Hub only).
 *
 * Outbound (gateway → proba-llm): mint iss/sub from deployment-controlled
 * values that MUST match LLM's CALLER_ISSUERS / CALLER_SUBJECTS
 * (defaults proba-gateway / gateway) and aud `proba-llm`.
 *
 * There is no service registry: keys are local JWKS / PKCS#8 files.
 * No DeepSeek (or other vendor) key belongs here.
 */

export const GATEWAY_AUDIENCE = 'proba-gateway';
export const DEFAULT_CALLER_ISSUERS = ['proba-hub'] as const;
export const DEFAULT_CALLER_SUBJECTS = ['hub'] as const;

export const LLM_AUDIENCE = 'proba-llm';
export const ADS_AUDIENCE = 'proba-ads';
export const DEFAULT_LLM_TOKEN_ISSUER = 'proba-gateway';
export const DEFAULT_LLM_TOKEN_SUBJECT = 'gateway';

/** Service token lives at most two minutes (exp − iat), same as other Proba service tokens. */
export const SERVICE_TOKEN_MAX_TTL_SECONDS = 120;
/** Clock difference tolerated when checking exp, nbf and iat. */
export const CLOCK_SKEW_SECONDS = 30;

export const MAX_TOKEN_LENGTH = 8192;
export const MAX_JTI_LENGTH = 128;

export const ACT_AS_ISSUER = 'proba-hub';
export const ACT_AS_EXPECTED_AUDIENCE = 'proba-context';
