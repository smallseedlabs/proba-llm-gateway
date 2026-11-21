export type PaidActionJustification =
  | 'no_usable_site_image'
  | 'format_mismatch'
  | 'existing_asset_rejected_quality'
  | 'user_requested';

export interface SpendGateInput {
  goalId: string;
  actionType: 'media_generate' | 'research_paid' | 'llm_call';
  estimatedCostUsd: number;
  justification?: PaidActionJustification;
  evidence?: string;
  hasUsableExistingImage: boolean;
}

export interface PaidActionRecord {
  goalId: string;
  actionType: 'media_generate' | 'research_paid' | 'llm_call';
  estimatedCostUsd: number;
  justification: PaidActionJustification;
  evidence: string;
  decidedAt: string;
}

export type SpendGateDecision =
  | { allowed: true; paidAction: PaidActionRecord }
  | { allowed: false; code: 'spend_gate_denied'; reason: string };

const VALID_JUSTIFICATIONS = new Set<PaidActionJustification>([
  'no_usable_site_image',
  'format_mismatch',
  'existing_asset_rejected_quality',
  'user_requested',
]);

export function evaluateSpendGate(
  input: SpendGateInput,
  now: Date = new Date()
): SpendGateDecision {
  const { justification, evidence, hasUsableExistingImage } = input;

  if (!justification || !VALID_JUSTIFICATIONS.has(justification)) {
    return {
      allowed: false,
      code: 'spend_gate_denied',
      reason: 'Paid action requires one of the 4 valid justifications.',
    };
  }

  if (!evidence || evidence.trim().length === 0) {
    return {
      allowed: false,
      code: 'spend_gate_denied',
      reason: 'Paid action requires non-empty evidence.',
    };
  }

  if (
    input.actionType === 'media_generate' &&
    hasUsableExistingImage &&
    justification === 'no_usable_site_image'
  ) {
    return {
      allowed: false,
      code: 'spend_gate_denied',
      reason: 'Usable site/OG image already exists; media generation denied without format_mismatch, quality rejection, or user request.',
    };
  }

  return {
    allowed: true,
    paidAction: {
      goalId: input.goalId,
      actionType: input.actionType,
      estimatedCostUsd: Math.max(0, input.estimatedCostUsd),
      justification,
      evidence: evidence.trim(),
      decidedAt: now.toISOString(),
    },
  };
}
