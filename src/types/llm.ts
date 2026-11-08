/**
 * Neutral one-turn HTTP contract of proba-llm (`POST /v1/complete`).
 * Copied to stay in lockstep with `proba-llm/src/types/turn.ts` — do not invent
 * a parallel schema. Tool calls here are proposals only; this gateway executes
 * tools, never the LLM service.
 */

import { z } from 'zod';
import type { AuditEvent } from '../protocol.js';

export type TraceId = AuditEvent['traceId'];
export type SpanId = AuditEvent['spanId'];
export type WorkspaceId = AuditEvent['workspaceId'];

const uuid = z.string().uuid();
const spanId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((id) => id !== '0000000000000000');

export const llmToolCallSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    arguments: z.string().max(32_768),
  })
  .strict();

export const llmMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    toolCallId: z.string().min(1).max(128).optional(),
    toolCalls: z.array(llmToolCallSchema).max(16).optional(),
    reasoningContent: z.string().max(200_000).nullable().optional(),
  })
  .strict();

/** Body of POST {llm}/v1/complete. Extra keys are refused (strict). */
export const completeRequestSchema = z
  .object({
    traceId: uuid,
    parentSpanId: spanId.optional(),
    workspaceId: z.string().min(1).max(256),
    userId: uuid.optional(),
    goalId: uuid.optional(),
    threadId: uuid.optional(),
    messages: z.array(llmMessageSchema).min(1),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            description: z.string().max(4096).optional(),
            parameters: z.record(z.unknown()).optional(),
          })
          .strict()
      )
      .max(32)
      .optional(),
    json: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(128_000).optional(),
    model: z.string().min(1).max(128).optional(),
    idempotencyKey: uuid.optional(),
  })
  .strict();

export type CompleteRequest = z.infer<typeof completeRequestSchema>;
export type TurnRequest = CompleteRequest;
export type LlmMessage = z.infer<typeof llmMessageSchema>;
export type LlmToolCall = z.infer<typeof llmToolCallSchema>;

/**
 * Cost from proba-llm. `unknown` means the LLM service had no configured
 * pricing — treat as unknown, never as 0.
 */
export const costEstimateSchema = z.union([
  z.object({ estimate: z.literal('unknown') }).strict(),
  z
    .object({
      estimate: z.number(),
      currency: z.literal('USD'),
      pricingVersion: z.string().min(1),
    })
    .strict(),
]);

export type CostEstimate = z.infer<typeof costEstimateSchema>;

export const turnResponseSchema = z
  .object({
    message: z
      .object({
        role: z.literal('assistant'),
        content: z.string().nullable(),
        toolCalls: z.array(llmToolCallSchema).optional(),
        reasoningContent: z.string().max(200_000).nullable().optional(),
      })
      .strict(),
    finishReason: z.enum(['stop', 'tool_calls', 'length', 'unknown']),
    model: z.string().min(1),
    provider: z.string().min(1),
    usage: z
      .object({
        promptTokens: z.number().nonnegative().optional(),
        completionTokens: z.number().nonnegative().optional(),
        cachedTokens: z.number().nonnegative().optional(),
        reasoningTokens: z.number().nonnegative().optional(),
      })
      .strict(),
    latencyMs: z.number().nonnegative(),
    cost: costEstimateSchema,
    cached: z.boolean().optional(),
  })
  .strict();

export type TurnResponse = z.infer<typeof turnResponseSchema>;

export const llmErrorBodySchema = z
  .object({
    error: z.string().min(1),
    message: z.string(),
  })
  .strict();
