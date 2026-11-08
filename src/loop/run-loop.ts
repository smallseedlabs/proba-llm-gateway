import { randomUUID } from 'node:crypto';
import {
  AmbiguousOutcomeError,
  ApprovalRequiredError,
  BudgetExhaustedError,
  PolicyDeniedError,
  PreflightBlockedError,
  ToolRefusedError,
} from '../errors.js';
import type { AdsDomainPort } from '../ports/ads.js';
import {
  applyPreflightToRecord,
  graphAuditDetails,
  invalidateAdsRemoteEvidence,
  offeredToolFilter,
  runPreflight,
} from '../preflight/engine.js';
import type { CapabilityNeed } from '../types/preflight.js';
import { canonicalArgsHash } from '../audit/canonical.js';
import { hashedLlmTurn } from '../audit/fingerprint.js';
import type { BrainOutput, ContextPacket } from '../protocol.js';
import type { ApprovalGate } from '../ports/approval.js';
import type { ContextPort } from '../ports/context.js';
import { ContextClientError } from '../ports/context.js';
import type { LimbExecutor } from '../ports/limbs.js';
import { LlmClientError, type LlmClient } from '../ports/llm-client.js';
import type { PolicyEngine } from '../ports/policy.js';
import type { LlmTurnRecord, PendingApproval, RunRecord, ToolTurnRecord } from '../ports/run-store.js';
import type { Clock } from '../ports/clock.js';
import type { GatewayServiceConfig } from '../types/config.js';
import type { CompleteRequest, LlmToolCall, TurnResponse } from '../types/llm.js';
import type { HubRunRequest, RunSnapshot, RunStatus } from '../types/run.js';
import type { RunUsageLedger } from '../usage/reservations.js';
import type { Cancellation } from '../ports/cancellation.js';
import { initialMessages, offeredTools, parseToolArguments, refreshSystem } from './messages.js';
import { gatewayAuditEvent, llmTurnAuditEvents } from './audit-events.js';
import { RequestValidationError } from '../errors.js';

export interface LoopBodyDeps {
  config: GatewayServiceConfig;
  clock: Clock;
  llm: LlmClient;
  context: ContextPort;
  policy: PolicyEngine;
  approval: ApprovalGate;
  tools: LimbExecutor;
  ads: AdsDomainPort;
  persist: (record: RunRecord) => Promise<void>;
  relay: (record: RunRecord) => Promise<void>;
}

export async function runBoundedLoop(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest,
  cancellation: Cancellation,
  usage: RunUsageLedger
): Promise<RunSnapshot> {
    if (record.pendingApproval && request.resume) {
    try {
      await dispatchTools(deps, record, request, record.pendingApproval.remainingToolCalls, cancellation, usage);
    } catch (err) {
      if (err instanceof PreflightBlockedError) {
        return blockedSnapshot(deps, record, err.needs as CapabilityNeed[]);
      }
      throw err;
    }
    if (record.pendingApproval && record.state === 'awaiting_approval' && record.snapshot) return record.snapshot;
  }

  const hardCap = Math.max(1, deps.config.limits.maxIterations) + 1;
  for (let n = 0; n < hardCap; n += 1) {
    cancellation.throwIfAborted();
    const preflight = await runPreflight(
      { config: deps.config, clock: deps.clock, ads: deps.ads, llm: deps.llm },
      request,
      record,
      usage,
      cancellation.signal,
      { phase: 'brain' }
    );
    applyPreflightToRecord(record, preflight);
    record.events.push(
      gatewayAuditEvent(request, {
        action: preflight.allowed ? 'command.processed' : 'policy.denied',
        outcome: preflight.allowed ? (preflight.relaxed.length > 0 ? 'partial' : 'success') : 'denied',
        occurredAt: deps.clock.isoNow(),
        errorCode: preflight.allowed ? undefined : 'preflight_blocked',
        errorMessage: preflight.allowed ? undefined : preflight.needs[0]?.message,
        details: graphAuditDetails(preflight),
      })
    );
    await deps.persist(record);
    if (!preflight.allowed) {
      const budget = preflight.needs.find((need) => need.capability === 'run.budget');
      if (budget) throw new BudgetExhaustedError(budget.message);
      return blockedSnapshot(deps, record, preflight.needs);
    }

    const iteration = usage.recordIteration();
    record.iteration = iteration;

    const packet = await loadContext(deps, record, request, cancellation, usage);
    record.messages = record.messages.length === 0 ? initialMessages(packet, request) : refreshSystem(record.messages, packet);

    usage.assertCanCallLlm();
    const turn = await callLlm(deps, record, request, cancellation, usage, offeredToolFilter(preflight.offeredLimbs));
    if (turn.finishReason === 'tool_calls' && turn.message.toolCalls?.length) {
      try {
        await dispatchTools(deps, record, request, turn.message.toolCalls, cancellation, usage);
      } catch (err) {
        if (err instanceof PreflightBlockedError) {
          return blockedSnapshot(deps, record, err.needs as CapabilityNeed[]);
        }
        throw err;
      }
      if (record.pendingApproval && record.state === 'awaiting_approval' && record.snapshot) return record.snapshot;
      continue;
    }
    const text = turn.message.content ?? '';
    return finish(deps, record, 'completed', [{ type: 'reply', text }]);
  }
  throw new BudgetExhaustedError(`iteration cap ${deps.config.limits.maxIterations} reached`);
}

