/**
 * Checks for a model-drafted Reddit post (`creative.draft_post`). The brain may DRAFT copy; it never
 * saves or launches it. Hub shows the draft as a guardrail card, and only the operator's approve (with
 * optional edits) writes goals.approved_creative. These checks run before the card is shown:
 *   - length within the code lock and any tighter operator guardrail;
 *   - no banned phrases (code list plus operator additions; operators can add, never remove);
 *   - claim-like copy (stats, money, superlatives) must cite findings from the ACCEPTED research artifact;
 *   - any URL in the copy must be on the operator-entered landing page host. The landing URL attached to
 *     the draft is always the Hub userSuppliedInput URL; nothing is defaulted or invented.
 */

import { normalizeLandingPageUrl } from '../research/input.js';

/** Code locks. Reddit headline max is 300; body is locked well under Reddit's 40k so drafts stay ad-sized. */
export const CREATIVE_LOCKS = Object.freeze({ maxHeadlineChars: 300, maxBodyChars: 10_000, maxClaims: 10 });

/** Always refused, whatever the guardrails say (Reddit ad policy and plain honesty). Case-insensitive. */
export const LOCKED_BANNED_PHRASES: readonly string[] = Object.freeze([
  'guarantee',
  'guaranteed',
  'risk-free',
  'risk free',
  '100%',
  '#1',
  'no. 1',
  'number one',
  'best in the world',
  'clinically proven',
  'scientifically proven',
  'miracle',
  'cure',
  'cures',
  'get rich',
  'free money',
]);

export interface CreativeRules {
  maxHeadlineChars: number;
  maxBodyChars: number;
  /** Code list plus operator additions. */
  bannedPhrases: readonly string[];
}

export const DEFAULT_CREATIVE_RULES: CreativeRules = Object.freeze({
  maxHeadlineChars: CREATIVE_LOCKS.maxHeadlineChars,
  maxBodyChars: CREATIVE_LOCKS.maxBodyChars,
  bannedPhrases: LOCKED_BANNED_PHRASES,
});

export interface DraftClaim {
  text: string;
  findingId: string;
}

export interface CheckedDraft {
  type: 'TEXT';
  headline: string;
  body: string;
  landingPageUrl: string;
  claims: DraftClaim[];
  rationale?: string;
  researchArtifactId: string;
  researchVersion: number;
}

export type DraftCheck =
  | { ok: true; draft: CheckedDraft }
  | { ok: false; code: 'creative_invalid' | 'research_not_accepted' | 'user_input'; reason: string };

