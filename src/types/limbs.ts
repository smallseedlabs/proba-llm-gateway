import { z } from 'zod';

/**
 * Fixed-code limbs and verbs. Provider/domain HTTP adapters are a separate
 * layer and are not registered in this slice (Reddit/Microsoft first, Google
 * later, Meta last — none of those adapters ship here). The LLM never executes
 * these verbs.
 *
 * First marketing supports a user-provided page URL. Page generation is later
 * and the verb is catalogued but not allowlisted.
 */
export const LIMB_IDS = ['page', 'ads', 'analytics', 'research'] as const;
export type LimbId = (typeof LIMB_IDS)[number];

export const AD_PLATFORMS = ['reddit', 'microsoft', 'google', 'meta'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/** Platforms whose adapters may be written first, when authorized. None are present now. */
export const FIRST_AD_PLATFORMS: readonly AdPlatform[] = ['reddit', 'microsoft'];
export const LATER_AD_PLATFORMS: readonly AdPlatform[] = ['google'];
export const LAST_AD_PLATFORMS: readonly AdPlatform[] = ['meta'];

export const VERB_RISK = ['low', 'medium', 'high'] as const;
export type VerbRisk = (typeof VERB_RISK)[number];

export const verbDefinitionSchema = z
  .object({
    limb: z.enum(LIMB_IDS),
    verb: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    description: z.string().max(4096),
    /** JSON Schema for arguments. Validated before any adapter is considered. */
    parameters: z.record(z.string(), z.unknown()),
    risk: z.enum(VERB_RISK),
    sideEffecting: z.boolean(),
    requiresApproval: z.boolean(),
    /**
     * When false the policy allowlist denies the verb. Adapters must not exist
     * for denied verbs in this slice.
     */
    allowlisted: z.boolean(),
    platforms: z.array(z.enum(AD_PLATFORMS)).optional(),
  })
  .strict();

export type VerbDefinition = z.infer<typeof verbDefinitionSchema>;