async function loadContext(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest,
  cancellation: Cancellation,
  usage: RunUsageLedger
): Promise<ContextPacket | undefined> {
  const testSkip = deps.config.env === 'test' && !request.actAsAssertion;
  if (!testSkip && (!request.actAsAssertion || !request.goalId || !request.threadId)) {
    throw new RequestValidationError('context enrichment requires actAsAssertion, goalId and threadId');
  }
  const assertion = request.actAsAssertion ?? 'test';
  if (!request.actAsAssertion && deps.config.env !== 'test') {
    throw new RequestValidationError('context enrichment requires actAsAssertion, goalId and threadId');
  }
  try {
    const packet = await deps.context.build(
      {
        traceId: request.traceId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId ?? '11111111-1111-4111-8111-111111111111',
        threadId: request.threadId ?? '11111111-1111-4111-8111-111111111112',
        stepId: request.stepId,
        stepType: request.stepType,
        budgetTokens: usage.contextBudgetTokens(),
      },
      { assertion, signal: cancellation.signal }
    );
    record.events.push(
      gatewayAuditEvent(request, {
        action: 'brain.context_attached',
        outcome: 'success',
        occurredAt: deps.clock.isoNow(),
        details: { packetId: packet.packetId, packetHash: packet.packetHash, stepId: request.stepId, stepType: request.stepType },
      })
    );
    return packet;
  } catch (err) {
    if (err instanceof ContextClientError) {
      throw new RequestValidationError(`context build failed: ${err.message}`);
    }
    throw err;
  }
}