export interface DraftCheckInput {
  userLandingPageUrl: string | undefined;
  /** Accepted research for this goal/thread and landing URL; undefined when none is accepted. */
  research?: { artifactId: string; version: number; findingIds: readonly string[] };
  rules?: CreativeRules;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseHit(text: string, phrase: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (!p) return false;
  const lower = text.toLowerCase();
  // Word boundaries only where the phrase starts/ends with a word character ("#1", "100%" match as written).
  const start = /^\w/.test(p) ? '\\b' : '';
  const end = /\w$/.test(p) ? '\\b' : '';
  return new RegExp(`${start}${escapeRe(p)}${end}`, 'i').test(lower);
}

/** Copy that asserts a fact a reader could check: percentages, money, multipliers, counts of people, superlatives. */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\d+(?:[.,]\d+)?\s*%/,
  /[$£€¥]\s*\d/,
  /\d+(?:[.,]\d+)?\s*(?:usd|gbp|eur|dollars|pounds|euros)\b/i,
  /\b\d+(?:[.,]\d+)?\s*x\b/i,
  /\b\d[\d,.]*\s*\+?\s*(?:k\s+)?(?:customers|users|people|buyers|reviews|downloads|members|teams|companies|sold)\b/i,
  /\b(?:best|fastest|cheapest|lowest|highest|leading|top-rated|award-winning|most popular|world's|proven|certified|official)\b/i,
];

export function hasClaimLanguage(text: string): boolean {
  return CLAIM_PATTERNS.some((re) => re.test(text));
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;

function urlsIn(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

function hostOf(value: string): string | undefined {
  try {
    return new URL(value.startsWith('www.') ? `https://${value}` : value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkCreativeDraft(raw: Record<string, unknown>, input: DraftCheckInput): DraftCheck {
  const rules = input.rules ?? DEFAULT_CREATIVE_RULES;
  const userUrl = normalizeLandingPageUrl(input.userLandingPageUrl);
  if (!userUrl) {
    return {
      ok: false,
      code: 'user_input',
      reason:
        'creative.draft_post needs the operator-entered landing page URL (Hub userSuppliedInput.landingPageUrl). There is no default landing page; ask the operator for their page URL.',
    };
  }
  if (raw.landingPageUrl !== undefined && normalizeLandingPageUrl(raw.landingPageUrl) !== userUrl) {
    return {
      ok: false,
      code: 'user_input',
      reason: 'landingPageUrl in the draft does not match the operator-entered landing page; omit it or use the operator URL exactly',
    };
  }
  if (!input.research) {
    return {
      ok: false,
      code: 'research_not_accepted',
      reason:
        'Draft copy only from accepted research: run research.gather for the operator URL and wait for the operator to accept it, then draft again.',
    };
  }
  const headline = typeof raw.headline === 'string' ? raw.headline.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!headline || headline.length > rules.maxHeadlineChars) {
    return { ok: false, code: 'creative_invalid', reason: `headline must be 1-${rules.maxHeadlineChars} characters` };
  }
  if (!body || body.length > rules.maxBodyChars) {
    return { ok: false, code: 'creative_invalid', reason: `body must be 1-${rules.maxBodyChars} characters` };
  }
  const text = `${headline}\n${body}`;
  const banned = rules.bannedPhrases.filter((phrase) => phraseHit(text, phrase));
  if (banned.length > 0) {
    return {
      ok: false,
      code: 'creative_invalid',
      reason: `the copy uses banned phrases (${banned.slice(0, 5).map((p) => `"${p}"`).join(', ')}); rewrite without them`,
    };
  }
  const userHost = hostOf(userUrl);
  const foreign = urlsIn(text).filter((u) => hostOf(u) !== userHost);
  if (foreign.length > 0) {
    return {
      ok: false,
      code: 'user_input',
      reason: 'the copy links somewhere other than the operator-entered landing page; remove other URLs (the ad already clicks through to the operator URL)',
    };
  }

  const rawClaims = raw.claims === undefined ? [] : raw.claims;
  if (!Array.isArray(rawClaims) || rawClaims.length > CREATIVE_LOCKS.maxClaims) {
    return { ok: false, code: 'creative_invalid', reason: `claims must be an array of at most ${CREATIVE_LOCKS.maxClaims} {text, findingId}` };
  }
  const known = new Set(input.research.findingIds);
  const claims: DraftClaim[] = [];
  for (const c of rawClaims) {
    if (!isRecord(c) || typeof c.text !== 'string' || typeof c.findingId !== 'string' || !c.text.trim() || c.text.length > 300) {
      return { ok: false, code: 'creative_invalid', reason: 'each claim needs text (1-300 chars) and the findingId it comes from' };
    }
    if (!known.has(c.findingId)) {
      return {
        ok: false,
        code: 'creative_invalid',
        reason: `claim "${c.text.slice(0, 80)}" cites ${c.findingId}, which is not a finding in the accepted research; cite an accepted finding or drop the claim`,
      };
    }
    claims.push({ text: c.text.trim(), findingId: c.findingId });
  }
  if (hasClaimLanguage(text) && claims.length === 0) {
    return {
      ok: false,
      code: 'creative_invalid',
      reason:
        'the copy makes factual claims (numbers, prices, superlatives) without citing accepted research findings; add claims[{text, findingId}] or remove the claim',
    };
  }
  const rationale = typeof raw.rationale === 'string' && raw.rationale.trim() ? raw.rationale.trim().slice(0, 1000) : undefined;
  return {
    ok: true,
    draft: {
      type: 'TEXT',
      headline,
      body,
      landingPageUrl: userUrl,
      claims,
      ...(rationale ? { rationale } : {}),
      researchArtifactId: input.research.artifactId,
      researchVersion: input.research.version,
    },
  };
}
