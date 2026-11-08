/**
 * Durable producer handoff for a gateway run (not the audit DB).
 * Survives Redis outages so a retried Hub Idempotency-Key never re-enters the
 * loop after a paid LLM call or side-effecting tool. Audit stream replay must
 * not use this store to re-execute. Local files are single-replica/same-node
 * only — not HA, not a shared store.
 */

import type { AuditEvent } from '../protocol.js';
import type { LlmMessage } from '../types/llm.js';
import type { CompleteRequest, TurnResponse } from '../types/llm.js';
import type { HubRunRequest, ResumeApproval, RunSnapshot, RunStatus } from '../types/run.js';
import type { UsageTotals } from '../types/usage.js';
import type { LimbResult } from './limbs.js';
import type { AdsPreflightReport, LlmQuotaClaim, PrerequisiteEvidence, RelaxedCheck } from '../types/preflight.js';

export type RunRecordState = RunStatus;

export type TurnAttemptState = 'inflight' | 'completed' | 'failed' | 'ambiguous';

export interface LlmTurnRecord {
  idempotencyKey: string;
  fingerprint: string;
  state: TurnAttemptState;
  request?: CompleteRequest;
  response?: TurnResponse;
  errorCode?: string;
  errorMessage?: string;
}

export interface ToolTurnRecord {
  idempotencyKey: string;
  callId: string;
  toolCallId: string;
  verbName: string;
  argsHash: string;
  workspaceId: string;
  state: TurnAttemptState | 'awaiting_approval';
  args: Record<string, unknown>;
  result?: LimbResult;
}

export interface PendingApproval {
  askId: string;
  runId: string;
  workspaceId: string;
  verbName: string;
  args: Record<string, unknown>;
  argsHash: string;
  callId: string;
  toolCallId: string;
  /** Remaining tool calls from the same LLM turn, including the pending one. */
  remainingToolCalls: Array<{ id: string; name: string; arguments: string }>;
}

export interface RunRecord {
  key: string;
  runId: string;
  callerIss: string;
  callerSub: string;
  idempotencyKey: string;
  fingerprint: string;
  state: RunRecordState;
  request: HubRunRequest;
  snapshot?: RunSnapshot;
  messages: LlmMessage[];
  iteration: number;
  usage: UsageTotals;
  llmTurns: LlmTurnRecord[];
  toolTurns: ToolTurnRecord[];
  pendingApproval?: PendingApproval;
  domainState: Record<string, unknown>;
  lastResume?: ResumeApproval;
  lastPreflight?: {
    asOf: string;
    ads?: AdsPreflightReport;
    llmQuota?: LlmQuotaClaim;
    evidence?: PrerequisiteEvidence[];
    relaxed?: RelaxedCheck[];
    manifestId?: string;
  };
  errorCode?: string;
  errorMessage?: string;
  events: AuditEvent[];
  publishedEventIds: string[];
  updatedAt: string;
}

export interface RunStore {
  get(key: string): Promise<RunRecord | undefined>;
  getByRunId(runId: string): Promise<RunRecord | undefined>;
  put(record: RunRecord): Promise<void>;
  unpublished(): Promise<RunRecord[]>;
  markPublished(key: string, eventId: string): Promise<void>;
  close(): Promise<void>;
}

export function runStoreKey(issuer: string, subject: string, idempotencyKey: string): string {
  return `${issuer}\n${subject}\n${idempotencyKey}`;
}
