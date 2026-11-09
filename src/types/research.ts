import { z } from 'zod';

export const researchArtifactStatusSchema = z.enum(['awaiting_acceptance', 'accepted', 'invalidated', 'failed']);
export type ResearchArtifactStatus = z.infer<typeof researchArtifactStatusSchema>;

export const researchSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    kind: z.literal('http_url'),
    url: z.string().min(1).max(2048),
    fetchedAt: z.string().datetime(),
    contentType: z.string().max(256).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    excerpt: z.string().max(4096).optional(),
  })
  .strict();
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchFindingSchema = z
  .object({
    id: z.string().min(1).max(128),
    text: z.string().min(1).max(2000),
    sourceIds: z.array(z.string().min(1)).min(1).max(16),
  })
  .strict();
export type ResearchFinding = z.infer<typeof researchFindingSchema>;

export const researchAssumptionSchema = z
  .object({
    id: z.string().min(1).max(128),
    text: z.string().min(1).max(2000),
    basis: z.enum(['user_input', 'page_text', 'unverified']),
    sourceIds: z.array(z.string().min(1)).max(16).optional(),
  })
  .strict();
export type ResearchAssumption = z.infer<typeof researchAssumptionSchema>;

export const researchUnknownSchema = z
  .object({
    id: z.string().min(1).max(128),
    text: z.string().min(1).max(2000),
  })
  .strict();
export type ResearchUnknown = z.infer<typeof researchUnknownSchema>;

export const researchArtifactSchema = z
  .object({
    artifactId: z.string().uuid(),
    version: z.number().int().positive(),
    workspaceId: z.string().min(1).max(256),
    userId: z.string().uuid(),
    goalId: z.string().uuid(),
    threadId: z.string().uuid(),
    landingPageUrl: z.string().min(1).max(2048),
    inputRevision: z.string().min(1).max(128),
    status: researchArtifactStatusSchema,
    providerName: z.string().min(1).max(128),
    sources: z.array(researchSourceSchema).max(32),
    findings: z.array(researchFindingSchema).max(32),
    assumptions: z.array(researchAssumptionSchema).max(32),
    unknowns: z.array(researchUnknownSchema).max(32),
    errorCode: z.string().max(64).optional(),
    errorMessage: z.string().max(500).optional(),
    acceptedAt: z.string().datetime().optional(),
    acceptedByAskId: z.string().uuid().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ResearchArtifact = z.infer<typeof researchArtifactSchema>;

/**
 * Operator-approved Reddit creative (copy/media) forwarded by Hub. Ads creates
 * the structured post from this and then uses the returned post id for the ad.
 * Never model-authored: the catalog does not list `creative` as a tool arg.
 */
export const approvedCreativeSchema = z.union([
  z
    .object({
      type: z.literal('TEXT'),
      headline: z.string().min(1).max(300),
      body: z.string().min(1).max(40_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('IMAGE'),
      headline: z.string().min(1).max(300),
      body: z.string().min(1).max(40_000).optional(),
      mediaUrl: z.string().min(1).max(2048),
      callToAction: z.string().min(1).max(64).optional(),
    })
    .strict(),
]);
export type ApprovedCreative = z.infer<typeof approvedCreativeSchema>;

export const userSuppliedInputSchema = z
  .object({
    landingPageUrl: z.string().min(1).max(2048),
    /** Operator-approved copy/media for the Reddit structured post. */
    creative: approvedCreativeSchema.optional(),
    /** Operator-approved targeting (Ads validates the Reddit shape). */
    targeting: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type UserSuppliedInput = z.infer<typeof userSuppliedInputSchema>;
