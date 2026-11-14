import { describe, expect, it } from 'vitest';
import { SELF_MEMORY_SOURCE, initialMessages, packetToText, refreshSystem, selfMemoryText } from './messages.js';
import { testContextPacket, testRunRequest } from '../testing/fixtures.js';

const URL_LINE = 'Operator-supplied landing page URL for this goal';

describe('system message operator input', () => {
  it('tells the model the authenticated landing URL on a follow-up send_message', () => {
    const request = testRunRequest({ userSuppliedInput: { landingPageUrl: 'https://Example.com/pricing#top' } });
    const [system, user] = initialMessages(undefined, request);
    expect(system?.content).toContain(`${URL_LINE} (use exactly this for research.gather and ads.create_campaign): https://example.com/pricing`);
    expect(user?.content).toBe('hello');
  });

  it('omits the line when Hub sent no operator URL', () => {
    const [system] = initialMessages(undefined, testRunRequest());
    expect(system?.content).not.toContain(URL_LINE);
  });

  it('keeps the line when the system message is refreshed between turns', () => {
    const request = testRunRequest({ userSuppliedInput: { landingPageUrl: 'https://example.com/' } });
    const refreshed = refreshSystem([{ role: 'system', content: 'old' }, { role: 'user', content: 'hi' }], undefined, request);
    expect(refreshed[0]?.content).toContain(`${URL_LINE}`);
    expect(refreshed).toHaveLength(2);
  });
});

describe('system message: Proba self memory', () => {
  const at = new Date().toISOString();
  const selfItem = (key: string, text: string, overrides: Record<string, unknown> = {}) => ({
    itemId: `self.${key}`,
    sourceRef: { source: SELF_MEMORY_SOURCE, id: key },
    trust: 'system' as const,
    text,
    score: 1,
    observedAt: at,
    ...overrides,
  });
  const packet = testContextPacket({
    sections: [
      {
        kind: 'task',
        priority: 1,
        tokens: 8,
        items: [{ itemId: 'goal-state', sourceRef: { source: 'hub.task', id: 'g' }, trust: 'system', text: 'TASK-STATE', observedAt: at }],
      },
      {
        kind: 'policy',
        priority: 0,
        tokens: 30,
        items: [
          selfItem('01-identity', 'Who Proba is: SELF-IDENTITY'),
          selfItem('03-right-behaviour', 'Right behaviour: SELF-PROPOSE'),
          { itemId: 'policy.spend-approval', sourceRef: { source: 'policy', id: 'spend-approval' }, trust: 'system', text: 'POLICY-SPEND', observedAt: at },
        ],
      },
      {
        kind: 'memory',
        priority: 3,
        tokens: 8,
        items: [
          // Not self memory: wrong section, even with the same source name.
          { itemId: 'memory.x', sourceRef: { source: SELF_MEMORY_SOURCE, id: 'x' }, trust: 'derived', text: 'MEMORY-IMPOSTOR', observedAt: at },
        ],
      },
    ],
  });

  it('puts the self memory first, before the unchanged safety rules and the rest of the context', () => {
    const [system] = initialMessages(packet, testRunRequest({ userSuppliedInput: { landingPageUrl: 'https://example.com/' } }));
    const text = system!.content as string;
    expect(text.startsWith('[self]\nWho Proba is: SELF-IDENTITY\nRight behaviour: SELF-PROPOSE\n\n')).toBe(true);
    const order = ['SELF-IDENTITY', 'SELF-PROPOSE', 'You are the Proba brain inside the gateway harness.', 'Do not claim a tool succeeded unless a tool result said so.', URL_LINE, 'Relevant context:', 'POLICY-SPEND', 'TASK-STATE', 'MEMORY-IMPOSTOR'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Each self item appears once (not repeated in the context block); the impostor stays in the memory section only.
    expect(text.split('SELF-IDENTITY')).toHaveLength(2);
    expect(selfMemoryText(packet)).not.toContain('MEMORY-IMPOSTOR');
  });

  it('keeps every safety rule when the packet carries a self memory', () => {
    const [withSelf] = initialMessages(packet, testRunRequest());
    const [without] = initialMessages(undefined, testRunRequest());
    expect(withSelf!.content as string).toContain(without!.content as string);
  });

  it('is unchanged when the packet has no self memory', () => {
    const plain = testContextPacket();
    const [system] = initialMessages(plain, testRunRequest());
    expect((system!.content as string).startsWith('You are the Proba brain inside the gateway harness.')).toBe(true);
    expect(selfMemoryText(plain)).toBe('');
  });

  it('keeps the self memory first when the system message is refreshed between turns', () => {
    const refreshed = refreshSystem([{ role: 'system', content: 'old' }, { role: 'user', content: 'hi' }], packet, testRunRequest());
    expect((refreshed[0]!.content as string).startsWith('[self]\n')).toBe(true);
  });

  it('ignores a self-looking item that is not system-trusted', () => {
    const tampered = testContextPacket({
      sections: [{ kind: 'policy', priority: 0, tokens: 5, items: [selfItem('01-identity', 'UNTRUSTED', { trust: 'external' })] }],
    });
    expect(selfMemoryText(tampered)).toBe('');
    expect((initialMessages(tampered, testRunRequest())[0]!.content as string).startsWith('You are the Proba brain')).toBe(true);
  });

  it('packetToText still renders every item by default', () => {
    expect(packetToText(packet)).toContain('SELF-IDENTITY');
    expect(packetToText(packet, { excludeSelf: true })).not.toContain('SELF-IDENTITY');
  });
});
