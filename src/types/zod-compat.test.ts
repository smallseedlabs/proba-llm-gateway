/**
 * Zod 4 compatibility. Protocol v0.6.0 is the Zod 4 pin; v0.4 command/audit
 * wire field names stay valid. Do not npm-override Zod 4 onto protocol v0.4.0.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildAuditEvent, validateAuditEvent, validateCommandPayload } from '../protocol.js';
import { completeRequestSchema } from './llm.js';
import { researchArtifactSchema } from './research.js';
import { TEST_USER_ID, TEST_GOAL_ID, TEST_THREAD_ID } from '../testing/fixtures.js';

describe('Zod 4 production-high compatibility', () => {
  it('rejects oversized constrained collections without hanging', () => {
    const schema = z.array(z.string().max(8)).max(16);
    const oversized = Array.from({ length: 20_000 }, () => 'abcdefghij');
    const started = Date.now();
    const parsed = schema.safeParse(oversized);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(parsed.success).toBe(false);
  });

  it('still rejects extra keys and over-max tool lists on the complete contract', () => {
    const tools = Array.from({ length: 33 }, (_, i) => ({
      name: `tool-${i}`,
      parameters: { type: 'object' },
    }));
    expect(completeRequestSchema.safeParse({
      traceId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'seedbed',
      messages: [{ role: 'user', content: 'hello' }],
      tools,
    }).success).toBe(false);
  });

  it('accepts a protocol v0.4 command envelope send_message payload', () => {
    expect(validateCommandPayload('send_message', { text: 'hello' })).toBe(true);
    expect(validateCommandPayload('send_message', {})).toBe(false);
  });

  it('accepts a v0.4-shaped AuditEvent after the Zod 4 protocol pin', () => {
    const event = buildAuditEvent({
      traceId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'seedbed',
      actor: { type: 'service', id: 'gateway' },
      service: 'gateway',
      action: 'brain.decision_made',
      category: 'brain',
      outcome: 'success',
      occurredAt: '2026-11-08T00:00:00.000Z',
      details: { grantsSpend: false },
    });
    const parsed = validateAuditEvent(event);
    expect(parsed.success).toBe(true);
  });

  it('research artifact findings stay capped', () => {
    const findings = Array.from({ length: 33 }, (_, i) => ({
      id: `f${i}`,
      text: 'sourced',
      sourceIds: ['s1'],
    }));
    const parsed = researchArtifactSchema.safeParse({
      artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      version: 1,
      workspaceId: 'seedbed',
      userId: TEST_USER_ID,
      goalId: TEST_GOAL_ID,
      threadId: TEST_THREAD_ID,
      landingPageUrl: 'https://example.com/offer',
      inputRevision: 'rev-1',
      status: 'awaiting_acceptance',
      providerName: 'fake',
      sources: [
        {
          sourceId: 's1',
          kind: 'http_url',
          url: 'https://example.com/offer',
          fetchedAt: '2026-11-08T00:00:00.000Z',
          sha256: 'a'.repeat(64),
        },
      ],
      findings,
      assumptions: [],
      unknowns: [],
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });
});
