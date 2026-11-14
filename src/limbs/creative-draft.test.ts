import { describe, expect, it } from 'vitest';
import { checkCreativeDraft, DEFAULT_CREATIVE_RULES } from './creative-draft.js';
import { creativeRulesFrom, loadGuardrails, NO_GUARDRAILS } from '../guardrails/guardrails.js';
import { testConfig } from '../testing/config.js';

const research = { artifactId: '00000000-0000-4000-8000-000000000001', version: 1, findingIds: ['f1'] };
const base = { userLandingPageUrl: 'https://example.com/offer', research };
const ok = { headline: 'Waterproof boots built for muddy UK trails', body: 'Tried them on the Pennine Way last month. Grippy, light, dry feet.' };

describe('creative.draft_post checks', () => {
  it('accepts a plain draft and binds the operator landing URL and accepted research', () => {
    const r = checkCreativeDraft(ok, base);
    expect(r).toMatchObject({ ok: true, draft: { type: 'TEXT', landingPageUrl: 'https://example.com/offer', researchArtifactId: research.artifactId } });
  });

  it('never defaults a landing URL and refuses a different one', () => {
    expect(checkCreativeDraft(ok, { ...base, userLandingPageUrl: undefined })).toMatchObject({ ok: false, code: 'user_input' });
    expect(checkCreativeDraft({ ...ok, landingPageUrl: 'https://evil.example/x' }, base)).toMatchObject({ ok: false, code: 'user_input' });
    expect(checkCreativeDraft({ ...ok, body: 'See https://other.example/deal' }, base)).toMatchObject({ ok: false, code: 'user_input' });
    expect(checkCreativeDraft({ ...ok, body: 'More at https://example.com/offer' }, base).ok).toBe(true);
  });

  it('requires accepted research before drafting', () => {
    expect(checkCreativeDraft(ok, { ...base, research: undefined })).toMatchObject({ ok: false, code: 'research_not_accepted' });
  });

  it('enforces length caps', () => {
    expect(checkCreativeDraft({ ...ok, headline: 'x'.repeat(301) }, base)).toMatchObject({ ok: false, code: 'creative_invalid' });
    expect(checkCreativeDraft({ ...ok, body: '' }, base)).toMatchObject({ ok: false, code: 'creative_invalid' });
  });

  it('refuses banned phrases', () => {
    expect(checkCreativeDraft({ ...ok, headline: 'Guaranteed dry feet' }, base)).toMatchObject({ ok: false, code: 'creative_invalid' });
    expect(checkCreativeDraft({ ...ok, body: 'Rated #1 by hikers' }, base)).toMatchObject({ ok: false, code: 'creative_invalid' });
  });

  it('refuses unsupported claims; claims must cite accepted findings', () => {
    const claimy = { ...ok, body: 'The lightest boot, 40% off this week.' };
    expect(checkCreativeDraft(claimy, base)).toMatchObject({ ok: false, code: 'creative_invalid' });
    expect(checkCreativeDraft({ ...claimy, claims: [{ text: '40% off', findingId: 'nope' }] }, base)).toMatchObject({ ok: false, code: 'creative_invalid' });
    expect(checkCreativeDraft({ ...claimy, claims: [{ text: '40% off', findingId: 'f1' }] }, base).ok).toBe(true);
    // A product name with a digit is not a claim.
    expect(checkCreativeDraft({ ...ok, headline: 'Trailhead 2 boots for wet trails' }, base).ok).toBe(true);
  });
});

describe('creative guardrails are tighten-only', () => {
  const limits = testConfig().limits;
  const file = (creative: Record<string, unknown>) => ({ schema: 'proba.gateway-guardrails/v1' as const, version: 't', verbs: {}, limits: {}, creative });

  it('lowers caps and adds banned phrases, never removing the code list', () => {
    const g = loadGuardrails({}, limits, { file: file({ maxHeadlineChars: 120, bannedPhrases: ['Cheapest'] }) });
    const rules = creativeRulesFrom(g);
    expect(rules.maxHeadlineChars).toBe(120);
    expect(rules.bannedPhrases).toContain('cheapest');
    expect(rules.bannedPhrases).toEqual(expect.arrayContaining([...DEFAULT_CREATIVE_RULES.bannedPhrases]));
    expect(checkCreativeDraft({ ...ok, headline: 'The cheapest boots' }, { ...base, rules }).ok).toBe(false);
    expect(creativeRulesFrom(NO_GUARDRAILS)).toEqual({ ...DEFAULT_CREATIVE_RULES, bannedPhrases: [...DEFAULT_CREATIVE_RULES.bannedPhrases] });
  });

  it('refuses a cap above the code lock', () => {
    expect(() => loadGuardrails({}, limits, { file: file({ maxHeadlineChars: 301 }) })).toThrow(/only tighten/);
    expect(() => loadGuardrails({}, limits, { file: file({ maxBodyChars: 10_001 }) })).toThrow(/only tighten/);
  });

  it('cannot set creative.draft_post to allow (the code requires approval)', () => {
    expect(() =>
      loadGuardrails({}, limits, { file: { schema: 'proba.gateway-guardrails/v1', version: 't', verbs: { 'creative.draft_post': 'allow' }, limits: {} } })
    ).toThrow(/loosen/);
  });
});

describe('plan card sections (targeting + defaults)', () => {
  it('accepts targeting and plan defaults with reasons and normalises names', () => {
    const r = checkCreativeDraft(
      {
        ...ok,
        targeting: { communities: ['r/UKhiking', 'hiking'], geolocations: ['gb'], languages: ['en'] },
        plan: { successMetric: 'clicks', successTarget: 200, durationDays: 14, reasons: { successMetric: 'chose clicks because the page has no signup form' } },
      },
      base
    );
    expect(r).toMatchObject({
      ok: true,
      draft: {
        targeting: { communities: ['UKhiking', 'hiking'], geolocations: ['GB'], languages: ['EN'] },
        plan: { platform: 'reddit', successMetric: 'clicks', successTarget: 200, durationDays: 14 },
      },
    });
  });

  it('refuses t5_ ids, unknown keys, non-reddit platforms and over-long schedules', () => {
    expect(checkCreativeDraft({ ...ok, targeting: { communities: ['t5_abc'] } }, base).ok).toBe(false);
    expect(checkCreativeDraft({ ...ok, targeting: { bid: 5 } }, base).ok).toBe(false);
    expect(checkCreativeDraft({ ...ok, plan: { successMetric: 'clicks', platform: 'meta' } }, base).ok).toBe(false);
    expect(checkCreativeDraft({ ...ok, plan: { successMetric: 'clicks', durationDays: 365 } }, base).ok).toBe(false);
    expect(checkCreativeDraft({ ...ok, plan: { successMetric: 'vibes' } }, base).ok).toBe(false);
    expect(checkCreativeDraft({ ...ok, targeting: { communities: Array.from({ length: 26 }, (_, i) => `sub${i}x`) } }, base).ok).toBe(false);
  });
});
