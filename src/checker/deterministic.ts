export interface DeterministicCheckInput {
  artifactKind: 'creative_copy' | 'creative_media' | 'targeting' | 'budget_plan' | 'optimiser_proposal';
  userLandingPageUrl?: string;
  plannerBounds?: {
    dailyBudget: number;
    totalBudget: number;
    platforms: string[];
    countries: string[];
  };
  payload: Record<string, unknown>;
}

export interface CheckerVerdict {
  approved: boolean;
  layer: 'deterministic' | 'llm_checker';
  reason: string;
  field?: string;
  checkedAt: string;
}

const BANNED_PHRASE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b100%\s+guaranteed\b/i, label: 'unsubstantiated 100% guarantee' },
  { re: /\bguaranteed\s+(roi|returns|results|sales|profit)\b/i, label: 'guaranteed financial/performance claim' },
  { re: /\bget\s+rich\s+quick\b/i, label: 'get-rich-quick claim' },
  { re: /\bmiracle\s+cure\b/i, label: 'prohibited medical miracle claim' },
  { re: /\bno\s+risk\b/i, label: 'deceptive no-risk claim' },
  { re: /\bfree\s+money\b/i, label: 'deceptive free-money claim' },
  { re: /\bact\s+now\s+or\s+lose\b/i, label: 'coercive urgency claim' },
  { re: /\bclick\s+here\s+for\s+free\b/i, label: 'clickbait free-offer phrasing' },
];

export function runDeterministicCheck(
  input: DeterministicCheckInput,
  now: Date = new Date()
): CheckerVerdict {
  const checkedAt = now.toISOString();
  const { payload, userLandingPageUrl, plannerBounds } = input;

  // 1. Landing page URL must match user-supplied URL if provided
  if (typeof payload.landingPageUrl === 'string' && userLandingPageUrl) {
    try {
      const actual = new URL(payload.landingPageUrl);
      const expected = new URL(userLandingPageUrl);
      if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
        return {
          approved: false,
          layer: 'deterministic',
          field: 'landingPageUrl',
          reason: `landingPageUrl (${actual.origin}${actual.pathname}) does not match operator URL (${expected.origin}${expected.pathname})`,
          checkedAt,
        };
      }
    } catch {
      return {
        approved: false,
        layer: 'deterministic',
        field: 'landingPageUrl',
        reason: 'landingPageUrl is malformed',
        checkedAt,
      };
    }
  }

  // 2. Creative copy length & banned phrases
  if (input.artifactKind === 'creative_copy' || input.artifactKind === 'creative_media') {
    const headline = typeof payload.headline === 'string' ? payload.headline.trim() : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    if (input.artifactKind === 'creative_copy' && (!headline || !body)) {
      return {
        approved: false,
        layer: 'deterministic',
        field: !headline ? 'headline' : 'body',
        reason: 'creative_copy requires non-empty headline and body',
        checkedAt,
      };
    }
    if (headline.length > 120) {
      return {
        approved: false,
        layer: 'deterministic',
        field: 'headline',
        reason: `headline length (${headline.length}) exceeds 120 characters`,
        checkedAt,
      };
    }
    if (body.length > 1000) {
      return {
        approved: false,
        layer: 'deterministic',
        field: 'body',
        reason: `body length (${body.length}) exceeds 1000 characters`,
        checkedAt,
      };
    }
    const combined = `${headline}\n${body}`;
    for (const { re, label } of BANNED_PHRASE_PATTERNS) {
      if (re.test(combined)) {
        return {
          approved: false,
          layer: 'deterministic',
          field: re.test(headline) ? 'headline' : 'body',
          reason: `Banned phrase detected: ${label}`,
          checkedAt,
        };
      }
    }
  }

  // 3. Targeting must have valid ISO-2 countries and never empty
  if (input.artifactKind === 'targeting') {
    const geos = Array.isArray(payload.geolocations) ? payload.geolocations : [];
    const validGeos = geos.filter((g) => typeof g === 'string' && /^[A-Z]{2}$/.test(g.trim().toUpperCase()));
    if (validGeos.length === 0) {
      return {
        approved: false,
        layer: 'deterministic',
        field: 'geolocations',
        reason: 'targeting requires at least one valid ISO-2 country code',
        checkedAt,
      };
    }
  }

  // 4. Budget & platform bounds against PlannerResult
  if (plannerBounds) {
    if (typeof payload.dailyBudget === 'number' && payload.dailyBudget > plannerBounds.dailyBudget) {
      return {
        approved: false,
        layer: 'deterministic',
        field: 'dailyBudget',
        reason: `dailyBudget (${payload.dailyBudget}) exceeds planner bound (${plannerBounds.dailyBudget})`,
        checkedAt,
      };
    }
    if (typeof payload.totalBudget === 'number' && payload.totalBudget > plannerBounds.totalBudget) {
      return {
        approved: false,
        layer: 'deterministic',
        field: 'totalBudget',
        reason: `totalBudget (${payload.totalBudget}) exceeds planner bound (${plannerBounds.totalBudget})`,
        checkedAt,
      };
    }
    if (typeof payload.platform === 'string' && !plannerBounds.platforms.includes(payload.platform)) {
      return {
        approved: false,
        layer: 'deterministic',
        field: 'platform',
        reason: `platform (${payload.platform}) is outside planner platforms [${plannerBounds.platforms.join(', ')}]`,
        checkedAt,
      };
    }
  }

  return {
    approved: true,
    layer: 'deterministic',
    reason: 'All deterministic guardrail checks passed',
    checkedAt,
  };
}
