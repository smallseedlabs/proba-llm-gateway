/**
 * Bounded orchestration loop (the harness lives here, not a separate service).
 * See run-loop.ts for context → LLM → policy → approval → domain → repeat.
 */

import { randomUUID } from 'node:crypto';
import {
  AmbiguousOutcomeError,
  ApprovalRequiredError,
  BudgetExhaustedError,
  ConfigError,
  IdempotencyConflictError,
  PolicyDeniedError,
  PreflightBlockedError,
  RequestValidationError,
  RunAbortedError,
  RunNotFoundError,
  ToolRefusedError,
  WorkspaceScopeError,
} from '../errors.js';
import { hashedRunKey, requestFingerprint } from '../audit/fingerprint.js';
import { validateCommandPayload } from '../protocol.js';
import type { JWTVerifyGetKey } from 'jose';
import type { ApprovalGate } from '../ports/approval.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { Clock } from '../ports/clock.js';
import type { ContextPort } from '../ports/context.js';
import type { LimbExecutor } from '../ports/limbs.js';
import type { AdsDomainPort } from '../ports/ads.js';
import type { ResearchArtifactStore } from '../ports/research.js';
import type { AnalyticsDecisionStore } from '../analytics/store.js';
import { LlmClientError, type LlmClient } from '../ports/llm-client.js';
import type { PolicyEngine } from '../ports/policy.js';
import type { RunRecord, RunStore } from '../ports/run-store.js';
import type { VerifiedCaller } from '../ports/auth.js';
import { verifyForwardedActAs } from '../auth/act-as.js';
import type { HubRunRequest, RunSnapshot, RunStatus } from '../types/run.js';
import { emptyUsageTotals } from '../types/usage.js';
import type { GatewayServiceConfig } from '../types/config.js';
import { RunCancellation, RunDeadline } from './cancellation.js';
import { mergeLimits, RunUsageLedger } from '../usage/reservations.js';
import type { UsageLimits } from '../ports/usage.js';
import { finish, runBoundedLoop, snapshotOf } from './run-loop.js';
import { gatewayAuditEvent } from './audit-events.js';

export interface LoopCoordinatorDeps {
  config: GatewayServiceConfig;
  clock: Clock;
  audit: AuditPublisher;
  runs: RunStore;
  llm: LlmClient;
  context: ContextPort;
  policy: PolicyEngine;
  approval: ApprovalGate;
  tools: LimbExecutor;
  ads: AdsDomainPort;
  researchStore: ResearchArtifactStore;
  analyticsStore: AnalyticsDecisionStore;
  assertionKeys?: JWTVerifyGetKey;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled', 'paused', 'stopped', 'ambiguous']);

export class LoopCoordinator {
  private readonly gates = new Map<string, Promise<void>>();
  private readonly live = new Map<string, RunCancellation>();

  constructor(private readonly deps: LoopCoordinatorDeps) {}

  async start(request: HubRunRequest, caller: VerifiedCaller, signal?: AbortSignal): Promise<RunSnapshot> {
    this.assertFailClosedSeams();
    this.assertWorkspace(request, caller);
    if (request.actAsAssertion) {
      if (!this.deps.assertionKeys) {
        throw new ConfigError('HUB_ASSERTION_PUBLIC_KEY_FILE is required to verify a forwarded act-as assertion');
      }
      await verifyForwardedActAs(request.actAsAssertion, request, this.deps.assertionKeys, () => this.deps.clock.now());
    }
    if (!validateCommandPayload(request.command.type, request.command.payload)) {
      throw new RequestValidationError(`command payload does not match type ${request.command.type}`);
    }
    const idempotencyKey = request.idempotencyKey ?? request.traceId;
    const key = hashedRunKey(caller.issuer, caller.subject, idempotencyKey);
    return this.serialize(key, () => this.execute(key, request, caller, signal, idempotencyKey));
  }

  async get(runId: string, caller: VerifiedCaller): Promise<RunSnapshot> {
    const record = await this.deps.runs.getByRunId(runId);
    if (!record) throw new RunNotFoundError(runId);
    this.assertRecordAccess(record, caller);
    return record.snapshot ?? snapshotOf(record, record.state);
  }

