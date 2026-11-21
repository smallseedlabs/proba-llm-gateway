import { runDeterministicCheck, type CheckerVerdict, type DeterministicCheckInput } from './deterministic.js';

export type LlmCheckerFn = (prompt: {
  system: string;
  artifactJson: string;
}) => Promise<{ approved: boolean; reason: string; field?: string }>;

const CHECKER_SYSTEM_PROMPT =
  'You are an independent ad-safety and brand-accuracy checker. Review ONLY the submitted artifact JSON against platform ad policies, factual accuracy (no invented claims/URLs), and budget bounds. Reject anything misleading, unverified, or off-brief.';

/**
 * Single-pass lean checker (per PR #31 agreement):
 * 1. Deterministic Part A runs first (zero LLM cost).
 * 2. If Part A passes and an independent separate-context LLM checker is provided,
 *    runs a single-pass Part B review with isolated system prompt.
 */
export async function checkArtifact(
  input: DeterministicCheckInput,
  llmChecker?: LlmCheckerFn,
  now: Date = new Date()
): Promise<CheckerVerdict> {
  const partA = runDeterministicCheck(input, now);
  if (!partA.approved) {
    return partA;
  }
  if (!llmChecker) {
    return partA;
  }
  const partB = await llmChecker({
    system: CHECKER_SYSTEM_PROMPT,
    artifactJson: JSON.stringify({
      artifactKind: input.artifactKind,
      userLandingPageUrl: input.userLandingPageUrl,
      plannerBounds: input.plannerBounds,
      payload: input.payload,
    }),
  });
  return {
    approved: partB.approved,
    layer: 'llm_checker',
    reason: partB.reason,
    ...(partB.field ? { field: partB.field } : {}),
    checkedAt: now.toISOString(),
  };
}

export { runDeterministicCheck, type CheckerVerdict, type DeterministicCheckInput };
