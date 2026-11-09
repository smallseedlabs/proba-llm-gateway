import { describe, expect, it } from 'vitest';
import { CatalogPolicyEngine } from './policy.js';
import { VERB_CATALOG } from './catalog.js';
import { RefusingLimbExecutor } from '../adapters/refusing-tools.js';
import { ToolRefusedError } from '../errors.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { DomainLimbExecutor } from './dispatcher.js';
import { UnconfiguredAdsDomain } from '../domains/ads/unconfigured.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { UnconfiguredResearchProvider } from '../research/unconfigured.js';
import { SystemClock } from '../adapters/system-clock.js';
import { seedAcceptedResearch } from '../testing/research.js';

const ctx = {
  workspaceId: 'seedbed',
  userId: '11111111-1111-4111-8111-111111111111',
  userSuppliedInput: {
    landingPageUrl: 'https://example.com/offer',
    creative: { type: 'TEXT', headline: 'FAKE headline', body: 'FAKE approved body' },
  },
};

const createArgs = {
  name: 'Spring',
  landingPageUrl: 'https://example.com/offer',
  dailyBudget: 10,
  currency: 'USD',
  platform: 'reddit',
};

describe('limb policy and domain executor', () => {
  const policy = new CatalogPolicyEngine();

  it('allowlists page attach and Ads verbs on Proba ids; generation and analytics stay denied', () => {
    expect(policy.evaluate('page.attach_user_page', { url: 'https://example.com/offer' }, ctx).allowed).toBe(true);
    expect(policy.evaluate('page.generate_page', {}, ctx)).toMatchObject({ allowed: false, code: 'allowlist' });
    expect(policy.evaluate('analytics.compare_metrics', {}, ctx)).toMatchObject({ allowed: false, code: 'allowlist' });
    expect(policy.evaluate('ads.create_campaign', createArgs, ctx).allowed).toBe(true);
    expect(policy.evaluate('research.gather', { url: createArgs.landingPageUrl }, ctx).allowed).toBe(true);
    expect(policy.evaluate('research.accept', { artifactId: 'x', version: 1, inputRevision: 'y' }, ctx)).toMatchObject({
      allowed: false,
      code: 'allowlist',
    });
    expect(
      policy.evaluate('ads.create_campaign', { ...createArgs, landingPageUrl: 'https://evil.example/x' }, ctx)
    ).toMatchObject({ allowed: false, code: 'user_input' });
    expect(policy.evaluate('ads.create_campaign', createArgs, { workspaceId: 'seedbed', userId: ctx.userId })).toMatchObject({
      allowed: false,
      code: 'user_input',
    });
    expect(policy.evaluate('ads.update_campaign', { probaCampaignId: 'proba-1' }, ctx).allowed).toBe(true);
    expect(policy.evaluate('ads.propose_campaign', { platform: 'reddit' }, ctx)).toMatchObject({
      allowed: false,
      code: 'unknown_verb',
    });
    expect(VERB_CATALOG.filter((v) => v.limb === 'ads' && v.allowlisted).map((v) => v.verb)).toEqual([
      'create_campaign',
      'update_campaign',
      'pause_campaign',
      'resume_campaign',
    ]);
  });

  it('catalogues ads.move_budget but does not allowlist cross-provider movement', () => {
    expect(VERB_CATALOG.some((v) => v.name === 'ads.move_budget' && v.allowlisted === false)).toBe(true);
    expect(
      policy.evaluate('ads.move_budget', { fromPlatform: 'reddit', toPlatform: 'google', amount: 5 }, ctx)
    ).toMatchObject({ allowed: false, code: 'allowlist' });
  });

  it('rejects unknown verbs, extra provider ids, and malformed arguments', () => {
    expect(policy.evaluate('not.a.verb', {}, ctx)).toMatchObject({ allowed: false, code: 'unknown_verb' });
    expect(policy.evaluate('page.attach_user_page', {}, ctx)).toMatchObject({ allowed: false, code: 'schema' });
    expect(
      policy.evaluate('ads.update_campaign', { probaCampaignId: 'p1', providerCampaignId: 'invented' }, ctx)
    ).toMatchObject({ allowed: false, code: 'schema' });
  });

  it('never returns a successful tool result from the refusing executor', async () => {
    const executor = new RefusingLimbExecutor();
    const verb = VERB_CATALOG.find((v) => v.name === 'page.attach_user_page');
    if (!verb) throw new Error('catalog missing attach_user_page');
    await expect(
      executor.execute(
        { callId: 'c1', verb, args: { url: 'https://example.com' }, idempotencyKey: '11111111-1111-4111-8111-111111111111' },
        {
          workspaceId: 'seedbed',
          userId: ctx.userId,
          traceId: '11111111-1111-4111-8111-111111111111',
          signal: new AbortController().signal,
          approval: { status: 'pending' },
          domainState: {},
        }
      )
    ).rejects.toBeInstanceOf(ToolRefusedError);
  });

  it('fails closed when Ads is unconfigured rather than fabricating success', async () => {
    const store = new MemoryResearchStore('test');
    await seedAcceptedResearch(store);
    const executor = new DomainLimbExecutor(new UnconfiguredAdsDomain(), {
      provider: new UnconfiguredResearchProvider(),
      store,
      clock: new SystemClock(),
    });
    const verb = VERB_CATALOG.find((v) => v.name === 'ads.create_campaign');
    if (!verb) throw new Error('catalog missing create_campaign');
    await expect(
      executor.execute(
        { callId: 'c1', verb, args: createArgs, idempotencyKey: '11111111-1111-4111-8111-111111111111' },
        {
          workspaceId: 'seedbed',
          userId: ctx.userId,
          goalId: '11111111-1111-4111-8111-111111111113',
          threadId: '11111111-1111-4111-8111-111111111114',
          traceId: '11111111-1111-4111-8111-111111111111',
          signal: new AbortController().signal,
          approval: {
            status: 'granted',
            resume: { askId: '11111111-1111-4111-8111-111111111111', choice: 'approve' },
          },
          domainState: {},
        }
      )
    ).rejects.toMatchObject({ code: 'tool_refused' });
  });

  it('does not treat a missing Hub resume as approval', () => {
    const gate = new FailClosedApprovalGate();
    const verb = VERB_CATALOG.find((v) => v.name === 'page.attach_user_page');
    if (!verb) throw new Error('catalog missing attach_user_page');
    const intent = {
      askId: '11111111-1111-4111-8111-111111111111',
      runId: '11111111-1111-4111-8111-111111111112',
      workspaceId: 'seedbed',
      verb,
      args: { url: 'https://x' },
      argsHash: 'nope',
      risk: 'medium' as const,
    };
    expect(gate.decide(intent)).toEqual({ status: 'pending' });
    expect(gate.decide(intent, { askId: intent.askId, choice: 'approve' })).toEqual({ status: 'pending' });
  });

  it('injects only operator-approved creative/targeting on create; the model cannot author creative', () => {
    const allowed = policy.evaluate('ads.create_campaign', createArgs, {
      ...ctx,
      userSuppliedInput: { ...ctx.userSuppliedInput, targeting: { communities: ['FAKEsub'] } },
    });
    expect(allowed).toMatchObject({
      allowed: true,
      args: {
        creative: { type: 'TEXT', headline: 'FAKE headline', body: 'FAKE approved body' },
        targeting: { communities: ['FAKEsub'] },
      },
    });
    expect(
      policy.evaluate('ads.create_campaign', { ...createArgs, creative: { type: 'TEXT', headline: 'x', body: 'y' } }, ctx)
    ).toMatchObject({ allowed: false, code: 'schema' });
    expect(
      policy.evaluate('ads.create_campaign', createArgs, { ...ctx, userSuppliedInput: { landingPageUrl: 'https://example.com/offer' } })
    ).toMatchObject({ allowed: false, code: 'user_input' });
    expect(
      policy.evaluate('ads.create_campaign', createArgs, {
        ...ctx,
        userSuppliedInput: {
          landingPageUrl: 'https://example.com/offer',
          creative: { type: 'IMAGE', headline: 'h', mediaUrl: 'http://127.0.0.1/x.png' },
        },
      })
    ).toMatchObject({ allowed: false, code: 'user_input' });
  });
});
