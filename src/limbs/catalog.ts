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
        lookupUrls: {
          type: 'array',
          maxItems: 3,
          items: { type: 'string', minLength: 1, maxLength: 2048 },
          description:
            'Optional public https URLs (up to 3) to fetch for category or Reddit ad-practice research. Each becomes a lookup-* source.',
        },
      },
    },
    risk: 'medium',
    sideEffecting: true,
    requiresApproval: false,
    allowlisted: true,
  }),
  verb({
    limb: 'research',
    verb: 'search',
    name: 'web.search',
    description:
      'Search the open web for current ad platform rules, minimum budgets, category context, benchmarks, or audience insights. Read-only; runs without an approval card.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 300 },
        maxResults: { type: 'number', minimum: 1, maximum: 8 },
      },
    },
    risk: 'low',
    sideEffecting: false,
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
    verb: 'list_assets',
    name: 'creative.list_assets',
    description:
      'Search Proba Asset Service for existing images and videos (with full merchandising title, description, tags, visualStyle, useCases, curationStatus, and performance). ALWAYS call this BEFORE creative.generate_media so existing approved or matching assets are reused rather than regenerating and spending credits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['image', 'video'], description: 'Filter by image or video.' },
        query: { type: 'string', maxLength: 200, description: 'Search title, description, prompt, or tags.' },
        tag: { type: 'string', maxLength: 64, description: 'Filter by exact tag.' },
        useCase: { type: 'string', maxLength: 64, description: 'Filter by use case (e.g. awareness, traffic, leads, retargeting).' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
    },
    risk: 'low',
    sideEffecting: false,
    requiresApproval: false,
    allowlisted: true,
  }),
  verb({
    limb: 'creative',
    verb: 'generate_media',
    name: 'creative.generate_media',
    description:
      'Generate or fetch high-class ad images and short videos (via fal.ai FLUX / Kling or Pexels stock), save them with rich merchandising metadata to the Asset Service, and return a hosted HTTPS URL + assetId. Call creative.list_assets first to check if a suitable asset already exists.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'prompt', 'title', 'description'],
      properties: {
        kind: { type: 'string', enum: ['image', 'video'], description: 'Generate an image or a short ad video.' },
        prompt: {
          type: 'string',
          minLength: 3,
          maxLength: 1000,
          description: 'Structured art-direction prompt: [Camera/shot] + [Authentic subject/product action] + [Natural/UGC lighting] + [Negative constraints: no garbled embedded text, no plastic stock gloss].',
        },
        title: { type: 'string', minLength: 2, maxLength: 200, description: 'Short descriptive asset title for the Studio library.' },
        description: {
          type: 'string',
          minLength: 10,
          maxLength: 2000,
          description: 'Detailed visual & merchandising description (subject, mood, setting, colors, ideal audience/angle) so Brain can reuse this asset without vision.',
        },
        tags: {
          type: 'array',
          maxItems: 16,
          items: { type: 'string', minLength: 1, maxLength: 64 },
          description: 'Searchable merchandising tags (e.g. ["saas", "founder", "warm-lighting", "product-demo"]).',
        },
        visualStyle: { type: 'string', maxLength: 120, description: 'e.g. "ugc-handheld", "editorial-studio", "minimalist-product".' },
        brandElements: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string', minLength: 1, maxLength: 120 },
          description: 'Brand cues visible or represented in this asset.',
        },
        useCases: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 64 },
          description: 'Best-fit campaign goals/placements (e.g. ["awareness", "traffic", "meta-feed", "reels"]).',
        },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '4:5', '9:16', '16:9'],
          description: '4:5 for Meta Feed (preferred), 9:16 for Reels/Stories, 1:1 square, 16:9 landscape.',
        },
        quality: { type: 'string', enum: ['fast', 'high'], description: 'fast (economical default) or high (studio quality).' },
        source: {
          type: 'string',
          enum: ['auto', 'ai', 'stock'],
          description:
            'auto tries free stock (Pexels) first if configured, then fal.ai. Use stock to inspect free internet media first; use ai only for out-of-the-box bespoke concepts when brand/stock assets are insufficient.',
        },
        searchQuery: {
          type: 'string',
          minLength: 2,
          maxLength: 100,
          description: 'Short 2-5 keyword query when searching free stock (e.g. "enterprise team collaboration").',
        },
        sourceImageUrl: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description: 'Optional image URL to animate into a video (image-to-video).',
        },
        parentAssetId: {
          type: 'string',
          maxLength: 128,
          description: 'Optional assetId of the source image when creating an image-to-video variant.',
        },
        durationSeconds: { type: 'number', enum: [5, 10], description: 'Video length in seconds (5 or 10).' },
      },
    },
    risk: 'low',
    sideEffecting: true,
    requiresApproval: false,
    allowlisted: true,
  }),
  verb({
    limb: 'creative',
    verb: 'draft_post',
    name: 'creative.draft_post',
    description:
      'Propose a campaign plan & creative card (copy + visual media + CTA + optional targeting + plan defaults) for either reddit or meta (Facebook & Instagram) from the goal, the operator page and the ACCEPTED research. For reddit: write plain, specific post copy. For meta: craft visual-first creative (concise primary text, punchy headline <= 40 chars, imageUrl or videoUrl, ctaType, and visualBrief). When the goal or connected ad accounts include Meta or multiple platforms, propose plan.platform accordingly (and draft separate cards for reddit and meta when targeting both). Never invent URLs or ungrounded factual claims.',
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
        imageUrl: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description:
            'Optional validated image URL from an accepted img-* research source on the operator landing page. When omitted and an accepted img-* source exists, the first validated landing-page image is attached automatically.',
        },
        videoUrl: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description: 'Optional HTTPS video URL (MP4/MOV/WebM) for Meta/Reddit video creatives.',
        },
        ctaType: {
          type: 'string',
          enum: ['LEARN_MORE', 'WATCH_NOW', 'VIEW_MORE', 'SIGN_UP', 'SHOP_NOW', 'GET_QUOTE', 'DOWNLOAD', 'SUBSCRIBE', 'APPLY_NOW'],
          description: 'Call-to-action button for visual/Meta/Reddit ads (default LEARN_MORE).',
        },
        visualBrief: {
          type: 'string',
          maxLength: 2000,
          description: 'Creative art-direction note (<= 2000 chars) describing the visual composition or hero image/video angle.',
        },
        targeting: {
          type: 'object',
          description:
            'Your proposed targeting: communities (Reddit subreddit names, no r/ or t5_), geolocations (country codes like GB, US), interests, keywords, platforms, languages. Choose from the goal, page and research; explain each in plan.reasons.',
        },
        plan: {
          type: 'object',
          description:
            'Defaults you chose so the operator does not have to: platform (reddit | meta), successMetric (clicks|ctr|cpc|landing_page_views|signups|conversions), successTarget (number over the run), durationDays, reasons {field: "chose X because Y"}.',
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
        bidStrategy: {
          type: 'string',
          enum: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
          description:
            'Bidding strategy chosen for this campaign (e.g. LOWEST_COST_WITHOUT_CAP for open learning/delivery, or LOWEST_COST_WITH_BID_CAP / COST_CAP paired with bidAmount).',
        },
        bidAmount: {
          type: 'number',
          description: 'Optional bid cap or cost cap in campaign currency when using a capped bidStrategy.',
        },
        objective: {
          type: 'string',
          enum: ['OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES'],
          description: 'Campaign objective chosen for the goal (e.g. OUTCOME_TRAFFIC or OUTCOME_AWARENESS).',
        },
        optimizationGoal: {
          type: 'string',
          enum: ['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'IMPRESSIONS', 'REACH', 'OFFSITE_CONVERSIONS'],
          description: 'Delivery optimization goal matching the goal and tracking readiness.',
        },
        billingEvent: {
          type: 'string',
          enum: ['IMPRESSIONS', 'LINK_CLICKS'],
          description: 'Billing event for ad set delivery (e.g. IMPRESSIONS).',
        },
        ctaType: {
          type: 'string',
          enum: ['LEARN_MORE', 'WATCH_NOW', 'VIEW_MORE', 'SIGN_UP', 'SHOP_NOW', 'GET_QUOTE', 'DOWNLOAD', 'SUBSCRIBE', 'APPLY_NOW'],
          description: 'Call-to-action button matching what the landing page offers.',
        },
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
  verb({
    limb: 'geo',
    verb: 'brand_audit',
    name: 'geo.brand_audit',
    description:
      'Audit how visible the brand is across AI answer engines (ChatGPT, Gemini, Claude, Perplexity) using buyer-intent prompts you generate from the Goal and research. Returns overall Visibility Score, engine breakdown, cited URLs (e.g. Reddit threads), a Document of Information (crawlability, llms.txt, FAQ JSON-LD, comparison briefs, organic threads), and Decision Proposals (e.g. Reddit campaign).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['brandName', 'domain', 'prompts'],
      properties: {
        brandName: { type: 'string', minLength: 1, maxLength: 120 },
        domain: { type: 'string', minLength: 3, maxLength: 256 },
        competitors: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 120 },
          description: 'Up to 8 competitor brands to compare share-of-AI-voice against.',
        },
        prompts: {
          type: 'array',
          minItems: 1,
          maxItems: 15,
          items: { type: 'string', minLength: 3, maxLength: 300 },
          description: 'Buyer-intent prompts (e.g. "best X for Y", "Brand vs Competitor") to test across AI engines.',
        },
        engines: {
          type: 'array',
          maxItems: 4,
          items: { type: 'string', enum: ['chatgpt', 'gemini', 'claude', 'perplexity'] },
        },
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
