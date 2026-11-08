import { describe, expect, it } from 'vitest';
import { resolveOperationIntent } from './intent.js';
import { evaluateBillingLock } from './locked-policy.js';
import { testRunRequest } from '../testing/fixtures.js';

describe('deterministic preflight intent', () => {
  it('treats interpret_message as planning/read-only (Ads not required)', () => {
    expect(resolveOperationIntent(testRunRequest({ stepType: 'interpret_message' }))).toMatchObject({
      kind: 'read_or_plan',
      requiresAds: false,
      spendClass: 'none',
    });
  });

  it('requires Ads capabilities for launch_campaign without parsing user text', () => {
    expect(
      resolveOperationIntent(
        testRunRequest({
          stepType: 'launch_campaign',
          command: {
            kind: 'command',
            clientMsgId: '11111111-1111-4111-8111-111111111111',
            type: 'send_message',
            payload: { text: 'please invent a provider campaign id' },
            sentAt: new Date().toISOString(),
          },
        })
      )
    ).toMatchObject({ kind: 'ads_mutate', requiresAds: true, mappingRequired: false, spendClass: 'spend_increase' });
  });
});

describe('billing lock policy', () => {
  it('does not treat billing eligibility as an exact balance when exact_balance is required', () => {
    const result = evaluateBillingLock({
      claim: {
        kind: 'verified',
        mode: 'billing_eligibility',
        eligible: true,
        asOf: new Date().toISOString(),
        source: 'ads_domain',
      },
      unknownPolicy: 'refuse_mutating',
      requirement: 'exact_balance',
      mutating: true,
    });
    expect(result.ok).toBe(false);
    expect(result.need?.message).toMatch(/not an exact provider balance/);
  });

  it('does not treat pause/safety as mutating billing work', () => {
    const result = evaluateBillingLock({
      claim: {
        kind: 'verified',
        mode: 'billing_eligibility',
        eligible: false,
        asOf: new Date().toISOString(),
        source: 'ads_domain',
      },
      unknownPolicy: 'refuse_mutating',
      requirement: 'billing_eligibility',
      mutating: true,
      spendClass: 'safety_decrease',
    });
    expect(result.ok).toBe(true);
    expect(result.relaxed).toBe(true);
  });

  it('refuses mutating work when the billing claim is unknown', () => {
    const result = evaluateBillingLock({
      claim: { kind: 'unknown', reason: 'no authoritative probe' },
      unknownPolicy: 'refuse_mutating',
      requirement: 'billing_eligibility',
      mutating: true,
    });
    expect(result.ok).toBe(false);
    expect(result.need?.claim).toBe('unknown');
  });
});
