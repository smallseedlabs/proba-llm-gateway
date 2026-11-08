import type { AuditEvent, AuditEventInput } from '../protocol.js';
import { validateAuditEvent } from '../protocol.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';

/** In-memory audit publisher for tests. Does not call LLM or tools on "replay". */
export class MemoryAuditPublisher implements AuditPublisher {
  readonly events: AuditEvent[] = [];
  failPing = false;
  failPublish = false;

  async ping(): Promise<void> {
    if (this.failPing) throw new Error('audit ping failed');
  }

  async publish(event: AuditEventInput): Promise<void> {
    if (this.failPublish) throw new Error('audit publish failed');
    const parsed = validateAuditEvent(event);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid audit event');
    this.events.push(parsed.data);
  }

  forTrace(traceId: AuditEvent['traceId'], parentSpanId?: AuditEvent['spanId']): AuditPublisher {
    return {
      publish: (event) => this.publish({ ...event, traceId, ...(parentSpanId && !event.parentSpanId ? { parentSpanId } : {}) }),
      forTrace: (id, parent) => this.forTrace(id, parent),
      ping: () => this.ping(),
    };
  }
}
