import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { verbByName } from '../limbs/catalog.js';
import { testRunRequest } from '../testing/fixtures.js';
import { fakeActionPolicy, FAKE_POLICY_CAMPAIGN } from '../testing/action-policy.js';
import { assertPublishable, evaluateActionPolicy, selectDocument } from './evaluate.js';
import { MemoryActionPolicyStore } from './memory-store.js';

function pauseVerb() {
  const verb = verbByName('ads.pause_campaign');
  if (!verb) throw new Error('missing pause');
  return verb;
}

function createVerb() {
  const verb = verbByName('ads.create_campaign');
  if (!verb) throw new Error('missing create');
  return verb;
}

describe('owner action policies', () => {
  it('defaults ads verbs to Hub approval and never grants spend', () => {
    const result = evaluateActionPolicy({
      verb: pauseVerb(),
      args: { probaCampaignId: FAKE_POLICY_CAMPAIGN },
      request: testRunRequest(),
      documents: [],
      now: new Date(),
    });
    expect(result.mode).toBe('approval');
    expect(result.requiresHubApproval).toBe(true);
    expect(result.grantsSpend).toBe(false);
    expect(result.immutable.runBudget).toBe(true);
  });

  it('auto-with-limits pause matches owner scope and still does not grant spend', () => {
    const result = evaluateActionPolicy({
      verb: pauseVerb(),
      args: { probaCampaignId: FAKE_POLICY_CAMPAIGN, platform: 'reddit' },
      request: testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          type: 'send_message',
          payload: { text: 'pause', probaCampaignId: FAKE_POLICY_CAMPAIGN, platform: 'reddit' },
          sentAt: new Date().toISOString(),
        },
      }),
      documents: [fakeActionPolicy()],
      now: new Date(),
    });
    expect(result.mode).toBe('auto_with_limits');
    expect(result.requiresHubApproval).toBe(false);
    expect(result.grantsSpend).toBe(false);
  });

  it('auto-with-limits cap decrease uses Hub currentDailyBudget and still does not grant spend', () => {
    const verb = verbByName('ads.update_campaign');
    if (!verb) throw new Error('missing update');
    const result = evaluateActionPolicy({
      verb,
      args: { probaCampaignId: FAKE_POLICY_CAMPAIGN, dailyBudget: 8 },
      request: testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
          type: 'send_message',
          payload: {
            text: 'cap down',
            probaCampaignId: FAKE_POLICY_CAMPAIGN,
            platform: 'reddit',
            currentDailyBudget: 10,
          },
          sentAt: new Date().toISOString(),
        },
      }),
      documents: [fakeActionPolicy({ policyId: 'policy-cap-auto', verb: 'ads.update_campaign' })],
      now: new Date(),
    });
    expect(result.mode).toBe('auto_with_limits');
    expect(result.requiresHubApproval).toBe(false);
    expect(result.grantsSpend).toBe(false);
  });

  it('clamps auto update without known current, increases, and URL edits to Hub approval', () => {
    const verb = verbByName('ads.update_campaign');
    if (!verb) throw new Error('missing update');
    const policy = fakeActionPolicy({ policyId: 'policy-cap-auto', verb: 'ads.update_campaign' });
    const request = testRunRequest({
      command: {
        kind: 'command',
        clientMsgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        type: 'send_message',
        payload: { text: 'cap', probaCampaignId: FAKE_POLICY_CAMPAIGN, platform: 'reddit' },
        sentAt: new Date().toISOString(),
      },
    });
    const unknown = evaluateActionPolicy({
      verb,
      args: { probaCampaignId: FAKE_POLICY_CAMPAIGN, dailyBudget: 8 },
      request,
      documents: [policy],
      now: new Date(),
    });
    expect(unknown.mode).toBe('approval');
    expect(unknown.clampedFromAuto).toBe(true);
    expect(unknown.gate?.code).toBe('proposal_bounds');

    const increase = evaluateActionPolicy({
      verb,
      args: { probaCampaignId: FAKE_POLICY_CAMPAIGN, dailyBudget: 20 },
      request: testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
          type: 'send_message',
          payload: {
            text: 'cap up',
            probaCampaignId: FAKE_POLICY_CAMPAIGN,
            platform: 'reddit',
            currentDailyBudget: 10,
          },
          sentAt: new Date().toISOString(),
        },
      }),
      documents: [policy],
      now: new Date(),
    });
    expect(increase.mode).toBe('approval');
    expect(increase.clampedFromAuto).toBe(true);
    expect(increase.grantsSpend).toBe(false);

    const urlEdit = evaluateActionPolicy({
      verb,
      args: { probaCampaignId: FAKE_POLICY_CAMPAIGN, dailyBudget: 8, landingPageUrl: 'https://evil.example/x' },
      request: testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
          type: 'send_message',
          payload: {
            text: 'url',
            probaCampaignId: FAKE_POLICY_CAMPAIGN,
            platform: 'reddit',
            currentDailyBudget: 10,
          },
          sentAt: new Date().toISOString(),
        },
      }),
      documents: [policy],
      now: new Date(),
    });
    expect(urlEdit.mode).toBe('approval');
    expect(urlEdit.requiresHubApproval).toBe(true);
  });

  it('clamps auto_with_limits on create_campaign to approval (cannot grant spend)', () => {
    const rogue = fakeActionPolicy({ verb: 'ads.create_campaign', mode: 'auto_with_limits', scope: { platform: 'reddit' } });
    const result = evaluateActionPolicy({
      verb: createVerb(),
      args: { dailyBudget: 10, platform: 'reddit' },
      request: testRunRequest(),
      documents: [rogue],
      now: new Date(),
    });
    expect(result.mode).toBe('approval');
    expect(result.clampedFromAuto).toBe(true);
    expect(result.requiresHubApproval).toBe(true);
    expect(result.grantsSpend).toBe(false);
  });

  it('refuses cross-provider movement as a side effect', () => {
    const verb = verbByName('ads.update_campaign');
    if (!verb) throw new Error('missing update');
    const result = evaluateActionPolicy({
      verb,
      args: { probaCampaignId: FAKE_POLICY_CAMPAIGN, fromPlatform: 'reddit', toPlatform: 'google' },
      request: testRunRequest(),
      documents: [],
      now: new Date(),
    });
    expect(result.mode).toBe('deny');
    expect(result.gate?.code).toBe('cross_provider_move');
    expect(result.grantsSpend).toBe(false);
  });

  it('ignores another workspace or actor document (no delegation)', () => {
    const docs = [fakeActionPolicy({ workspaceId: 'other-ws' }), fakeActionPolicy({ ownerUserId: '22222222-2222-4222-8222-222222222222' })];
    expect(
      selectDocument(docs, testRunRequest(), 'ads.pause_campaign', { probaCampaignId: FAKE_POLICY_CAMPAIGN, platform: 'reddit' })
    ).toBeUndefined();
  });

  it('owner deny mode refuses the verb without granting spend', () => {
    const result = evaluateActionPolicy({
      verb: pauseVerb(),
      args: { probaCampaignId: FAKE_POLICY_CAMPAIGN, platform: 'reddit' },
      request: testRunRequest({
        command: {
          kind: 'command',
          clientMsgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
          type: 'send_message',
          payload: { text: 'pause', probaCampaignId: FAKE_POLICY_CAMPAIGN, platform: 'reddit' },
          sentAt: new Date().toISOString(),
        },
      }),
      documents: [fakeActionPolicy({ mode: 'deny' })],
      now: new Date(),
    });
    expect(result.mode).toBe('deny');
    expect(result.gate?.code).toBe('policy_deny');
    expect(result.grantsSpend).toBe(false);
  });

  it('refuses publishing delegation or auto spend-increase', () => {
    expect(() => assertPublishable(fakeActionPolicy({ delegationEnabled: true as unknown as false }))).toThrow(ConfigError);
    expect(() => assertPublishable(fakeActionPolicy({ allowCrossProviderMove: true as unknown as false }))).toThrow(ConfigError);
    expect(() => assertPublishable(fakeActionPolicy({ verb: 'ads.create_campaign' }))).toThrow(/spend-increase/);
    expect(() => new MemoryActionPolicyStore('production')).toThrow(ConfigError);
  });
});
