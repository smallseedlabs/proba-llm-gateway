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
