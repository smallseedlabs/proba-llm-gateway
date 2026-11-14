import { createHash } from 'node:crypto';
import type { HubRunRequest } from '../types/run.js';

/**
 * Canonical hash of the Hub run payload (not caller identity).
 * `resume` and `actAsAssertion` are excluded so an approval continuation is
 * the same run, not a fingerprint conflict.
 */
function fingerprintBody(request: HubRunRequest) {
  return {
    workspaceId: request.workspaceId,
    userId: request.userId,
    goalId: request.goalId ?? null,
    threadId: request.threadId ?? null,
    stepId: request.stepId,
    stepType: request.stepType,
    command: {
      type: request.command.type,
      payload: request.command.payload,
    },
    budget: request.budget ?? null,
    userSuppliedInput: request.userSuppliedInput ?? null,
  };
}

/** JSON with object keys sorted at every depth, so storage that reorders keys (e.g. Postgres JSONB) hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Key-order independent: the Hub stores the original run request in JSONB and resends that
 * copy on approval resume, which reorders payload keys.
 */
export function requestFingerprint(request: HubRunRequest): string {
  return createHash('sha256').update(canonicalJson(fingerprintBody(request))).digest('hex');
}

/** The pre-canonical fingerprint (insertion order). Accepted only to match runs recorded before the change. */
export function legacyRequestFingerprint(request: HubRunRequest): string {
  return createHash('sha256').update(JSON.stringify(fingerprintBody(request))).digest('hex');
}

/**
 * Fingerprint with operator-approved creative/targeting removed from userSuppliedInput.
 * Used only to bind an approval resume on an awaiting run: the operator may save or
 * change post copy (Hub PUT /v1/goals/:id/creative) after the run was created. Every
 * other field, including the landing URL (the research input revision), still binds.
 */
export function resumeScopeFingerprint(request: HubRunRequest): string {
  const body = fingerprintBody(request);
  const input = request.userSuppliedInput;
  const scoped = input ? { landingPageUrl: input.landingPageUrl } : null;
  return createHash('sha256').update(canonicalJson({ ...body, userSuppliedInput: scoped })).digest('hex');
}

export function hashedRunKey(issuer: string, subject: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${issuer}\n${subject}\n${idempotencyKey}`).digest('hex');
}

export function hashedLlmTurn(messages: unknown, tools: unknown): string {
  return createHash('sha256').update(JSON.stringify({ messages, tools })).digest('hex');
}