  async cancel(
    runId: string,
    reason: 'hub_cancel' | 'hub_pause' | 'emergency_stop',
    caller: VerifiedCaller
  ): Promise<RunSnapshot> {
    const record = await this.deps.runs.getByRunId(runId);
    if (!record) throw new RunNotFoundError(runId);
    this.assertRecordAccess(record, caller);
    if (TERMINAL.has(record.state) && record.snapshot) return record.snapshot;
    this.live.get(runId)?.abort(reason);
    const status: RunStatus = reason === 'emergency_stop' ? 'stopped' : reason === 'hub_pause' ? 'paused' : 'cancelled';
    const snapshot = snapshotOf(record, status, { code: 'aborted', message: reason, retryable: false });
    record.state = status;
    record.snapshot = snapshot;
    record.updatedAt = this.deps.clock.isoNow();
    record.events.push(
      gatewayAuditEvent(record.request, {
        action: reason === 'emergency_stop' ? 'control.emergency_stopped' : reason === 'hub_pause' ? 'control.paused' : 'command.processed',
        outcome: 'success',
        occurredAt: record.updatedAt,
        details: { runId, reason },
      })
    );
    await this.deps.runs.put(record);
    await this.relay(record);
    return snapshot;
  }

  async relayPending(): Promise<void> {
    for (const row of await this.deps.runs.unpublished()) {
      await this.relay(row);
    }
  }

  private async serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(key) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    this.gates.set(
      key,
      current.then(
        () => undefined,
        () => undefined
      )
    );
    return current;
  }

