import { describe, expect, it } from 'vitest';
import { FALLBACK_SELF, runBriefText } from './brief.js';
import { initialMessages } from './messages.js';
import { testRunRequest } from '../testing/fixtures.js';
import { userLanding } from '../testing/research.js';

const budget = { iteration: 1, maxIterations: 4, toolCalls: 0, maxToolCalls: 8, tokens: 0, maxTotalTokens: 20000 };

describe('run brief', () => {
  it('says where missing inputs come from instead of letting the model invent them', () => {
    const text = runBriefText(testRunRequest(), { offeredTools: [], deniedByGuardrails: [], budget });
    expect(text).toContain('Landing page: none supplied');
    expect(text).toContain('Campaigns > Reddit post form');
    expect(text).toContain('goals.approved_creative');
    expect(text).toContain('Hub analytics review');
  });

  it('reports present inputs, tools and the budget, and leaves the choice of response to the model', () => {
    const text = runBriefText(testRunRequest({ userSuppliedInput: userLanding() }), {
      offeredTools: ['research.gather', 'ads.create_campaign'],
      deniedByGuardrails: [],
      budget: { ...budget, iteration: 2, toolCalls: 1, tokens: 1200 },
    });
    expect(text).toMatch(/Landing page: https:\/\/.+ \(operator-supplied\)/);
    expect(text).toContain('Post copy: operator-approved copy is saved on the goal');
    expect(text).toContain('Tools you can call now: research.gather, ads.create_campaign. Every one except research.gather raises an approval card');
    expect(text).toContain('Run budget: loop 2 of at most 4; 1 of 8 tool calls used; 1200 of 20000 tokens used.');
    expect(text).toContain('an answer, an explanation, a clarifying question, a proposal, or a tool call');
    expect(text).toContain('If an action is blocked, say why and what would unblock it.');
    expect(text).not.toMatch(/always|must end/i);
  });

  it('asks for the best response on the last allowed loop', () => {
    const text = runBriefText(testRunRequest(), { offeredTools: [], deniedByGuardrails: [], budget: { ...budget, iteration: 4 } });
    expect(text).toContain('This is the last loop the budget allows');
  });

  it('uses the fallback self when the packet has none, keeping self first', () => {
    const [system] = initialMessages(undefined, testRunRequest(), { offeredTools: [], deniedByGuardrails: [], budget });
    expect(system?.content?.startsWith(`[self]\n${FALLBACK_SELF}`)).toBe(true);
    expect(system?.content).toContain('[run]');
  });
});
