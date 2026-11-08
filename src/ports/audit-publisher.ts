/**
 * Audit publisher port.
 *
 * Emits protocol `AuditEvent`s onto the existing durable event system
 * (`proba.audit.events` Redis stream by default). proba-audit's consumer
 * persists to the existing DB and dedupes on `eventId`. This service does not
 * write that DB. Replaying the stream must never call proba-llm or execute a
 * tool. Durability of the existing pipeline is not proven by this repo.
 */

import type { AuditEvent, AuditEventInput } from '../protocol.js';

export type { AuditEvent, AuditEventInput };

export interface AuditPublisher {
  publish(event: AuditEventInput): Promise<void>;
  forTrace(traceId: AuditEvent['traceId'], parentSpanId?: AuditEvent['spanId']): AuditPublisher;
  /** Readiness: broker reachable. Must not write the audit DB. */
  ping?(): Promise<void>;
  close?(): Promise<void>;
}
