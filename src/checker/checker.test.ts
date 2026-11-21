import { describe, expect, it, vi } from 'vitest';
import { checkArtifact, runDeterministicCheck, type DeterministicCheckInput } from './index.js';

const BASE_BOUNDS = {
  dailyBudget: 25,
  totalBudget: 150,
  platforms: ['reddit'],
  countries: ['GB', 'US'],
};

const BAD_CASES: DeterministicCheckInput[] = [
  // 1-8: banned phrases
  { artifactKind: 'creative_copy', payload: { headline: '100% guaranteed results', body: 'Try now' } },
  { artifactKind: 'creative_copy', payload: { headline: 'Grow fast', body: 'Guaranteed ROI in 7 days' } },
  { artifactKind: 'creative_copy', payload: { headline: 'Get rich quick with AI', body: 'Sign up' } },
  { artifactKind: 'creative_copy', payload: { headline: 'Miracle cure for acne', body: 'Buy today' } },
  { artifactKind: 'creative_copy', payload: { headline: 'No risk investing', body: 'Join now' } },
  { artifactKind: 'creative_copy', payload: { headline: 'Free money waiting', body: 'Claim today' } },
  { artifactKind: 'creative_copy', payload: { headline: 'Act now or lose forever', body: 'Click below' } },
  { artifactKind: 'creative_copy', payload: { headline: 'Click here for free cash', body: 'Limited' } },
  // 9-12: missing / oversized copy
  { artifactKind: 'creative_copy', payload: { headline: '', body: 'Valid body' } },
  { artifactKind: 'creative_copy', payload: { headline: 'Valid headline', body: '' } },
  { artifactKind: 'creative_copy', payload: { headline: 'A'.repeat(121), body: 'Valid body' } },
  { artifactKind: 'creative_copy', payload: { headline: 'Valid', body: 'B'.repeat(1001) } },
  // 13-16: wrong or malformed landing URL
  {
    artifactKind: 'creative_copy',
    userLandingPageUrl: 'https://acme.test/signup',
    payload: { headline: 'Test', body: 'Body', landingPageUrl: 'https://evil.test/signup' },
  },
  {
    artifactKind: 'creative_copy',
    userLandingPageUrl: 'https://acme.test/signup',
    payload: { headline: 'Test', body: 'Body', landingPageUrl: 'https://acme.test/other' },
  },
  {
    artifactKind: 'creative_copy',
    userLandingPageUrl: 'https://acme.test/signup',
    payload: { headline: 'Test', body: 'Body', landingPageUrl: 'not-a-url' },
  },
  {
    artifactKind: 'creative_media',
    userLandingPageUrl: 'https://acme.test/signup',
    payload: { landingPageUrl: 'https://competitor.test/' },
  },
  // 17-20: invalid targeting
  { artifactKind: 'targeting', payload: { geolocations: [] } },
  { artifactKind: 'targeting', payload: { geolocations: ['INVALID'] } },
  { artifactKind: 'targeting', payload: { geolocations: ['123'] } },
  { artifactKind: 'targeting', payload: {} },
  // 21-30: planner bounds violations
  { artifactKind: 'budget_plan', plannerBounds: BASE_BOUNDS, payload: { dailyBudget: 26 } },
  { artifactKind: 'budget_plan', plannerBounds: BASE_BOUNDS, payload: { dailyBudget: 100 } },
  { artifactKind: 'budget_plan', plannerBounds: BASE_BOUNDS, payload: { totalBudget: 151 } },
  { artifactKind: 'budget_plan', plannerBounds: BASE_BOUNDS, payload: { totalBudget: 500 } },
  { artifactKind: 'budget_plan', plannerBounds: BASE_BOUNDS, payload: { platform: 'meta' } },
  { artifactKind: 'budget_plan', plannerBounds: BASE_BOUNDS, payload: { platform: 'google' } },
  { artifactKind: 'optimiser_proposal', plannerBounds: BASE_BOUNDS, payload: { dailyBudget: 30 } },
  { artifactKind: 'optimiser_proposal', plannerBounds: BASE_BOUNDS, payload: { totalBudget: 200 } },
  { artifactKind: 'optimiser_proposal', plannerBounds: BASE_BOUNDS, payload: { platform: 'meta' } },
  {
    artifactKind: 'optimiser_proposal',
    userLandingPageUrl: 'https://acme.test/offer',
    payload: { landingPageUrl: 'https://hijack.test/offer' },
  },
];

const GOOD_CASES: DeterministicCheckInput[] = Array.from({ length: 30 }, (_, i) => ({
  artifactKind: i % 3 === 0 ? 'creative_copy' : i % 3 === 1 ? 'targeting' : 'budget_plan',
  userLandingPageUrl: 'https://acme.test/offer',
  plannerBounds: BASE_BOUNDS,
  payload:
    i % 3 === 0
      ? {
          headline: `Automate ad testing #${i + 1}`,
          body: 'Run structured Reddit and Meta experiments within your budget cap.',
          landingPageUrl: 'https://acme.test/offer?utm_source=reddit',
        }
      : i % 3 === 1
        ? { geolocations: ['GB', 'US'] }
        : { dailyBudget: 20, totalBudget: 140, platform: 'reddit' },
}));

describe('H3-02 single-pass guardrails checker (30 bad + 30 good golden set)', () => {
  it('rejects >= 95% of red-team bad cases and passes >= 90% of good cases', () => {
    const rejectedCount = BAD_CASES.filter((c) => !runDeterministicCheck(c).approved).length;
    const passedCount = GOOD_CASES.filter((c) => runDeterministicCheck(c).approved).length;

    expect(rejectedCount / BAD_CASES.length).toBeGreaterThanOrEqual(0.95);
    expect(passedCount / GOOD_CASES.length).toBeGreaterThanOrEqual(0.9);
  });

  it('skips LLM checker when Part A fails and invokes separate-context LLM checker only when Part A passes', async () => {
    const llmChecker = vi.fn(async () => ({ approved: true, reason: 'Looks safe' }));

    const bad = await checkArtifact(BAD_CASES[0]!, llmChecker);
    expect(bad.approved).toBe(false);
    expect(bad.layer).toBe('deterministic');
    expect(llmChecker).not.toHaveBeenCalled();

    const good = await checkArtifact(GOOD_CASES[0]!, llmChecker);
    expect(good.approved).toBe(true);
    expect(good.layer).toBe('llm_checker');
    expect(llmChecker).toHaveBeenCalledTimes(1);
  });
});
