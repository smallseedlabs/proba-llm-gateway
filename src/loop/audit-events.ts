import {
  AUDIT_CONTENT_MAX_CHARS,
  buildAuditContent,
  buildAuditEvent,
  generateSpanId,
  getAuditActionInfo,
  type AuditEvent,
} from '../protocol.js';
import { splitAuditBody } from '../audit/body-chunks.js';
import { gzipBytes } from '../compress.js';
import { maskSecretsInText, redactDetails } from '../redact.js';
import { GATEWAY_SERVICE_NAME } from '../types/config.js';
import type { HubRunRequest } from '../types/run.js';
import type { CompleteRequest, TurnResponse } from '../types/llm.js';

export function gatewayAuditEvent(
  request: HubRunRequest,
  input: {
    action: string;
    outcome: 'success' | 'failure' | 'denied' | 'partial';
    occurredAt: string;
    spanId?: string;
    parentSpanId?: string;
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
    details?: Record<string, unknown>;
    content?: { kind: string; text: string; redactions: number };
    cost?: { tokensIn?: number; tokensOut?: number; currency?: string; amount?: number };
  }
): AuditEvent {
  const info = getAuditActionInfo(input.action);
  return buildAuditEvent({
    traceId: request.traceId,
    spanId: input.spanId ?? generateSpanId(),
    parentSpanId: input.parentSpanId ?? request.parentSpanId,
    workspaceId: request.workspaceId,
    userId: request.userId,
    goalId: request.goalId,
    threadId: request.threadId,
    actor: { type: 'service', id: GATEWAY_SERVICE_NAME },
    service: GATEWAY_SERVICE_NAME,
    action: input.action,
    category: info?.category ?? 'brain',
    outcome: input.outcome,
    errorCode: input.errorCode,
    // Tool and provider messages are not trusted to be secret-free.
    errorMessage: input.errorMessage === undefined ? undefined : maskSecretsInText(input.errorMessage).text.slice(0, 1000),
    riskLevel: info?.riskLevel,
    durationMs: input.durationMs,
    occurredAt: input.occurredAt,
    details: redactDetails(input.details ?? {}),
    cost: input.cost,
    content: input.content
      ? buildAuditContent(input.content.kind, input.content.text, { redactions: input.content.redactions })
      : undefined,
  });
}

export function llmTurnAuditEvents(
  request: HubRunRequest,
  llmRequest: CompleteRequest,
  occurredAt: string,
  result: { kind: 'completed'; response: TurnResponse } | { kind: 'failed' | 'ambiguous'; message: string },
  contentEnabled: boolean,
  maskPii: boolean
): AuditEvent[] {
  const promptMasked = maskSecretsInText(
    llmRequest.messages.map((m) => `${m.role}: ${m.content}`).join('\n'),
    { pii: maskPii }
  );
  const replyText =
    result.kind === 'completed'
      ? [result.response.message.content ?? '', ...(result.response.message.toolCalls ?? []).map((t) => `${t.name}(${t.arguments})`)].join(
          '\n'
        )
      : '';
  const replyMasked = maskSecretsInText(replyText, { pii: maskPii });
  const promptChunks = contentEnabled ? splitAuditBody(promptMasked.text) : [];
  const replyChunks = contentEnabled ? splitAuditBody(replyMasked.text) : [];
  const spanId = generateSpanId();
  const events: AuditEvent[] = [];
  const meta = {
    promptChars: promptMasked.text.length,
    promptGzipBytes: gzipBytes(promptMasked.text),
    promptChunks: promptChunks.length,
    responseChars: replyMasked.text.length,
    responseGzipBytes: gzipBytes(replyMasked.text),
    responseChunks: replyChunks.length,
    contentMaxChars: AUDIT_CONTENT_MAX_CHARS,
  };

  if (result.kind !== 'completed') {
    events.push(
      gatewayAuditEvent(request, {
        action: 'brain.error',
        outcome: 'failure',
        occurredAt,
        spanId,
        errorCode: result.kind === 'ambiguous' ? 'outcome_ambiguous' : 'provider_error',
        errorMessage: result.message,
        details: meta,
        content: promptChunks[0] ? { kind: 'prompt', text: promptChunks[0], redactions: promptMasked.redactions } : undefined,
      })
    );
    for (const chunk of promptChunks.slice(1)) {
      events.push(
        gatewayAuditEvent(request, {
          action: 'brain.prompt_chunk',
          outcome: 'success',
          occurredAt,
          spanId,
          details: { chunk: true },
          content: { kind: 'prompt', text: chunk, redactions: promptMasked.redactions },
        })
      );
    }
    return events;
  }

  events.push(
    gatewayAuditEvent(request, {
      action: 'brain.llm_call',
      outcome: 'success',
      occurredAt,
      spanId,
      durationMs: result.response.latencyMs,
      details: { ...meta, model: result.response.model, provider: result.response.provider },
      cost: {
        tokensIn: result.response.usage.promptTokens,
        tokensOut: result.response.usage.completionTokens,
        ...(result.response.cost.estimate !== 'unknown'
          ? { currency: result.response.cost.currency, amount: result.response.cost.estimate }
          : {}),
      },
      content: promptChunks[0] ? { kind: 'prompt', text: promptChunks[0], redactions: promptMasked.redactions } : undefined,
    })
  );
  for (const chunk of promptChunks.slice(1)) {
    events.push(
      gatewayAuditEvent(request, {
        action: 'brain.prompt_chunk',
        outcome: 'success',
        occurredAt,
        spanId,
        details: { chunk: true },
        content: { kind: 'prompt', text: chunk, redactions: promptMasked.redactions },
      })
    );
  }
  if (replyChunks[0]) {
    events.push(
      gatewayAuditEvent(request, {
        action: 'brain.reply_generated',
        outcome: 'success',
        occurredAt,
        spanId,
        details: { finishReason: result.response.finishReason },
        content: { kind: 'brain_reply', text: replyChunks[0], redactions: replyMasked.redactions },
      })
    );
  }
  for (const chunk of replyChunks.slice(1)) {
    events.push(
      gatewayAuditEvent(request, {
        action: 'brain.reply_chunk',
        outcome: 'success',
        occurredAt,
        spanId,
        details: { chunk: true },
        content: { kind: 'brain_reply', text: chunk, redactions: replyMasked.redactions },
      })
    );
  }
  for (const tool of result.response.message.toolCalls ?? []) {
    events.push(
      gatewayAuditEvent(request, {
        action: 'tool.proposed',
        outcome: 'partial',
        occurredAt,
        spanId,
        details: { name: tool.name, id: tool.id },
      })
    );
  }
  return events;
}
