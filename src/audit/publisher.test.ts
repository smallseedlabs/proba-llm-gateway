import { describe, expect, it } from 'vitest';
import { buildAuditEvent, validateAuditEvent } from '../protocol.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { splitAuditBody } from './body-chunks.js';
import { AUDIT_CONTENT_MAX_CHARS, buildAuditContent } from '../protocol.js';
import { TrackingLlmClient } from '../testing/doubles.js';

describe('audit publisher contract', () => {
  it('publishes protocol AuditEvents and does not call LLM on a second publish (replay analogue)', async () => {
    const audit = new MemoryAuditPublisher();
    const llm = new TrackingLlmClient();
    const event = buildAuditEvent({
      traceId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'seedbed',
      actor: { type: 'service', id: 'gateway' },
      service: 'gateway',
      action: 'command.rejected',
      category: 'command',
      outcome: 'failure',
      occurredAt: new Date().toISOString(),
      details: {},
    });
    expect(validateAuditEvent(event).success).toBe(true);
    await audit.publish(event);
    await audit.publish(event);
    expect(audit.events).toHaveLength(2);
    expect(llm.completeCalls).toBe(0);
  });

  it('chunks redacted bodies to the protocol content cap', () => {
    const text = 'a'.repeat(AUDIT_CONTENT_MAX_CHARS + 10);
    const chunks = splitAuditBody(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(AUDIT_CONTENT_MAX_CHARS);
    const content = buildAuditContent('prompt', chunks[0] ?? '');
    expect(content.text.length).toBeLessThanOrEqual(AUDIT_CONTENT_MAX_CHARS);
  });
});