async function callLlm(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest,
  cancellation: Cancellation,
  usage: RunUsageLedger,
  limbFilter?: (name: string) => boolean
): Promise<TurnResponse> {
  const tools = offeredTools(limbFilter);
  const fingerprint = hashedLlmTurn(record.messages, tools);
  const existing = record.llmTurns.find((t) => t.fingerprint === fingerprint);
  if (existing?.state === 'completed' && existing.response) return existing.response;
  if (existing?.state === 'ambiguous' || existing?.state === 'inflight') {
    throw new AmbiguousOutcomeError('LLM turn was dispatched and is not safe to retry');
  }

  const remainingCompletion =
    deps.config.limits.maxCompletionTokens === null
      ? deps.config.limits.responseTokenReserve
      : Math.max(1, deps.config.limits.maxCompletionTokens - usage.snapshot().completionTokens);
  const reserve = deps.config.limits.responseTokenReserve || remainingCompletion;
  const maxTokens = Math.max(1, Math.min(reserve, remainingCompletion));

  const llmRequest: CompleteRequest = {
    traceId: request.traceId,
    parentSpanId: request.parentSpanId,
    workspaceId: request.workspaceId,
    userId: request.userId,
    goalId: request.goalId,
    threadId: request.threadId,
    messages: record.messages,
    tools,
    maxTokens,
    idempotencyKey: randomUUID(),
  };
  const turn: LlmTurnRecord = {
    idempotencyKey: llmRequest.idempotencyKey!,
    fingerprint,
    state: 'inflight',
    request: llmRequest,
  };
  record.llmTurns.push(turn);
  record.state = 'running';
  record.updatedAt = deps.clock.isoNow();
  await deps.persist(record);
  cancellation.throwIfAborted();
  try {
    const response = await deps.llm.complete(llmRequest, { idempotencyKey: turn.idempotencyKey, signal: cancellation.signal });
    turn.state = 'completed';
    turn.response = response;
    usage.recordLlmTurn(response);
    record.usage = usage.snapshot();
    record.events.push(
      ...llmTurnAuditEvents(
        request,
        llmRequest,
        deps.clock.isoNow(),
        { kind: 'completed', response },
        deps.config.audit.contentEnabled,
        deps.config.audit.contentMaskPii
      )
    );
    await deps.persist(record);
    await deps.relay(record);
    return response;
  } catch (err) {
    const ambiguous =
      (err instanceof LlmClientError && (err.code === 'provider_ambiguous' || err.code === 'aborted')) || cancellation.signal.aborted;
    turn.state = ambiguous ? 'ambiguous' : 'failed';
    turn.errorCode = err instanceof LlmClientError ? err.code : 'provider_error';
    turn.errorMessage = err instanceof Error ? err.message : 'llm error';
    record.events.push(
      ...llmTurnAuditEvents(
        request,
        llmRequest,
        deps.clock.isoNow(),
        { kind: ambiguous ? 'ambiguous' : 'failed', message: turn.errorMessage },
        deps.config.audit.contentEnabled,
        deps.config.audit.contentMaskPii
      )
    );
    await deps.persist(record);
    await deps.relay(record);
    if (ambiguous) throw new AmbiguousOutcomeError(turn.errorMessage);
    throw err;
  }
}

