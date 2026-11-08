/**
 * Hub ↔ gateway HTTP contract. Not a protocol command/event schema: the
 * `command` field IS the protocol CommandEnvelope. Progress/final payloads
 * reuse protocol BrainOutput / StatusPayload. Hub owns user-facing
 * approvals, pause, and emergency stop; this service never presents those UIs.
 *
 * Failure / resume / stop (review these before wiring the loop):
 * - Pause: Hub sets execution_state=paused and should not call here. If a
 *   pause/cancel arrives mid-run, abort with reason hub_pause; do not start
 *   another LLM turn or tool. Pause does not grant approvals.
 * - Emergency stop (Hub control kill): abort with emergency_stop; no further
 *   paid calls or side-effecting tools. Resume from killed is Hub's problem;
 *   this service does not auto-continue.
 * - Approval: side-effecting verbs emit awaiting_approval and return. The
 *   loop MUST NOT treat a missing resume as grant. Hub collects the user
 *   answer and calls POST /v1/runs again with `resume`.
 * - Disconnect: AbortSignal from the HTTP request; same as cancel for
 *   in-flight work. If a paid LLM call was already dispatched, record
 *   ambiguous and do not retry that idempotency key.
 * - Deadline: abort with deadline; same no-retry rule for ambiguous paid work.
 */

import { z } from 'zod';
import { commandEnvelopeSchema, stepTypeSchema } from '../protocol.js';
import { usageTotalsSchema } from './usage.js';

const uuid = z.string().uuid();
const spanId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((id) => id !== '0000000000000000');

export const runBudgetSchema = z
  .object({
    maxIterations: z.number().int().positive().max(64).optional(),
    maxLlmCalls: z.number().int().positive().max(64).optional(),
    maxToolCalls: z.number().int().positive().max(256).optional(),
    maxPromptTokens: z.number().int().positive().optional(),
    maxCompletionTokens: z.number().int().positive().optional(),
    maxTotalTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    responseTokenReserve: z.number().int().nonnegative().max(128_000).optional(),
    /** ContextRequest.budgetTokens cap for this run; still protocol-shaped. */
    contextBudgetTokens: z.number().int().positive().optional(),
    deadlineMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict();

export type RunBudget = z.infer<typeof runBudgetSchema>;

/**
 * Hub-collected user decision. Absence is not approval. `choice` matches
 * protocol AnswerAskPayload / ApprovePlanPayload.
 */
export const resumeApprovalSchema = z
  .object({
    askId: uuid,
    choice: z.enum(['approve', 'reject', 'edit']),
    values: z.record(z.unknown()).optional(),
    edit: z.string().optional(),
    planId: uuid.optional(),
    approved: z.boolean().optional(),
  })
  .strict();

export type ResumeApproval = z.infer<typeof resumeApprovalSchema>;

export const hubRunRequestSchema = z
  .object({
    traceId: uuid,
    parentSpanId: spanId.optional(),
    workspaceId: z.string().min(1).max(256),
    userId: uuid,
    goalId: uuid.optional(),
    threadId: uuid.optional(),
    stepId: z.string().min(1).max(256),
    stepType: stepTypeSchema,
    command: commandEnvelopeSchema,
    /**
     * Hub-minted act-as JWT (iss=proba-hub, aud includes proba-context).
     * Gateway verifies then forwards it as Authorization to POST /v1/context/build.
     */
    actAsAssertion: z.string().min(1).max(8192).optional(),
    idempotencyKey: uuid.optional(),
    budget: runBudgetSchema.optional(),
    resume: resumeApprovalSchema.optional(),
  })
  .strict();

export type HubRunRequest = z.infer<typeof hubRunRequestSchema>;

export const runStatusSchema = z.enum([
  'accepted',
  'running',
  'awaiting_approval',
  'paused',
  'stopped',
  'completed',
  'failed',
  'cancelled',
  'ambiguous',
  'blocked',
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const runProgressSchema = z
  .object({
    runId: uuid,
    status: runStatusSchema,
    iteration: z.number().int().nonnegative(),
    message: z.string().max(500).optional(),
    usage: usageTotalsSchema,
  })
  .strict();

export type RunProgress = z.infer<typeof runProgressSchema>;

export const runCancelRequestSchema = z
  .object({
    reason: z.enum(['hub_cancel', 'hub_pause', 'emergency_stop']).default('hub_cancel'),
  })
  .strict();

export type RunCancelRequest = z.infer<typeof runCancelRequestSchema>;

export const runErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

/**
 * Final (or terminal intermediate) snapshot returned to Hub.
 * `outputs` are protocol BrainOutput values when the loop has produced them.
 * This slice does not populate outputs from a mock success path.
 */
export const runSnapshotSchema = z
  .object({
    runId: uuid,
    status: runStatusSchema,
    iteration: z.number().int().nonnegative(),
    outputs: z.array(z.unknown()).optional(),
    needs: z.array(z.unknown()).optional(),
    progress: runProgressSchema.optional(),
    usage: usageTotalsSchema,
    error: runErrorSchema.optional(),
  })
  .strict();

export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
