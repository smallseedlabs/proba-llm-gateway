/**
 * Fixed limb/verb definitions (invariants). Policies live in `policy.ts`.
 * Vendor-specific Reddit/Microsoft/Google/Meta logic does NOT live here.
 * Ads verbs operate on Proba campaign identity; the Ads domain maps those
 * ids onto provider campaign/ad-group/ad ids below this layer.
 *
 * Ad platform order when a domain service is attached: Reddit and Microsoft
 * first, Google later, Meta last. Those adapters are not in this process.
 * First marketing: user-provided page URL. Page generation is not allowlisted.
 */

import type { VerbDefinition } from '../types/limbs.js';

function verb(def: VerbDefinition): VerbDefinition {
  return def;
}

export const VERB_CATALOG: readonly VerbDefinition[] = [
  verb({
    limb: 'research',
    verb: 'gather',
    name: 'research.gather',
    description:
      'Fetch source-backed research for the Hub userSuppliedInput landing URL (findings, assumptions, unknowns). Context packets are not a research source. Unconfigured providers fail closed and do not invent citations.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
      },
    },
    risk: 'medium',
    sideEffecting: true,
    requiresApproval: false,
    allowlisted: true,
  }),
  verb({
    limb: 'research',
    verb: 'accept',
    name: 'research.accept',
    description:
      'Hub-mediated acceptance of the current research artifact version. Not offered to the model. Edits invalidate acceptance.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['artifactId', 'version', 'inputRevision'],
      properties: {
        artifactId: { type: 'string', minLength: 1, maxLength: 64 },
        version: { type: 'number' },
        inputRevision: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    risk: 'high',
    sideEffecting: true,
    requiresApproval: true,
    allowlisted: true,
  }),
  verb({
    limb: 'page',
    verb: 'attach_user_page',
    name: 'page.attach_user_page',
    description: 'Record a user-provided landing page URL on the Proba goal. Does not generate a page or call an ad network.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
      },
    },
    risk: 'medium',
    sideEffecting: true,
    requiresApproval: true,
    allowlisted: true,
  }),
  verb({
    limb: 'page',
    verb: 'generate_page',
    name: 'page.generate_page',
    description: 'Generate a marketing page. Not allowlisted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    risk: 'high',
    sideEffecting: true,
    requiresApproval: true,
    allowlisted: false,
  }),
  verb({
    limb: 'creative',
    verb: 'draft_post',
    name: 'creative.draft_post',
    description:
      'Propose the campaign plan in ONE card: the Reddit TEXT post (headline + body) plus optional targeting and plan defaults (success metric, platform, duration) for this goal from the goal, the operator page and the ACCEPTED research. The operator sees it as an approval card and may edit it; only their approval saves it as the goal creative, after which ads.create_campaign can run. Use this when no creative is saved yet. Write for Reddit: plain, specific, no hype. Any factual claim (numbers, prices, superlatives) must be listed in claims with the accepted research findingId it comes from. Never include URLs other than the operator landing page; never invent a landing page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'body'],
      properties: {
        headline: { type: 'string', minLength: 1, maxLength: 300 },
        body: { type: 'string', minLength: 1, maxLength: 10000 },
        rationale: { type: 'string', maxLength: 1000, description: 'Why this angle fits the goal and audience (shown to the operator).' },
        claims: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'findingId'],
            properties: { text: { type: 'string', maxLength: 300 }, findingId: { type: 'string', maxLength: 128 } },
          },
        },
        landingPageUrl: { type: 'string', minLength: 1, maxLength: 2048 },
        targeting: {
          type: 'object',
          description:
            'Your proposed Reddit targeting: communities (subreddit names, no r/ or t5_), geolocations (country codes like GB, US), interests, keywords, platforms, languages. Choose from the goal, page and research; explain each in plan.reasons.',
        },
        plan: {
          type: 'object',
          description:
            'Defaults you chose so the operator does not have to: platform (reddit), successMetric (clicks|ctr|cpc|landing_page_views|signups|conversions), successTarget (number over the run), durationDays, reasons {field: "chose X because Y"}.',
        },
      },
    },
    risk: 'medium',
    sideEffecting: false,
    requiresApproval: true,
    allowlisted: true,
  }),
  verb({
    limb: 'ads',
    verb: 'create_campaign',
    name: 'ads.create_campaign',
    description:
      'Create a Proba campaign blueprint (identity, budget, user-provided landing page, platform intent). The Ads domain maps to provider resources; this is not a raw provider pass-through.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'landingPageUrl', 'dailyBudget', 'currency', 'platform'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        landingPageUrl: { type: 'string', minLength: 1, maxLength: 2048 },
        dailyBudget: { type: 'number' },
        currency: { type: 'string', minLength: 3, maxLength: 3 },
        platform: { type: 'string', enum: ['reddit', 'microsoft', 'google', 'meta'] },
      },
    },
    risk: 'high',
    sideEffecting: true,
    requiresApproval: true,
    allowlisted: true,
    platforms: ['reddit', 'microsoft', 'google', 'meta'],
  }),
  verb({
    limb: 'ads',
    verb: 'update_campaign',
    name: 'ads.update_campaign',
    description:
      'Update a Proba campaign by probaCampaignId. The Ads domain must target mapped provider campaign/ad-group/ad ids; do not pass invented provider ids.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['probaCampaignId'],
      properties: {
        probaCampaignId: { type: 'string', minLength: 1, maxLength: 128 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        dailyBudget: { type: 'number' },
        landingPageUrl: { type: 'string', minLength: 1, maxLength: 2048 },
      },
    },
    risk: 'high',
    sideEffecting: true,
    requiresApproval: true,
    allowlisted: true,
    platforms: ['reddit', 'microsoft', 'google', 'meta'],
  }),
  verb({
    limb: 'ads',
    verb: 'pause_campaign',
    name: 'ads.pause_campaign',
    description: 'Pause a Proba campaign by probaCampaignId. Domain maps to the provider resource.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['probaCampaignId'],
      properties: {
        probaCampaignId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    risk: 'high',
    sideEffecting: true,
    requiresApproval: true,
    allowlisted: true,
    platforms: ['reddit', 'microsoft', 'google', 'meta'],
  }),
  verb({
    limb: 'ads',
    verb: 'move_budget',
    name: 'ads.move_budget',
    description:
      'Explicit cross-provider or cross-account budget movement. Not a side effect of pause/cap. Not allowlisted in this slice.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['fromPlatform', 'toPlatform', 'amount'],
      properties: {
        fromPlatform: { type: 'string', enum: ['reddit', 'microsoft', 'google', 'meta'] },
        toPlatform: { type: 'string', enum: ['reddit', 'microsoft', 'google', 'meta'] },
        amount: { type: 'number' },
      },
    },
    risk: 'high',
    sideEffecting: true,
    requiresApproval: true,
    allowlisted: false,
    platforms: ['reddit', 'microsoft', 'google', 'meta'],
  }),
  verb({
    limb: 'ads',
    verb: 'resume_campaign',
    name: 'ads.resume_campaign',
    description: 'Resume a Proba campaign by probaCampaignId. Domain maps to the provider resource.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['probaCampaignId'],
      properties: {
        probaCampaignId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    risk: 'medium',
    sideEffecting: true,
    requiresApproval: true,
    allowlisted: true,
    platforms: ['reddit', 'microsoft', 'google', 'meta'],
  }),
  verb({
    limb: 'analytics',
    verb: 'compare_metrics',
    name: 'analytics.compare_metrics',
    description: 'Read-only campaign metrics. Prefer the context bridge analytics_compare need.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    risk: 'low',
    sideEffecting: false,
    requiresApproval: false,
    allowlisted: false,
  }),
  verb({
    limb: 'analytics',
    verb: 'review_campaign',
    name: 'analytics.review_campaign',
    description:
      'Campaign review note (campaign.optimize). Call exactly once per review: what is working, what is not, whether to change anything NOW or wait, and when to look again. Be realistic, not aggressive: give changes time to work unless something is urgent (disapproval, runaway spend, budget nearly gone). Use only the audited metrics in context; unknown stays unknown.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'decision', 'whyNowOrNotYet', 'nextCheckInHours', 'nextCheckReason'],
      properties: {
        probaCampaignId: { type: 'string', maxLength: 128 },
        summary: { type: 'string', minLength: 1, maxLength: 600, description: 'Plain summary of how the campaign is doing, from the audited numbers in context.' },
        working: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
        notWorking: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
        whyNowOrNotYet: { type: 'string', minLength: 1, maxLength: 400, description: 'Why you change something now, or why it is too early (sample size, learning period, a recent change still settling).' },
        change: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          description: 'Optional reversible change: pause, or lower the daily budget. Goes to the operator/policy as a proposal; never executed by this call. Increases and new launches are not reviewer changes.',
          properties: { action: { type: 'string', enum: ['pause', 'lower_budget'] }, dailyBudget: { type: 'number', exclusiveMinimum: 0 } },
        },
        nextCheckInHours: { type: 'number', exclusiveMinimum: 0, description: 'When you want to look again. Kept inside the operator bounds.' },
        nextCheckReason: { type: 'string', minLength: 1, maxLength: 200 },
        decision: { type: 'string', enum: ['keep', 'change', 'wait'] },
      },
    },
    risk: 'low',
    sideEffecting: false,
    requiresApproval: false,
    allowlisted: true,
  }),
  verb({
    limb: 'analytics',
    verb: 'report_checkpoint',
    name: 'analytics.report_checkpoint',
    description:
      'Checkpoint report (report.checkpoint) on day 3, day 7 and at the end: target vs actual for the approved success metric, on track or not, and a continue / adjust / stop recommendation with up to 5 tweaks. actual must come from the audited metrics in context, or be null with status unknown. stop needs change {action:"pause"}.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['checkpoint', 'metric', 'status', 'recommendation', 'summary', 'whyNowOrNotYet', 'nextCheckInHours', 'nextCheckReason'],
      properties: {
        checkpoint: { type: 'string', enum: ['day3', 'day7', 'final'] },
        metric: { type: 'string', maxLength: 64 },
        target: { type: ['number', 'null'] },
        actual: { type: ['number', 'null'] },
        status: { type: 'string', enum: ['ahead', 'on_track', 'behind', 'unknown'] },
        recommendation: { type: 'string', enum: ['continue', 'adjust', 'stop'] },
        tweaks: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
        decision: { type: 'string', enum: ['keep', 'change', 'wait'] },
        probaCampaignId: { type: 'string', maxLength: 128 },
        summary: { type: 'string', minLength: 1, maxLength: 600, description: 'Plain summary of how the campaign is doing, from the audited numbers in context.' },
        working: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
        notWorking: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
        whyNowOrNotYet: { type: 'string', minLength: 1, maxLength: 400, description: 'Why you change something now, or why it is too early (sample size, learning period, a recent change still settling).' },
        change: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          description: 'Optional reversible change: pause, or lower the daily budget. Goes to the operator/policy as a proposal; never executed by this call. Increases and new launches are not reviewer changes.',
          properties: { action: { type: 'string', enum: ['pause', 'lower_budget'] }, dailyBudget: { type: 'number', exclusiveMinimum: 0 } },
        },
        nextCheckInHours: { type: 'number', exclusiveMinimum: 0, description: 'When you want to look again. Kept inside the operator bounds.' },
        nextCheckReason: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    risk: 'low',
    sideEffecting: false,
    requiresApproval: false,
    allowlisted: true,
  }),
];

export function verbByName(name: string): VerbDefinition | undefined {
  return VERB_CATALOG.find((v) => v.name === name || v.verb === name);
}

export function llmToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return VERB_CATALOG.filter((v) => v.allowlisted && v.name !== 'research.accept').map((v) => ({
    name: v.name,
    description: v.description,
    parameters: v.parameters,
  }));
}
