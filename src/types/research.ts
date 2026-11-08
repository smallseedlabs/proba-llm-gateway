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

export const userSuppliedInputSchema = z
  .object({
    landingPageUrl: z.string().min(1).max(2048),
  })
  .strict();
export type UserSuppliedInput = z.infer<typeof userSuppliedInputSchema>;