async function dispatchTools(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest,
  toolCalls: LlmToolCall[],
  cancellation: Cancellation,
  usage: RunUsageLedger
): Promise<void> {
  const alreadyAssistant = record.messages[record.messages.length - 1]?.role === 'assistant';
  if (!alreadyAssistant) {
    record.messages.push({ role: 'assistant', content: '', toolCalls });
  }

  for (let i = 0; i < toolCalls.length; i += 1) {
    cancellation.throwIfAborted();
    const call = toolCalls[i];
    if (!call) continue;
    const args = parseToolArguments(call.arguments);
    if (!args) {
      record.messages.push({
        role: 'tool',
        content: JSON.stringify({ ok: false, code: 'invalid_args', message: 'tool arguments are not a JSON object' }),
        toolCallId: call.id,
      });
      continue;
    }
    const decision = deps.policy.evaluate(call.name, args, {
      workspaceId: request.workspaceId,
      userId: request.userId,
      goalId: request.goalId,
    });
    if (!decision.allowed) {
      record.events.push(
        gatewayAuditEvent(request, {
          action: 'policy.denied',
          outcome: 'denied',
          occurredAt: deps.clock.isoNow(),
          details: { verb: call.name, code: decision.code },
        })
      );
      record.messages.push({
        role: 'tool',
        content: JSON.stringify({ ok: false, code: decision.code, message: decision.reason }),
        toolCallId: call.id,
      });
      if (decision.code === 'unknown_verb' || decision.code === 'allowlist') continue;
      throw new PolicyDeniedError(decision.reason);
    }

    const argsHash = canonicalArgsHash(decision.args);
    const existing = record.toolTurns.find((t) => t.toolCallId === call.id && t.argsHash === argsHash);
    if (existing?.state === 'completed' && existing.result) {
      record.messages.push({ role: 'tool', content: JSON.stringify(existing.result), toolCallId: call.id });
      continue;
    }
    if (existing?.state === 'ambiguous' || existing?.state === 'inflight') {
      throw new AmbiguousOutcomeError(`tool ${call.name} was dispatched and is not safe to retry`);
    }

    usage.assertCanCallTool();
    const pending = record.pendingApproval;
    const pendingMatches =
      !!pending &&
      pending.workspaceId === request.workspaceId &&
      pending.verbName === decision.verb.name &&
      pending.argsHash === argsHash;
    const askId = pendingMatches ? pending.askId : randomUUID();
    if (pending && pending.toolCallId === call.id && !pendingMatches) {
      throw new PolicyDeniedError('approval does not bind this operation, arguments and workspace');
    }
    const resume = request.resume ?? record.lastResume;
    const approval = decision.verb.requiresApproval
      ? deps.approval.decide(
          {
            askId,
            runId: record.runId,
            workspaceId: request.workspaceId,
            verb: decision.verb,
            args: decision.args,
            argsHash,
            risk: decision.verb.risk,
          },
          resume
        )
      : { status: 'granted' as const, resume: resume ?? { askId, choice: 'approve' as const } };

    if (approval.status === 'pending') {
      const pending: PendingApproval = {
        askId,
        runId: record.runId,
        workspaceId: request.workspaceId,
        verbName: decision.verb.name,
        args: decision.args,
        argsHash,
        callId: call.id,
        toolCallId: call.id,
        remainingToolCalls: toolCalls.slice(i),
      };
      record.pendingApproval = pending;
      record.state = 'awaiting_approval';
      const toolOutput: BrainOutput = {
        type: 'tool_call',
        tool: decision.verb.name,
        parameters: decision.args,
        needsApproval: true,
        risk: decision.verb.risk,
      };
      record.snapshot = {
        ...snapshotOf(record, 'awaiting_approval', undefined, [toolOutput]),
        needs: [
          {
            type: 'approval',
            askId,
            verb: decision.verb.name,
            argsHash,
            workspaceId: request.workspaceId,
          },
        ],
      };
      record.events.push(
        gatewayAuditEvent(request, {
          action: 'approval.requested',
          outcome: 'partial',
          occurredAt: deps.clock.isoNow(),
          details: { askId, verb: decision.verb.name, argsHash, workspaceId: request.workspaceId },
        })
      );
      await deps.persist(record);
      await deps.relay(record);
      throw new ApprovalRequiredError();
    }
    if (approval.status === 'rejected') {
      record.pendingApproval = undefined;
      record.messages.push({
        role: 'tool',
        content: JSON.stringify({ ok: false, code: 'approval_rejected', message: 'Hub rejected this side effect' }),
        toolCallId: call.id,
      });
      record.events.push(
        gatewayAuditEvent(request, {
          action: 'approval.rejected',
          outcome: 'denied',
          occurredAt: deps.clock.isoNow(),
          details: { askId, verb: decision.verb.name },
        })
      );
      request.resume = undefined;
      continue;
    }

    const toolIdempotency = existing?.idempotencyKey ?? randomUUID();
    const toolTurn: ToolTurnRecord = {
      idempotencyKey: toolIdempotency,
      callId: call.id,
      toolCallId: call.id,
      verbName: decision.verb.name,
      argsHash,
      workspaceId: request.workspaceId,
      state: 'inflight',
      args: decision.args,
    };
    const mutationPreflight = await runPreflight(
      { config: deps.config, clock: deps.clock, ads: deps.ads, llm: deps.llm },
      request,
      record,
      usage,
      cancellation.signal,
      { phase: 'mutate', mutate: { verb: decision.verb.name, args: decision.args } }
    );
    applyPreflightToRecord(record, mutationPreflight);
    record.events.push(
      gatewayAuditEvent(request, {
        action: mutationPreflight.allowed ? 'command.processed' : 'policy.denied',
        outcome: mutationPreflight.allowed ? (mutationPreflight.relaxed.length > 0 ? 'partial' : 'success') : 'denied',
        occurredAt: deps.clock.isoNow(),
        errorCode: mutationPreflight.allowed ? undefined : 'preflight_blocked',
        errorMessage: mutationPreflight.allowed ? undefined : mutationPreflight.needs[0]?.message,
        details: graphAuditDetails(mutationPreflight),
      })
    );
    if (decision.verb.limb === 'ads' && !mutationPreflight.allowed) {
      throw new PreflightBlockedError(
        mutationPreflight.needs[0]?.message ?? 'mutating Ads work is blocked; preflight is not spending approval',
        mutationPreflight.needs
      );
    }
    record.toolTurns.push(toolTurn);
    record.pendingApproval = undefined;
    record.lastResume = undefined;
    record.state = 'running';
    record.snapshot = undefined;
    request.resume = undefined;
    await deps.persist(record);
    try {
      const result = await deps.tools.execute(
        { callId: call.id, verb: decision.verb, args: decision.args, idempotencyKey: toolIdempotency },
        {
          workspaceId: request.workspaceId,
          userId: request.userId,
          goalId: request.goalId,
          threadId: request.threadId,
          traceId: request.traceId,
          signal: cancellation.signal,
          approval,
          domainState: record.domainState,
        }
      );
      toolTurn.state = 'completed';
      toolTurn.result = result;
      usage.recordToolCall();
      record.usage = usage.snapshot();
      record.messages.push({ role: 'tool', content: JSON.stringify(result), toolCallId: call.id });
      if (decision.verb.limb === 'ads' && record.lastPreflight) {
        record.lastPreflight = {
          ...record.lastPreflight,
          evidence: invalidateAdsRemoteEvidence(record.lastPreflight.evidence),
        };
      }
      record.events.push(
        gatewayAuditEvent(request, {
          action: result.ok ? 'tool.executed' : 'tool.failed',
          outcome: result.ok ? 'success' : 'failure',
          occurredAt: deps.clock.isoNow(),
          details: { verb: decision.verb.name, argsHash },
        })
      );
      await deps.persist(record);
      await deps.relay(record);
    } catch (err) {
      const aborted = cancellation.signal.aborted || (err instanceof ToolRefusedError && /ambiguous/.test(err.message));
      toolTurn.state = aborted ? 'ambiguous' : 'failed';
      toolTurn.result = {
        ok: false,
        code: aborted ? 'outcome_ambiguous' : 'tool_failed',
        message: err instanceof Error ? err.message : 'tool failed',
      };
      await deps.persist(record);
      if (aborted) throw new AmbiguousOutcomeError(toolTurn.result.message);
      throw err;
    }
  }
}

