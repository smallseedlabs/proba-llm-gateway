/**
 * proba-llm-gateway public surface.
 *
 * Hub calls this process. Gateway owns context enrichment, the bounded loop
 * (the harness) and guarded tools. proba-llm performs one model turn. The LLM
 * never executes tools.
 */
export {
  AmbiguousOutcomeError,
  ConfigError,
  IdempotencyConflictError,
  LoopNotImplementedError,
  NotImplementedError,
  RequestValidationError,
  PreflightBlockedError,
  RunNotFoundError,
  ToolRefusedError,
} from './errors.js';
export {
  AUDIT_ACTIONS,
  AUDIT_CONTENT_KINDS,
  AUDIT_CONTENT_MAX_CHARS,
  AUDIT_EVENT_VERSION,
  buildAuditContent,
  buildAuditEvent,
  generateSpanId,
  getAuditActionInfo,
  validateAuditEvent,
} from './protocol.js';
export type {
  AuditContent,
  AuditEvent,
  AuditEventInput,
  CommandEnvelope,
  EventEnvelope,
} from './protocol.js';
export { IdentityRejectedError, LlmClientError, TokenVerificationError } from './ports/index.js';
export type {
  AuditPublisher,
  Clock,
  ContextPort,
  IdentityCredentials,
  LimbExecutor,
  LlmClient,
  ServiceAuth,
  VerifiedCaller,
} from './ports/index.js';
export { LoopCoordinator } from './loop/coordinator.js';
export type { LoopCoordinatorDeps } from './loop/coordinator.js';
export { GATEWAY_SERVICE_NAME } from './types/index.js';
export type {
  CompleteRequest,
  CostEstimate,
  GatewayServiceConfig,
  HubRunRequest,
  RunSnapshot,
  TraceId,
  TurnResponse,
  WorkspaceId,
} from './types/index.js';
export { completeRequestSchema, hubRunRequestSchema, turnResponseSchema } from './types/index.js';
export { loadConfig } from './config.js';
export { createRuntime } from './runtime.js';
export type { GatewayRuntime, RuntimeOverrides } from './runtime.js';
export {
  FailClosedApprovalGate,
  HttpAdsDomain,
  HttpContextClient,
  HttpLlmClient,
  LogAuditPublisher,
  RedisAuditPublisher,
  RefusingLimbExecutor,
  SystemClock,
  UnconfiguredAdsDomain,
  UnconfiguredResearchProvider,
  HttpUrlResearchProvider,
  MemoryResearchStore,
  FileResearchStore,
} from './adapters/index.js';
export { DomainLimbExecutor } from './limbs/dispatcher.js';
export { buildApp } from './http/app.js';
export {
  GATEWAY_AUDIENCE,
  DEFAULT_CALLER_ISSUERS,
  DEFAULT_CALLER_SUBJECTS,
  LLM_AUDIENCE,
  ADS_AUDIENCE,
  DEFAULT_LLM_TOKEN_ISSUER,
  DEFAULT_LLM_TOKEN_SUBJECT,
} from './auth/constants.js';
