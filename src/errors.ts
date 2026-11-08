/**
 * Typed failures for the gateway. Auth, policy and tool seams fail closed.
 * None of these constructors imply a successful tool or paid-model outcome.
 */
export class NotImplementedError extends Error {
  readonly code = 'not_implemented';

  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

export class ConfigError extends Error {
  readonly code = 'config_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class RequestValidationError extends Error {
  readonly code = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export class HostRefusedError extends Error {
  readonly code = 'host_refused';

  constructor(host: string) {
    super(`downstream host is not allowlisted: ${host}`);
    this.name = 'HostRefusedError';
  }
}

export class WorkspaceScopeError extends Error {
  readonly code = 'workspace_mismatch';

  constructor(message = 'workspace in the body does not match the caller identity') {
    super(message);
    this.name = 'WorkspaceScopeError';
  }
}

export class RunAbortedError extends Error {
  readonly code = 'aborted';

  constructor(
    message = 'run was cancelled, paused, stopped or timed out',
    readonly reason: 'hub_cancel' | 'hub_pause' | 'emergency_stop' | 'deadline' | 'disconnect' = 'hub_cancel'
  ) {
    super(message);
    this.name = 'RunAbortedError';
  }
}

export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';

  constructor(message = 'audit publisher is not ready') {
    super(message);
    this.name = 'AuditUnavailableError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict';

  constructor(message = 'idempotency key was reused with a different request') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * A paid LLM turn or a side-effecting tool was dispatched and the outcome is
 * not a clear success or 4xx. The run/turn is recorded so a retry with the
 * same key will not send another paid or mutating request.
 */
export class AmbiguousOutcomeError extends Error {
  readonly code = 'outcome_ambiguous';

  constructor(message = 'outcome is ambiguous; this key will not be retried') {
    super(message);
    this.name = 'AmbiguousOutcomeError';
  }
}

export class BudgetExhaustedError extends Error {
  readonly code = 'budget_exhausted';

  constructor(message: string) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

export class PolicyDeniedError extends Error {
  readonly code = 'policy_denied';

  constructor(message: string) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}

/**
 * Tool/limb execution was refused. Placeholders MUST throw this (or a
 * subclass) rather than returning a successful result.
 */
export class ToolRefusedError extends Error {
  readonly code = 'tool_refused';

  constructor(message: string) {
    super(message);
    this.name = 'ToolRefusedError';
  }
}

export class ApprovalRequiredError extends Error {
  readonly code = 'approval_required';

  constructor(message = 'Hub must collect a user approval before this side effect may run') {
    super(message);
    this.name = 'ApprovalRequiredError';
  }
}

export class LoopNotImplementedError extends NotImplementedError {
  constructor() {
    super('bounded orchestration loop');
    this.name = 'LoopNotImplementedError';
  }
}

export class RunNotFoundError extends Error {
  readonly code = 'run_not_found';

  constructor(runId: string) {
    super(`run ${runId} is not known`);
    this.name = 'RunNotFoundError';
  }
}

/**
 * Mandatory preflight failed. No paid LLM call and no mutating domain call
 * may follow this error. Hub receives an actionable blocked snapshot.
 */
export class PreflightBlockedError extends Error {
  readonly code = 'preflight_blocked';

  constructor(
    message: string,
    readonly needs: unknown[] = []
  ) {
    super(message);
    this.name = 'PreflightBlockedError';
  }
}
