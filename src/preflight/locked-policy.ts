import type { AdsBillingClaim, BillingRequirement, UnknownBalancePolicy } from '../types/preflight.js';
import type { CapabilityNeed } from '../types/preflight.js';

/**
 * Apply the explicit locked-operation policy to an Ads billing claim.
 * Eligibility is never treated as an exact balance. Unknown/unsupported
 * never invents a number and never becomes `verified`.
 */
export function evaluateBillingLock(input: {
  claim: AdsBillingClaim;
  unknownPolicy: UnknownBalancePolicy;
  requirement: BillingRequirement;
  mutating: boolean;
  spendClass?: 'none' | 'safety_decrease' | 'spend_increase';
}): { ok: boolean; relaxed?: boolean; need?: CapabilityNeed } {
  const { claim, unknownPolicy, requirement, mutating, spendClass } = input;
  if (spendClass === 'none' || spendClass === 'safety_decrease' || !mutating) {
    return { ok: true, relaxed: spendClass === 'safety_decrease' || spendClass === 'none' };
  }
  if (claim.kind === 'not_queried') {
    return {
      ok: false,
      need: {
        type: 'capability',
        capability: 'ads.billing',
        state: 'unknown',
        claim: 'not_queried',
        message: 'provider billing was not queried; mutating Ads work is locked',
      },
    };
  }
  if (claim.kind === 'unavailable') {
    return {
      ok: false,
      need: {
        type: 'capability',
        capability: 'ads.billing',
        state: 'unavailable',
        claim: 'unavailable',
        message: claim.reason,
      },
    };
  }
  if (claim.kind === 'unknown' || claim.kind === 'unsupported') {
    if (unknownPolicy === 'refuse_mutating') {
      return {
        ok: false,
        need: {
          type: 'capability',
          capability: 'ads.billing',
          state: claim.kind === 'unsupported' ? 'missing' : 'unknown',
          claim: claim.kind,
          billingMode: 'none',
          message:
            claim.kind === 'unsupported'
              ? claim.reason
              : `${claim.reason} Locked policy: refuse mutating Ads work when provider balance is not verified.`,
        },
      };
    }
  }
  if (claim.kind === 'verified') {
    if (requirement === 'exact_balance' && claim.mode !== 'exact_balance') {
      return {
        ok: false,
        need: {
          type: 'capability',
          capability: 'ads.billing',
          state: 'insufficient',
          claim: 'verified',
          billingMode: claim.mode,
          message:
            'billing eligibility is not an exact provider balance; this operation requires exact_balance from the Ads domain',
        },
      };
    }
    if (!claim.eligible) {
      return {
        ok: false,
        need: {
          type: 'capability',
          capability: 'ads.billing',
          state: 'insufficient',
          claim: 'verified',
          billingMode: claim.mode,
          message:
            claim.mode === 'exact_balance'
              ? 'authoritative Ads domain reported insufficient provider funds'
              : 'authoritative Ads domain reported the workspace is not billing-eligible',
        },
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    need: {
      type: 'capability',
      capability: 'ads.billing',
      state: 'unknown',
      claim: 'unknown',
      message: 'provider billing claim is not verified; mutating Ads work is locked',
    },
  };
}
