/**
 * Shared protocol types and helpers. Do not invent parallel audit, command,
 * event, brain or context schemas here. Hub, this gateway and proba-llm share
 * `traceId` and the AuditEvent envelope; the durable event system (proba-audit
 * consumer) writes the DB, including compressed content bodies and metadata
 * indexes. This package does not prove that durability.
 */
export type {
  ActAsAssertionClaims,
  AuditContent,
  AuditEvent,
  AuditEventInput,
  BrainOutput,
  BrainToolCall,
  CommandEnvelope,
  ContextNeed,
  ContextPacket,
  ContextRequest,
  EventEnvelope,
  StatusPayload,
  StepType,
} from '@smallseedlabs/proba-protocol';

export {
  ACT_AS_ASSERTION_MAX_TTL_SECONDS,
  AUDIT_ACTIONS,
  AUDIT_CONTENT_KINDS,
  AUDIT_CONTENT_MAX_CHARS,
  AUDIT_EVENT_VERSION,
  actAsAssertionClaimsSchema,
  buildAuditContent,
  buildAuditEvent,
  commandEnvelopeSchema,
  contextNeedSchema,
  contextPacketSchema,
  contextRequestSchema,
  generateSpanId,
  getAuditActionInfo,
  stepTypeSchema,
  validateActAsAssertionClaims,
  validateAuditEvent,
  validateCommandPayload,
  validateContextPacket,
  validateContextRequest,
} from '@smallseedlabs/proba-protocol';
