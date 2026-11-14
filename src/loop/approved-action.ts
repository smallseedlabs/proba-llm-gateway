/**
 * Approved analytics action: Hub collected an explicit owner decision on an
 * evaluator dry-run proposal and asks the gateway to execute exactly that
 * proposal through the Ads domain port. Deterministic: zero LLM calls.
 *
 * Fail-closed bindings (none can be relaxed by the request):
 * - `resume` is required; absence is not approval. `reject` records and stops.
 * - The proposal must be the latest persisted evaluator decision for the same
 *   workspace + user + probaCampaignId, with the same decisionId and argsHash,
 *   still inside its review window (`cooldownUntil`).
 * - Provider/account scope recorded at evaluation must match the request.
 *   The executed args address one Proba campaign only; there is no
 *   cross-provider side effect (`ads.move_budget` stays a separate verb).
 * - Owner policy `deny` still wins. Mutate preflight (fresh Ads readiness,
 *   billing for spend-class verbs) still runs. Nothing here grants spend.
 */

import { randomUUID } from 'node:crypto';
import { canonicalArgsHash } from '../audit/canonical.js';
import { evaluateActionPolicy } from '../action-policy/evaluate.js';
import { verbByName } from '../limbs/catalog.js';
import { NO_GUARDRAILS, verbMode } from '../guardrails/guardrails.js';
import { applyPreflightToRecord, graphAuditDetails, runPreflight } from '../preflight/engine.js';
import type { CapabilityNeed } from '../types/preflight.js';
import type { HubRunRequest, RunSnapshot } from '../types/run.js';
import type { RunRecord, ToolTurnRecord } from '../ports/run-store.js';
import type { RunUsageLedger } from '../usage/reservations.js';
import type { Cancellation } from '../ports/cancellation.js';
import { AmbiguousOutcomeError, ToolRefusedError } from '../errors.js';
import { gatewayAuditEvent } from './audit-events.js';
import { finish, type LoopBodyDeps } from './run-loop.js';

export const APPROVED_ACTION_VERBS = new Set(['ads.pause_campaign', 'ads.update_campaign']);

