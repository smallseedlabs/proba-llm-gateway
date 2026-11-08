/** Test-only fixtures. Not used at runtime. */

import { randomUUID } from 'node:crypto';
import type { ContextPacket } from '../protocol.js';
import type { HubRunRequest } from '../types/run.js';
import type { TurnResponse } from '../types/llm.js';
import type { VerifiedCaller } from '../ports/auth.js';

export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_GOAL_ID = '11111111-1111-4111-8111-111111111113';
export const TEST_THREAD_ID = '11111111-1111-4111-8111-111111111114';

export function testCaller(overrides: Partial<VerifiedCaller> = {}): VerifiedCaller {
  return {
    issuer: 'proba-hub',
    subject: 'hub',
    jti: randomUUID(),
    keyId: 'k1',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

export function testRunRequest(overrides: Partial<HubRunRequest> = {}): HubRunRequest {
  return {
    traceId: randomUUID(),
    workspaceId: 'seedbed',
    userId: TEST_USER_ID,
    goalId: TEST_GOAL_ID,
    threadId: TEST_THREAD_ID,
    stepId: 'step-1',
    stepType: 'interpret_message',
    command: {
      kind: 'command',
      clientMsgId: randomUUID(),
      type: 'send_message',
      payload: { text: 'hello' },
      sentAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

export function testContextPacket(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    packetId: '110e8400-e29b-41d4-a716-446655440010',
    packetHash: 'b'.repeat(64),
    traceId: '220e8400-e29b-41d4-a716-446655440020',
    workspaceId: 'seedbed',
    userId: TEST_USER_ID,
    goalId: TEST_GOAL_ID,
    stepId: 'step-1',
    configVersion: '1',
    templateVersion: '1',
    sections: [
      {
        kind: 'task',
        priority: 0,
        tokens: 8,
        items: [
          {
            itemId: 'goal-state',
            sourceRef: { source: 'hub.task', id: TEST_GOAL_ID },
            trust: 'system',
            text: 'User-provided landing page is required before ads.',
            observedAt: new Date().toISOString(),
          },
        ],
      },
    ],
    gaps: [],
    manifest: {
      sources: {},
      totals: { returned: 1, included: 1, dropped: 0, tokens: 8, gaps: 0, latencyMs: 1 },
      droppedItemIds: [],
    },
    ...overrides,
  };
}

export function testTurn(overrides: Partial<TurnResponse> = {}): TurnResponse {
  return {
    message: { role: 'assistant', content: 'done' },
    finishReason: 'stop',
    model: 'test-model',
    provider: 'test-stub',
    usage: { promptTokens: 20, completionTokens: 8 },
    latencyMs: 5,
    cost: { estimate: 0.001, currency: 'USD', pricingVersion: 'test-v1' },
    ...overrides,
  };
}

export function testToolTurn(name: string, args: Record<string, unknown>, id = 'call-1'): TurnResponse {
  return testTurn({
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    },
    finishReason: 'tool_calls',
  });
}