async function blockedSnapshot(
  deps: Pick<LoopBodyDeps, 'clock' | 'persist' | 'relay'>,
  record: RunRecord,
  needs: CapabilityNeed[]
): Promise<RunSnapshot> {
  const questions = needs.map((need) => need.question ?? need.message);
  return finish(
    deps,
    record,
    'blocked',
    [
      {
        type: 'clarify',
        reason: needs[0]?.message ?? 'required capabilities are not ready; no paid model call was made',
        questions: questions.map((text, i) => ({ id: `cap-${i + 1}`, text, type: 'text' as const })),
      },
    ],
    { code: 'preflight_blocked', message: needs[0]?.message ?? 'preflight blocked', retryable: true },
    needs
  );
}

export function snapshotOf(
  record: RunRecord,
  status: RunStatus,
  error?: { code: string; message: string; retryable: boolean },
  outputs?: BrainOutput[]
): RunSnapshot {
  return {
    runId: record.runId,
    status,
    iteration: record.iteration,
    outputs,
    usage: record.usage,
    progress: { runId: record.runId, status, iteration: record.iteration, usage: record.usage },
    error,
  };
}

export async function finish(
  deps: Pick<LoopBodyDeps, 'clock' | 'persist' | 'relay'>,
  record: RunRecord,
  status: RunStatus,
  outputs: BrainOutput[],
  error?: { code: string; message: string; retryable: boolean },
  needs?: unknown[]
): Promise<RunSnapshot> {
  record.state = status;
  record.snapshot = { ...snapshotOf(record, status, error, outputs), ...(needs ? { needs } : {}) };
  record.updatedAt = deps.clock.isoNow();
  record.events.push(
    gatewayAuditEvent(record.request, {
      action: status === 'completed' ? 'command.processed' : 'brain.error',
      outcome: status === 'completed' ? 'success' : 'failure',
      occurredAt: record.updatedAt,
      errorCode: error?.code,
      errorMessage: error?.message,
      details: { runId: record.runId, status },
    })
  );
  await deps.persist(record);
  await deps.relay(record);
  return record.snapshot;
}