  private async execute(
    key: string,
    request: HubRunRequest,
    caller: VerifiedCaller,
    signal: AbortSignal | undefined,
    idempotencyKey: string
  ): Promise<RunSnapshot> {
    const fingerprint = requestFingerprint(request);
    let record = await this.deps.runs.get(key);
    if (record) {
      if (record.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      this.assertRecordAccess(record, caller);
      if (record.state === 'awaiting_approval' && request.resume) {
        record.lastResume = request.resume;
        await this.deps.runs.put(record);
      } else if (record.snapshot && (TERMINAL.has(record.state) || record.state === 'awaiting_approval')) {
        await this.relay(record);
        return record.snapshot;
      } else if (record.state === 'running') {
        const lastLlm = record.llmTurns[record.llmTurns.length - 1];
        const lastTool = record.toolTurns[record.toolTurns.length - 1];
        if (lastLlm?.state === 'inflight' || lastLlm?.state === 'ambiguous' || lastTool?.state === 'inflight' || lastTool?.state === 'ambiguous') {
          return finish(this.bodyDeps(), record, 'ambiguous', [], {
            code: 'outcome_ambiguous',
            message: 'prior paid or mutating work did not finish cleanly; not redispatched',
            retryable: false,
          });
        }
      }
    }

    const cancellation = new RunCancellation(signal);
    const deadlineMs = request.budget?.deadlineMs ?? 90_000;
    new RunDeadline(new Date(this.deps.clock.now().getTime() + deadlineMs)).link(cancellation);

    if (!record) {
      record = {
        key,
        runId: randomUUID(),
        callerIss: caller.issuer,
        callerSub: caller.subject,
        idempotencyKey,
        fingerprint,
        state: 'running',
        request,
        messages: [],
        iteration: 0,
        usage: emptyUsageTotals(),
        llmTurns: [],
        toolTurns: [],
        domainState: {},
        events: [
          gatewayAuditEvent(request, {
            action: 'command.accepted',
            outcome: 'success',
            occurredAt: this.deps.clock.isoNow(),
            details: {},
          }),
        ],
        publishedEventIds: [],
        updatedAt: this.deps.clock.isoNow(),
      };
      record.events[0] = gatewayAuditEvent(request, {
        action: 'command.accepted',
        outcome: 'success',
        occurredAt: record.updatedAt,
        details: { runId: record.runId },
      });
      await this.deps.runs.put(record);
    }

    this.live.set(record.runId, cancellation);
    const usage = new RunUsageLedger(this.limitsOf(request));
    usage.restore(record.usage, record.iteration);
    const body = this.bodyDeps();
    try {
      return await runBoundedLoop(body, record, request, cancellation, usage);
    } catch (err) {
      if (err instanceof RunAbortedError) {
        const status: RunStatus =
          err.reason === 'emergency_stop' ? 'stopped' : err.reason === 'hub_pause' ? 'paused' : err.reason === 'deadline' ? 'failed' : 'cancelled';
        return finish(body, record, status, [], { code: err.code, message: err.message, retryable: false });
      }
      if (err instanceof AmbiguousOutcomeError) {
        return finish(body, record, 'ambiguous', [], { code: err.code, message: err.message, retryable: false });
      }
      if (err instanceof BudgetExhaustedError || err instanceof PolicyDeniedError || err instanceof ToolRefusedError) {
        return finish(body, record, 'failed', [], { code: err.code, message: err.message, retryable: false });
      }
      if (err instanceof PreflightBlockedError) {
        return finish(body, record, 'blocked', [], { code: err.code, message: err.message, retryable: true }, err.needs);
      }
      if (err instanceof ApprovalRequiredError) {
        return record.snapshot ?? snapshotOf(record, 'awaiting_approval');
      }
      if (err instanceof LlmClientError) {
        return finish(body, record, 'failed', [], { code: err.code, message: err.message, retryable: err.retryable });
      }
      throw err;
    } finally {
      this.live.delete(record.runId);
    }
  }

  private bodyDeps() {
    return {
      config: this.deps.config,
      clock: this.deps.clock,
      llm: this.deps.llm,
      context: this.deps.context,
      policy: this.deps.policy,
      approval: this.deps.approval,
      tools: this.deps.tools,
      ads: this.deps.ads,
      researchStore: this.deps.researchStore,
      analyticsStore: this.deps.analyticsStore,
      persist: (row: RunRecord) => this.deps.runs.put(row),
      relay: (row: RunRecord) => this.relay(row),
    };
  }

  private async relay(record: RunRecord): Promise<void> {
    for (const event of record.events) {
      if (record.publishedEventIds.includes(event.eventId)) continue;
      try {
        await this.deps.audit.publish(event);
        await this.deps.runs.markPublished(record.key, event.eventId);
        record.publishedEventIds.push(event.eventId);
      } catch {
        return;
      }
    }
  }

  private assertFailClosedSeams(): void {
    if (this.deps.tools.name === 'fake' && this.deps.config.env !== 'test') {
      throw new ConfigError('fake limb executors are test-only');
    }
    if (this.deps.llm.name === 'fake' && this.deps.config.env !== 'test') {
      throw new ConfigError('fake LLM clients are test-only');
    }
    if (typeof this.deps.policy.evaluate !== 'function') throw new ConfigError('policy engine is required');
    if (typeof this.deps.approval.decide !== 'function') throw new ConfigError('approval gate is required');
    if (typeof this.deps.context.build !== 'function') throw new ConfigError('context port is required');
  }

  private assertWorkspace(request: HubRunRequest, caller: VerifiedCaller): void {
    if (caller.workspaceId && caller.workspaceId !== request.workspaceId) throw new WorkspaceScopeError();
  }

  private assertRecordAccess(record: RunRecord, caller: VerifiedCaller): void {
    if (caller.workspaceId && caller.workspaceId !== record.request.workspaceId) throw new WorkspaceScopeError();
    if (caller.issuer !== record.callerIss || caller.subject !== record.callerSub) {
      throw new WorkspaceScopeError('run does not belong to this caller');
    }
  }

  private limitsOf(request: HubRunRequest): UsageLimits {
    const limits = this.deps.config.limits;
    const overlay: Partial<UsageLimits> = {};
    if (request.budget?.maxIterations !== undefined) overlay.maxIterations = request.budget.maxIterations;
    if (request.budget?.maxLlmCalls !== undefined) overlay.maxLlmCalls = request.budget.maxLlmCalls;
    if (request.budget?.maxToolCalls !== undefined) overlay.maxToolCalls = request.budget.maxToolCalls;
    if (request.budget?.maxPromptTokens !== undefined) overlay.maxPromptTokens = request.budget.maxPromptTokens;
    if (request.budget?.maxCompletionTokens !== undefined) overlay.maxCompletionTokens = request.budget.maxCompletionTokens;
    if (request.budget?.maxTotalTokens !== undefined) overlay.maxTotalTokens = request.budget.maxTotalTokens;
    if (request.budget?.maxCostUsd !== undefined) overlay.maxCostUsd = request.budget.maxCostUsd;
    if (request.budget?.responseTokenReserve !== undefined) overlay.responseTokenReserve = request.budget.responseTokenReserve;
    if (request.budget?.contextBudgetTokens !== undefined) overlay.contextBudgetTokens = request.budget.contextBudgetTokens;
    return mergeLimits(
      {
        maxIterations: limits.maxIterations,
        maxLlmCalls: limits.maxLlmCalls,
        maxToolCalls: limits.maxToolCalls,
        maxPromptTokens: limits.maxPromptTokens,
        maxCompletionTokens: limits.maxCompletionTokens,
        maxTotalTokens: limits.maxTotalTokens,
        maxCostUsd: limits.maxCostUsd,
        responseTokenReserve: limits.responseTokenReserve,
        contextBudgetTokens: this.deps.config.context.maxBudgetTokens,
      },
      overlay
    );
  }
}
