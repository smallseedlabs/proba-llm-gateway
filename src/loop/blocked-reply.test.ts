import { describe, expect, it } from 'vitest';
import type { CapabilityNeed } from '../types/preflight.js';
import { blockedReplyOutputs, blockedReplyText } from './blocked-reply.js';

function need(capability: CapabilityNeed['capability'], message: string): CapabilityNeed {
  return { type: 'capability', capability, state: 'insufficient', message };
}

describe('blockedReplyText', () => {
  it('tells the operator to fund the Reddit Ads wallet when billing blocks the run', () => {
    const text = blockedReplyText([
      need('ads.billing', 'authoritative Ads domain reported the workspace is not billing-eligible'),
    ]);
    expect(text).toBe(
      'Campaign creation is blocked because your Reddit Ads wallet is not funded. Add funds to your Reddit Ads wallet, then press Retry. Nothing was spent.'
    );
    expect(text).not.toMatch(/authoritative Ads domain/);
    expect(blockedReplyOutputs([need('ads.billing', 'x')])).toEqual([{ type: 'reply', text }]);
  });

  it('does not turn a preflight block into a clarify question', () => {
    const text = blockedReplyText([need('ads.connection', 'Reddit ad account is unreachable')]);
    expect(text).toMatch(/Reconnect the account, then press Retry/);
    expect(blockedReplyOutputs([need('ads.connection', 'x')])[0]?.type).toBe('reply');
  });

  it('does not say the wallet is empty when billing is only unknown', () => {
    const text = blockedReplyText([
      {
        type: 'capability',
        capability: 'ads.billing',
        state: 'unknown',
        claim: 'unknown',
        message: 'Locked policy: refuse mutating Ads work when provider balance is not verified.',
      },
    ]);
    expect(text).toMatch(/could not verify billing|not verified/i);
    expect(text).toMatch(/press Retry/);
    expect(text).not.toMatch(/not funded/);
  });

  it('falls back to a plain blocked reply when the capability is unknown', () => {
    expect(blockedReplyText(undefined, 'probaCampaignId is required for this operation')).toBe(
      'This step is blocked: probaCampaignId is required for this operation. Fix that, then press Retry. Nothing was spent.'
    );
  });
});