export interface ApprovedAnalyticsAction {
  proposalId: string;
  decisionId: string;
  verb: string;
  args: Record<string, unknown>;
  argsHash: string;
  probaCampaignId: string;
  platform?: string;
  accountId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Structured Hub payload field. Never parsed from chat text. */
export function approvedActionFromRequest(request: HubRunRequest): ApprovedAnalyticsAction | undefined {
  if (request.stepType !== 'handle_approval') return undefined;
  const payload = asRecord(request.command.payload);
  const row = asRecord(payload?.analyticsAction);
  if (!row) return undefined;
  const args = asRecord(row.args);
  const proposalId = str(row.proposalId);
  const decisionId = str(row.decisionId);
  const verb = str(row.verb);
  const argsHash = str(row.argsHash);
  const probaCampaignId = str(row.probaCampaignId);
  if (!args || !proposalId || !decisionId || !verb || !argsHash || !probaCampaignId) {
    return { proposalId: proposalId ?? '', decisionId: decisionId ?? '', verb: verb ?? '', args: args ?? {}, argsHash: argsHash ?? '', probaCampaignId: probaCampaignId ?? '' };
  }
  return {
    proposalId,
    decisionId,
    verb,
    args,
    argsHash,
    probaCampaignId,
    platform: str(row.platform),
    accountId: str(row.accountId),
  };
}

/** Ads `update_campaign` is strict: currency is evidence on the proposal, not an Ads arg. */
export function executionArgs(verb: string, args: Record<string, unknown>): Record<string, unknown> {
  if (verb === 'ads.pause_campaign') return { probaCampaignId: args.probaCampaignId };
  return { probaCampaignId: args.probaCampaignId, dailyBudget: args.dailyBudget };
}

export async function runApprovedAction(
  deps: LoopBodyDeps,
  record: RunRecord,
  request: HubRunRequest,
  action: ApprovedAnalyticsAction,
  cancellation: Cancellation,
  usage: RunUsageLedger
): Promise<RunSnapshot> {
  cancellation.throwIfAborted();
  const refuse = async (code: string, message: string, status: 'blocked' | 'failed' = 'blocked') => {
    record.events.push(
      gatewayAuditEvent(request, {
        action: 'policy.denied',
        outcome: 'denied',
        occurredAt: deps.clock.isoNow(),
        errorCode: code,
        errorMessage: message,
        details: {
          evaluator: 'approved_action',
          proposalId: action.proposalId,
          decisionId: action.decisionId,
          verb: action.verb,
          argsHash: action.argsHash,
          grantsSpend: false,
        },
      })
    );
    return finish(deps, record, status, [{ type: 'reply', text: message }], { code, message, retryable: false });
  };

  const resume = request.resume;
  if (!resume || resume.askId !== action.proposalId) {
    return refuse('approval_required', 'an explicit Hub owner decision bound to this proposalId is required; absence is not approval');
  }
  if (!APPROVED_ACTION_VERBS.has(action.verb)) {
    return refuse('verb_not_allowed', `${action.verb || 'unknown verb'} is not an analytics action verb (pause or cap only)`);
  }
  const verb = verbByName(action.verb);
  if (!verb) return refuse('verb_not_allowed', `${action.verb} is not in the fixed catalog`);
  if (verbMode(deps.config.guardrails ?? NO_GUARDRAILS, verb.name) === 'deny') {
    return refuse('verb_not_allowed', `${verb.name} is turned off by the operator's guardrails`);
  }
  if (canonicalArgsHash(action.args) !== action.argsHash) {
    return refuse('args_mismatch', 'proposal args do not match the bound argsHash');
  }
  if (action.args.probaCampaignId !== action.probaCampaignId) {
    return refuse('scope_campaign', 'proposal args target a different Proba campaign');
  }

  const decision = await deps.analyticsStore.get({
    workspaceId: request.workspaceId,
    userId: request.userId,
    probaCampaignId: action.probaCampaignId,
  });
  if (!decision || decision.workspaceId !== request.workspaceId || decision.userId !== request.userId) {
    return refuse('proposal_unknown', 'no evaluator proposal exists for this workspace, user and campaign');
  }
  if (decision.decisionId !== action.decisionId || decision.outcome !== 'dry_run_proposal' || decision.argsHash !== action.argsHash) {
    return refuse('proposal_superseded', 'this proposal is not the latest evaluator decision for the campaign; review again');
  }
  if (decision.platform && action.platform && decision.platform !== action.platform) {
    return refuse('scope_provider', 'proposal was evaluated for a different provider');
  }
  if (decision.accountId && action.accountId && decision.accountId !== action.accountId) {
    return refuse('scope_provider', 'proposal was evaluated for a different provider account');
  }
  const until = Date.parse(decision.cooldownUntil);
  if (!Number.isFinite(until) || deps.clock.now().getTime() >= until) {
    return refuse('proposal_expired', 'proposal review window has passed; metrics must be re-evaluated before acting');
  }

  if (resume.choice !== 'approve' || resume.approved === false) {
    record.events.push(
      gatewayAuditEvent(request, {
        action: 'approval.rejected',
        outcome: 'denied',
        occurredAt: deps.clock.isoNow(),
        details: { proposalId: action.proposalId, decisionId: action.decisionId, verb: action.verb, argsHash: action.argsHash },
      })
    );
    return finish(deps, record, 'completed', [{ type: 'reply', text: `proposal ${action.proposalId} rejected; no Ads call` }]);
  }

  const args = executionArgs(action.verb, action.args);
  const documents = await deps.actionPolicyStore.list(request.workspaceId);
  // Policy scope is the evaluated proposal's provider/account/campaign only.
  const scopedRequest = {
    ...request,
    command: {
      ...request.command,
      payload: {
        ...(asRecord(request.command.payload) ?? {}),
        probaCampaignId: action.probaCampaignId,
        ...(decision.platform ? { platform: decision.platform } : {}),
        ...(decision.accountId ? { accountId: decision.accountId } : {}),
      },
    },
  } as HubRunRequest;
  const policy = evaluateActionPolicy({ verb, args, request: scopedRequest, documents, now: deps.clock.now() });
  record.events.push(
    gatewayAuditEvent(request, {
      action: policy.mode === 'deny' ? 'policy.denied' : 'brain.decision_made',
      outcome: policy.mode === 'deny' ? 'denied' : 'success',
      occurredAt: deps.clock.isoNow(),
      details: {
        evaluator: 'approved_action',
        proposalId: action.proposalId,
        decisionId: action.decisionId,
        verb: action.verb,
        mode: policy.mode,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        hubApproval: true,
        grantsSpend: false,
        argsHash: action.argsHash,
      },
    })
  );
  if (policy.mode === 'deny') {
    return finish(deps, record, 'blocked', [{ type: 'reply', text: policy.gate?.message ?? 'denied by owner policy' }], {
      code: policy.gate?.code ?? 'policy_deny',
      message: policy.gate?.message ?? `${action.verb} is denied by owner policy`,
      retryable: false,
    });
  }

  const existing = record.toolTurns.find((t) => t.callId === action.decisionId);
  if (existing?.state === 'completed' && existing.result) {
    return finish(deps, record, 'completed', [{ type: 'reply', text: `action ${action.verb} already executed` }]);
  }
  if (existing?.state === 'inflight' || existing?.state === 'ambiguous') {
    throw new AmbiguousOutcomeError(`approved ${action.verb} was dispatched and is not safe to retry`);
  }

  usage.assertCanCallTool();
  const mutateArgs = { ...args, ...(action.platform ? { platform: action.platform } : {}) };
  const preflight = await runPreflight(
    { config: deps.config, clock: deps.clock, ads: deps.ads, llm: deps.llm, context: deps.context, researchStore: deps.researchStore },
    request,
    record,
    usage,
    cancellation.signal,
    { phase: 'mutate', mutate: { verb: action.verb, args: mutateArgs } }
  );
  applyPreflightToRecord(record, preflight);
  record.events.push(
    gatewayAuditEvent(request, {
      action: preflight.allowed ? 'command.processed' : 'policy.denied',
      outcome: preflight.allowed ? 'success' : 'denied',
      occurredAt: deps.clock.isoNow(),
      errorCode: preflight.allowed ? undefined : 'preflight_blocked',
      errorMessage: preflight.allowed ? undefined : preflight.needs[0]?.message,
      details: graphAuditDetails(preflight),
    })
  );
  if (!preflight.allowed) {
    return finish(
      deps,
      record,
      'blocked',
      [],
      { code: 'preflight_blocked', message: preflight.needs[0]?.message ?? 'preflight blocked', retryable: true },
      preflight.needs as CapabilityNeed[]
    );
  }

  const toolTurn: ToolTurnRecord = {
    idempotencyKey: randomUUID(),
    callId: action.decisionId,
    toolCallId: action.decisionId,
    verbName: action.verb,
    argsHash: canonicalArgsHash(args),
    workspaceId: request.workspaceId,
    state: 'inflight',
    args,
  };
  record.toolTurns.push(toolTurn);
  await deps.persist(record);
  try {
    const result = await deps.tools.execute(
      { callId: action.decisionId, verb, args, idempotencyKey: toolTurn.idempotencyKey },
      {
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId,
        threadId: request.threadId,
        traceId: request.traceId,
        signal: cancellation.signal,
        approval: { status: 'granted', resume },
        domainState: record.domainState,
      }
    );
    toolTurn.state = 'completed';
    toolTurn.result = result;
    usage.recordToolCall();
    record.usage = usage.snapshot();
    record.events.push(
      gatewayAuditEvent(request, {
        action: result.ok ? 'tool.executed' : 'tool.failed',
        outcome: result.ok ? 'success' : 'failure',
        occurredAt: deps.clock.isoNow(),
        errorCode: result.ok ? undefined : result.code,
        errorMessage: result.ok ? undefined : result.message,
        details: {
          evaluator: 'approved_action',
          proposalId: action.proposalId,
          decisionId: action.decisionId,
          verb: action.verb,
          argsHash: action.argsHash,
          hubApproval: true,
          grantsSpend: false,
        },
      })
    );
    if (result.ok) {
      await deps.actionOutcomeStore.put({
        workspaceId: request.workspaceId,
        userId: request.userId,
        verb: action.verb,
        probaCampaignId: action.probaCampaignId,
        argsHash: action.argsHash,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        mode: 'approval',
        outcome: 'approved_executed',
        occurredAt: deps.clock.isoNow(),
        cooldownUntil: decision.cooldownUntil,
        grantsSpend: false,
      });
    }
    record.actionOutcome = {
      proposalId: action.proposalId,
      decisionId: action.decisionId,
      verb: action.verb,
      probaCampaignId: action.probaCampaignId,
      ok: result.ok,
      ...(result.ok ? {} : { code: result.code, message: result.message }),
      grantsSpend: false,
    };
    await deps.persist(record);
    if (!result.ok) {
      return finish(deps, record, 'failed', [{ type: 'reply', text: result.message }], {
        code: result.code,
        message: result.message,
        retryable: false,
      });
    }
    return finish(deps, record, 'completed', [
      { type: 'reply', text: `approved ${action.verb} executed for Proba campaign ${action.probaCampaignId}` },
    ]);
  } catch (err) {
    const aborted = cancellation.signal.aborted || (err instanceof ToolRefusedError && /ambiguous/.test(err.message));
    toolTurn.state = aborted ? 'ambiguous' : 'failed';
    toolTurn.result = { ok: false, code: aborted ? 'outcome_ambiguous' : 'tool_failed', message: err instanceof Error ? err.message : 'tool failed' };
    await deps.persist(record);
    if (aborted) throw new AmbiguousOutcomeError(toolTurn.result.message);
    throw err;
  }
}
