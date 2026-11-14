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
import type { ResearchArtifactStore } from '../ports/research.js';
import type { AnalyticsDecisionStore } from '../analytics/store.js';
import type { ActionOutcomeStore, ActionPolicyStore } from '../action-policy/store.js';
import { campaignIdOf, evaluateActionPolicy } from '../action-policy/evaluate.js';
import { runAnalyticsReview } from './analytics-review.js';
import { approvedActionFromRequest, runApprovedAction } from './approved-action.js';
import { verbByName } from '../limbs/catalog.js';
import { applyResearchResume, isResearchAcceptPending } from '../research/acceptance.js';
import { lookupCurrentArtifact } from '../research/gather.js';
import { readUserSuppliedLanding } from '../research/input.js';
import type { ResearchArtifact } from '../types/research.js';
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
import type { CompleteRequest, LlmMessage, LlmToolCall, TurnResponse } from '../types/llm.js';
import type { HubRunRequest, RunSnapshot, RunStatus } from '../types/run.js';
import type { RunUsageLedger } from '../usage/reservations.js';
import type { Cancellation } from '../ports/cancellation.js';
import { initialMessages, offeredTools, parseToolArguments, refreshSystem, runBudgetMessage } from './messages.js';
import type { RunBriefFacts } from './brief.js';
import { creativeRulesFrom, NO_GUARDRAILS, verbMode } from '../guardrails/guardrails.js';
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
  researchStore: ResearchArtifactStore;
  analyticsStore: AnalyticsDecisionStore;
  actionPolicyStore: ActionPolicyStore;
  actionOutcomeStore: ActionOutcomeStore;
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
      if (isResearchAcceptPending(record.pendingApproval)) {
        const leftover = await settleResearchAcceptance(deps, record, request);
        if (leftover === 'wait') {
          return record.snapshot ?? snapshotOf(record, 'awaiting_approval');
        }
        if (leftover.length > 0) {
          await dispatchTools(deps, record, request, leftover, cancellation, usage);
        }
      } else {
        await dispatchTools(deps, record, request, record.pendingApproval.remainingToolCalls, cancellation, usage);
      }
    } catch (err) {
      if (err instanceof PreflightBlockedError) {
        return blockedSnapshot(deps, record, err.needs as CapabilityNeed[]);
      }
      throw err;
    }
    if (record.pendingApproval && record.state === 'awaiting_approval' && record.snapshot) return record.snapshot;
  }

  if (request.stepType === 'review_performance') {
    return runAnalyticsReview(deps, record, request, cancellation, usage);
  }

  const approvedAction = approvedActionFromRequest(request);
  if (approvedAction) {
    return runApprovedAction(deps, record, request, approvedAction, cancellation, usage);
  }

  const hardCap = Math.max(1, deps.config.limits.maxIterations) + 1;
  for (let n = 0; n < hardCap; n += 1) {
    cancellation.throwIfAborted();
    const preflight = await runPreflight(
      { config: deps.config, clock: deps.clock, ads: deps.ads, llm: deps.llm, context: deps.context, researchStore: deps.researchStore },
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
      if (budget?.state === 'insufficient') throw new BudgetExhaustedError(budget.message);
      return blockedSnapshot(deps, record, preflight.needs);
    }

    let packet: ContextPacket | undefined;
    try {
      packet = await loadContext(deps, record, request, cancellation, usage);
    } catch (err) {
      if (err instanceof ContextClientError || err instanceof RequestValidationError) {
        return blockedSnapshot(deps, record, [
          {
            type: 'capability',
            capability: 'context.ready',
            state: err instanceof ContextClientError && err.code === 'timeout' ? 'unavailable' : 'unavailable',
            message: err.message,
          },
        ]);
      }
      throw err;
    }
    const iteration = usage.recordIteration();
    record.iteration = iteration;
    const guardrails = deps.config.guardrails ?? NO_GUARDRAILS;
    const limbFilter = offeredToolFilter(preflight.offeredLimbs);
    // Operator guardrails can only remove verbs: a denied verb is not offered (and is refused if called anyway).
    const toolFilter = (name: string) => limbFilter(name) && verbMode(guardrails, name) !== 'deny';
    const brief: RunBriefFacts = {
      offeredTools: offeredTools(toolFilter).map((t) => t.name),
      deniedByGuardrails: Object.entries(guardrails.verbs).filter(([, mode]) => mode === 'deny').map(([name]) => name),
    };
    record.messages =
      record.messages.length === 0 ? initialMessages(packet, request, brief) : refreshSystem(record.messages, packet, request, brief);

    usage.assertCanCallLlm();
    const turn = await callLlm(deps, record, request, cancellation, usage, toolFilter, runBudgetMessage(usage.budgetView()));
    if (turn.finishReason === 'tool_calls' && turn.message.toolCalls?.length) {
      try {
        await dispatchTools(deps, record, request, turn.message.toolCalls, cancellation, usage, turn.message);
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
        goalId: request.goalId!,
        threadId: request.threadId!,
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
  limbFilter?: (name: string) => boolean,
  trailer?: LlmMessage
): Promise<TurnResponse> {
  const tools = offeredTools(limbFilter);
  // The trailing per-loop message (run budget) is sent but not stored in the run's messages, so earlier turns stay a stable prefix.
  const messages = trailer ? [...record.messages, trailer] : record.messages;
  const fingerprint = hashedLlmTurn(messages, tools);
  const existing = record.llmTurns.find((t) => t.fingerprint === fingerprint);
  if (existing?.state === 'completed' && existing.response) return existing.response;
  if (existing?.state === 'ambiguous' || existing?.state === 'inflight') {
    throw new AmbiguousOutcomeError('LLM turn was dispatched and is not safe to retry');
  }

  const maxTokens = usage.completionTokenCap();

  const llmRequest: CompleteRequest = {
    traceId: request.traceId,
    parentSpanId: request.parentSpanId,
    workspaceId: request.workspaceId,
    userId: request.userId,
    goalId: request.goalId,
    threadId: request.threadId,
    messages,
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
    usage.recordLlmDispatchFailure();
    record.usage = usage.snapshot();
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
  usage: RunUsageLedger,
  assistant?: TurnResponse['message']
): Promise<void> {
  if (assistant) {
    record.messages.push({
      role: 'assistant',
      content: assistant.content ?? '',
      toolCalls,
      ...(assistant.reasoningContent != null && assistant.reasoningContent !== ''
        ? { reasoningContent: assistant.reasoningContent }
        : {}),
    });
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
      threadId: request.threadId,
      userSuppliedInput: request.userSuppliedInput,
      ...(call.name === 'creative.draft_post'
        ? {
            acceptedResearch: await acceptedResearchFor(deps, request),
            creativeRules: creativeRulesFrom(deps.config.guardrails ?? NO_GUARDRAILS),
          }
        : {}),
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
      // Refused, but not fatal: the model is told what is missing (operator copy) and can tell the
      // operator what to do. The create itself never runs without creative.
      if (
        decision.code === 'unknown_verb' ||
        decision.code === 'allowlist' ||
        decision.code === 'creative_missing' ||
        decision.code === 'creative_invalid' ||
        decision.code === 'research_not_accepted'
      )
        continue;
      throw new PolicyDeniedError(decision.reason);
    }

    // Only modes the operator configured act here; the code's own approval rules (incl. owner auto_with_limits) are unchanged.
    const guardrailMode = (deps.config.guardrails ?? NO_GUARDRAILS).verbs[decision.verb.name];
    if (guardrailMode === 'deny') {
      record.events.push(
        gatewayAuditEvent(request, {
          action: 'policy.denied',
          outcome: 'denied',
          occurredAt: deps.clock.isoNow(),
          details: { verb: call.name, code: 'guardrail', guardrailsVersion: (deps.config.guardrails ?? NO_GUARDRAILS).version },
        })
      );
      record.messages.push({
        role: 'tool',
        content: JSON.stringify({
          ok: false,
          code: 'guardrail',
          message: `${decision.verb.name} is turned off by the operator's guardrails. Tell the operator it is blocked by guardrails and that changing the guardrails config would unblock it.`,
        }),
        toolCallId: call.id,
      });
      continue;
    }

    const argsHash = canonicalArgsHash(decision.args);
    const documents = await deps.actionPolicyStore.list(request.workspaceId);
    const campaignId = campaignIdOf(decision.args, request);
    const lastOutcome = await deps.actionOutcomeStore.get({
      workspaceId: request.workspaceId,
      userId: request.userId,
      verb: decision.verb.name,
      probaCampaignId: campaignId,
      argsHash,
    });
    const action = evaluateActionPolicy({
      verb: decision.verb,
      args: decision.args,
      request,
      documents,
      last: lastOutcome,
      now: deps.clock.now(),
    });
    record.events.push(
      gatewayAuditEvent(request, {
        action: action.mode === 'deny' ? 'policy.denied' : 'brain.decision_made',
        outcome: action.mode === 'deny' ? 'denied' : 'success',
        occurredAt: deps.clock.isoNow(),
        details: {
          evaluator: 'action_policy',
          verb: decision.verb.name,
          mode: action.mode,
          policyId: action.policyId,
          policyVersion: action.policyVersion,
          grantsSpend: false,
          requiresHubApproval: action.requiresHubApproval,
          clampedFromAuto: action.clampedFromAuto,
          gate: action.gate,
          immutable: action.immutable,
          argsHash,
        },
      })
    );
    if (action.mode === 'deny') {
      throw new PolicyDeniedError(action.gate?.message ?? `${decision.verb.name} is denied by owner policy`);
    }

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
    // Guardrail `ask` adds an approval card where the code would not need one; it never removes one.
    const approval = action.requiresHubApproval || guardrailMode === 'ask'
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
      { config: deps.config, clock: deps.clock, ads: deps.ads, llm: deps.llm, context: deps.context, researchStore: deps.researchStore },
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
    if ((decision.verb.limb === 'ads' || decision.verb.limb === 'research') && !mutationPreflight.allowed) {
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
          errorCode: result.ok ? undefined : result.code,
          errorMessage: result.ok ? undefined : result.message,
          details: {
            verb: decision.verb.name,
            argsHash,
            actionPolicyMode: action.mode,
            policyId: action.policyId,
            policyVersion: action.policyVersion,
            grantsSpend: false,
            hubApproval: action.requiresHubApproval,
          },
        })
      );
      if (result.ok && action.mode === 'auto_with_limits' && action.gate?.code !== 'cooldown') {
        const cooldownMs = documents.find((d) => d.policyId === action.policyId)?.limits?.cooldownMs ?? deps.config.actionPolicy.cooldownMs;
        await deps.actionOutcomeStore.put({
          workspaceId: request.workspaceId,
          userId: request.userId,
          verb: decision.verb.name,
          probaCampaignId: campaignId,
          argsHash,
          policyId: action.policyId,
          policyVersion: action.policyVersion,
          mode: 'auto_with_limits',
          outcome: 'auto_executed',
          occurredAt: deps.clock.isoNow(),
          cooldownUntil: new Date(deps.clock.now().getTime() + cooldownMs).toISOString(),
          grantsSpend: false,
        });
      }
      await deps.persist(record);
      await deps.relay(record);
      if (decision.verb.name === 'research.gather' && result.ok) {
        const artifact = result.data as ResearchArtifact;
        if (artifact && artifact.status === 'awaiting_acceptance') {
          await pauseForResearchAcceptance(deps, record, request, artifact, toolCalls.slice(i + 1));
          throw new ApprovalRequiredError();
        }
      }
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

/** Accepted research for the operator URL on this goal/thread, for creative.draft_post claim checks. */
async function acceptedResearchFor(
  deps: Pick<LoopBodyDeps, 'researchStore'>,
  request: HubRunRequest
): Promise<{ artifactId: string; version: number; findingIds: string[] } | undefined> {
  const landingPageUrl = readUserSuppliedLanding(request.userSuppliedInput);
  if (!landingPageUrl || !request.goalId || !request.threadId) return undefined;
  const artifact = await lookupCurrentArtifact(
    deps.researchStore,
    { workspaceId: request.workspaceId, userId: request.userId, goalId: request.goalId, threadId: request.threadId },
    landingPageUrl
  );
  if (!artifact || artifact.status !== 'accepted' || !artifact.acceptedAt || artifact.landingPageUrl !== landingPageUrl) return undefined;
  return { artifactId: artifact.artifactId, version: artifact.version, findingIds: artifact.findings.map((f) => f.id) };
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

async function pauseForResearchAcceptance(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest,
  artifact: ResearchArtifact,
  remainingToolCalls: Array<{ id: string; name: string; arguments: string }>
): Promise<void> {
  const acceptVerb = verbByName('research.accept');
  if (!acceptVerb) throw new ToolRefusedError('research.accept is not in the catalog');
  const args = { artifactId: artifact.artifactId, version: artifact.version, inputRevision: artifact.inputRevision };
  const askId = randomUUID();
  record.pendingApproval = {
    askId,
    runId: record.runId,
    workspaceId: request.workspaceId,
    verbName: acceptVerb.name,
    args,
    argsHash: canonicalArgsHash(args),
    callId: 'research-accept',
    toolCallId: 'research-accept',
    remainingToolCalls,
  };
  record.state = 'awaiting_approval';
  const toolOutput: BrainOutput = {
    type: 'tool_call',
    tool: acceptVerb.name,
    parameters: {
      ...args,
      landingPageUrl: artifact.landingPageUrl,
      findings: artifact.findings,
      assumptions: artifact.assumptions,
      unknowns: artifact.unknowns,
      sources: artifact.sources.map((row) => ({ sourceId: row.sourceId, kind: row.kind, url: row.url, sha256: row.sha256 })),
    },
    needsApproval: true,
    risk: acceptVerb.risk,
  };
  record.snapshot = {
    ...snapshotOf(record, 'awaiting_approval', undefined, [toolOutput]),
    needs: [
      {
        type: 'approval',
        askId,
        verb: acceptVerb.name,
        argsHash: record.pendingApproval.argsHash,
        workspaceId: request.workspaceId,
        research: {
          artifactId: artifact.artifactId,
          version: artifact.version,
          inputRevision: artifact.inputRevision,
          landingPageUrl: artifact.landingPageUrl,
        },
      },
    ],
  };
  record.events.push(
    gatewayAuditEvent(request, {
      action: 'approval.requested',
      outcome: 'partial',
      occurredAt: deps.clock.isoNow(),
      details: { askId, verb: acceptVerb.name, argsHash: record.pendingApproval.argsHash, workspaceId: request.workspaceId },
    })
  );
  await deps.persist(record);
  await deps.relay(record);
}

async function settleResearchAcceptance(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest
): Promise<'wait' | Array<{ id: string; name: string; arguments: string }>> {
  const pending = record.pendingApproval;
  const resume = request.resume;
  if (!pending || !resume) return 'wait';
  const landingPageUrl = readUserSuppliedLanding(request.userSuppliedInput);
  const binding =
    request.goalId && request.threadId
      ? { workspaceId: request.workspaceId, userId: request.userId, goalId: request.goalId, threadId: request.threadId }
      : undefined;
  const artifact = await lookupCurrentArtifact(deps.researchStore, binding, landingPageUrl);
  const outcome = await applyResearchResume({
    store: deps.researchStore,
    artifact,
    pending,
    resume,
    now: deps.clock.isoNow(),
  });
  const leftover = pending.remainingToolCalls;
  record.events.push(
    gatewayAuditEvent(request, {
      action: outcome === 'accepted' ? 'approval.granted' : outcome === 'invalidated' ? 'approval.rejected' : 'approval.rejected',
      outcome: outcome === 'accepted' ? 'success' : 'denied',
      occurredAt: deps.clock.isoNow(),
      details: { askId: pending.askId, verb: pending.verbName, research: outcome },
    })
  );
  if (outcome === 'mismatch') {
    return 'wait';
  }
  record.pendingApproval = undefined;
  record.lastResume = undefined;
  request.resume = undefined;
  record.state = 'running';
  record.snapshot = undefined;
  if (outcome !== 'accepted') {
    for (const call of leftover) {
      record.messages.push({
        role: 'tool',
        content: JSON.stringify({
          ok: false,
          code: 'research_rejected',
          message: 'skipped because research artifact was not accepted',
        }),
        toolCallId: call.id,
      });
    }
    await deps.persist(record);
    return [];
  }
  await deps.persist(record);
  return leftover;
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
    ...(record.analytics ? { analytics: { ...record.analytics } as Record<string, unknown> } : {}),
    ...(record.actionOutcome ? { actionOutcome: { ...record.actionOutcome } as Record<string, unknown> } : {}),
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
