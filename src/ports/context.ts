/**
 * Context Bridge port. Matches Hub's ContextClient: POST /v1/context/build
 * with protocol ContextRequest / ContextPacket. Gateway applies a
 * response-token reserve locally when choosing `budgetTokens`; that reserve is
 * not a protocol field.
 *
 * Act-as: Hub mints the assertion; gateway verifies then forwards it as
 * Authorization bearer. Gateway does not mint act-as (iss is proba-hub).
 */

import type { ContextPacket, ContextRequest } from '../protocol.js';

export interface ContextBuildOptions {
  /** Verified Hub act-as JWT. */
  assertion: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ContextClientErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'http_error'
  | 'invalid_packet'
  | 'rejected'
  | 'assertion_invalid';

export class ContextClientError extends Error {
  constructor(
    readonly code: ContextClientErrorCode,
    message: string,
    readonly cause?: unknown,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ContextClientError';
  }
}

export interface ContextPort {
  build(request: ContextRequest, options: ContextBuildOptions): Promise<ContextPacket>;
  /** Readiness only: GET /ready or /health. Must not POST /v1/complete or spend. */
  ping(): Promise<void>;
}
