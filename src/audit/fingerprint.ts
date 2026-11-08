import { createHash } from 'node:crypto';
import type { HubRunRequest } from '../types/run.js';

/**
 * Canonical hash of the Hub run payload (not caller identity).
 * `resume` and `actAsAssertion` are excluded so an approval continuation is
 * the same run, not a fingerprint conflict.
 */
export function requestFingerprint(request: HubRunRequest): string {
  const canonical = JSON.stringify({
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
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function hashedRunKey(issuer: string, subject: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${issuer}\n${subject}\n${idempotencyKey}`).digest('hex');
}

export function hashedLlmTurn(messages: unknown, tools: unknown): string {
  return createHash('sha256').update(JSON.stringify({ messages, tools })).digest('hex');
}
