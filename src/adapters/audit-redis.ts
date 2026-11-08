import { createClient, type RedisClientType } from 'redis';
import { AuditUnavailableError } from '../errors.js';
import type { AuditEvent, AuditEventInput } from '../protocol.js';
import { validateAuditEvent } from '../protocol.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { Clock } from '../ports/clock.js';
import { GATEWAY_SERVICE_NAME } from '../types/config.js';

export const DEFAULT_AUDIT_STREAM = 'proba.audit.events';

export interface RedisAuditPublisherOptions {
  url: string;
  clock: Clock;
  stream?: string;
  maxStreamLength?: number;
  client?: RedisClientType;
}

/**
 * Publish side of proba-audit's Redis stream, same entry format as Hub/LLM:
 *   XADD <stream> * data=<JSON AuditEvent> publishedAt=<UTC ISO> key=<workspaceId>
 *
 * The consumer JSON.parse(fields.data) then validateAuditEvent. Full redacted
 * bodies travel in protocol `content` (chunked to AUDIT_CONTENT_MAX_CHARS);
 * ClickHouse stores them ZSTD-compressed. Replay must not call proba-llm or
 * execute tools. This adapter does not claim the consumer is durable.
 */
export class RedisAuditPublisher implements AuditPublisher {
  private readonly stream: string;
  private readonly client: RedisClientType;
  private owned: boolean;
  private connecting?: Promise<void>;

  constructor(private readonly options: RedisAuditPublisherOptions) {
    this.stream = options.stream ?? DEFAULT_AUDIT_STREAM;
    this.owned = !options.client;
    this.client = options.client ?? createClient({ url: options.url });
  }

  private async connected(): Promise<RedisClientType> {
    if (this.client.isOpen) return this.client;
    this.connecting ??= this.client.connect().then(() => undefined);
    await this.connecting;
    return this.client;
  }

  async ping(): Promise<void> {
    const client = await this.connected();
    const pong = await client.ping();
    if (pong !== 'PONG') throw new AuditUnavailableError('audit redis ping failed');
  }

  async publish(event: AuditEventInput): Promise<void> {
    const parsed = validateAuditEvent(event);
    if (!parsed.success) {
      throw new Error(`audit event "${String(event.action)}" is not a valid AuditEvent: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    const fields: Record<string, string> = {
      data: JSON.stringify(parsed.data),
      publishedAt: this.options.clock.isoNow(),
      key: parsed.data.workspaceId,
    };
    const client = await this.connected();
    const trim =
      this.options.maxStreamLength && this.options.maxStreamLength > 0
        ? { TRIM: { strategy: 'MAXLEN' as const, strategyModifier: '~' as const, threshold: this.options.maxStreamLength } }
        : undefined;
    await client.xAdd(this.stream, '*', fields, trim);
  }

  forTrace(traceId: AuditEvent['traceId'], parentSpanId?: AuditEvent['spanId']): AuditPublisher {
    return stampTrace(this, traceId, parentSpanId);
  }

  async close(): Promise<void> {
    if (this.owned && this.client.isOpen) await this.client.quit();
  }
}

export class LogAuditPublisher implements AuditPublisher {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    nodeEnv: string = process.env.NODE_ENV ?? 'development'
  ) {
    if (nodeEnv === 'production') {
      throw new Error('The log audit publisher is not allowed when NODE_ENV=production');
    }
  }

  async publish(event: AuditEventInput): Promise<void> {
    const parsed = validateAuditEvent(event);
    if (!parsed.success) {
      throw new Error(`audit event "${String(event.action)}" is not a valid AuditEvent`);
    }
    this.write(
      JSON.stringify({
        audit: true,
        service: parsed.data.service ?? GATEWAY_SERVICE_NAME,
        eventId: parsed.data.eventId,
        traceId: parsed.data.traceId,
        action: parsed.data.action,
        outcome: parsed.data.outcome,
        workspaceId: parsed.data.workspaceId,
      })
    );
  }

  forTrace(traceId: AuditEvent['traceId'], parentSpanId?: AuditEvent['spanId']): AuditPublisher {
    return stampTrace(this, traceId, parentSpanId);
  }
}

function stampTrace(publisher: AuditPublisher, traceId: AuditEvent['traceId'], parentSpanId?: AuditEvent['spanId']): AuditPublisher {
  return {
    publish: (event) => publisher.publish({ ...event, traceId, ...(parentSpanId && !event.parentSpanId ? { parentSpanId } : {}) }),
    forTrace: (id, parent) => stampTrace(publisher, id, parent),
    ping: publisher.ping ? () => publisher.ping!() : undefined,
    close: publisher.close ? () => publisher.close!() : undefined,
  };
}
