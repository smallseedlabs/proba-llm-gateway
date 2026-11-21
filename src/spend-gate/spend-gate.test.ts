import { describe, expect, it } from 'vitest';
import { evaluateSpendGate } from './index.js';

describe('H3-04 paid-action spend gate', () => {
  it('denies media generation when usable site/OG image exists without override justification', () => {
    const denied = evaluateSpendGate({
      goalId: 'g1',
      actionType: 'media_generate',
      estimatedCostUsd: 0.08,
      justification: 'no_usable_site_image',
      evidence: 'Site has og:image',
      hasUsableExistingImage: true,
    });
    expect(denied).toMatchObject({ allowed: false, code: 'spend_gate_denied' });
  });

  it('allows media generation for all 4 valid justifications and logs paidAction', () => {
    const cases = [
      { justification: 'no_usable_site_image' as const, hasUsableExistingImage: false },
      { justification: 'format_mismatch' as const, hasUsableExistingImage: true },
      { justification: 'existing_asset_rejected_quality' as const, hasUsableExistingImage: true },
      { justification: 'user_requested' as const, hasUsableExistingImage: true },
    ];

    for (const c of cases) {
      const res = evaluateSpendGate({
        goalId: 'g1',
        actionType: 'media_generate',
        estimatedCostUsd: 0.08,
        justification: c.justification,
        evidence: 'Checker/research evidence',
        hasUsableExistingImage: c.hasUsableExistingImage,
      });
      expect(res.allowed).toBe(true);
      if (res.allowed) {
        expect(res.paidAction.justification).toBe(c.justification);
        expect(res.paidAction.estimatedCostUsd).toBe(0.08);
      }
    }
  });
});
