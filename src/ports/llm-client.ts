/**
 * Signed internal client for proba-llm. One POST /v1/complete per call.
 * Gateway mints EdDSA `iss=proba-gateway` `aud=proba-llm` `sub=gateway`
 * (deployment-controlled). The LLM service never executes tools.
 *
 * Idempotency-Key is per LLM turn (not the whole gateway run). A retried
 * key with a different body is 409; inflight/ambiguous must not redispatch.
 */

import type { CompleteRequest, TurnResponse } from '../types/llm.js';
import type { LlmQuotaClaim } from '../types/preflight.js';

export type LlmClientErrorCode =
  | 'invalid_request'
  | 'model_refused'
  | 'invalid_token'
  | 'token_expired'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'provider_error'
  | 'provider_ambiguous'
  | 'aborted'
  | 'unreachable'
  | 'invalid_response';

export class LlmClientError extends Error {
  constructor(
    readonly code: LlmClientErrorCode,
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'LlmClientError';
  }
}

export interface LlmCompleteOptions {
  /** UUID for the LLM turn; never reuse across different payloads. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly name: string;
  complete(request: CompleteRequest, options: LlmCompleteOptions): Promise<TurnResponse>;
  /** Readiness only: GET /ready, must not POST /v1/complete. */
  ping(): Promise<void>;
  /**
   * Authoritative LLM service quota/credits. Optional. Absence or 404 is
   * `unknown`, not a verified zero. Must not use /ready as a credit balance.
   */
  quota?(): Promise<LlmQuotaClaim>;
  close?(): Promise<void>;
}
