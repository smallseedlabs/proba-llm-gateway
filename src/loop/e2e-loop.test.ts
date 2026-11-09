/**
 * Isolated end-to-end loop through the REAL gateway coordinator, policy,
 * research acceptance, analytics evaluator, approved-action executor and
 * action-policy code. Everything paid or external is a labelled double:
 *
 * | Piece                      | Real or fake                                         |
 * | -------------------------- | ---------------------------------------------------- |
 * | Gateway loop/policy/gates  | REAL (this repo)                                     |
 * | Model turns                | FAKE  ScriptedLlmClient (no paid completion)         |
 * | Research provider          | FAKE  SourcedResearchProvider (no network)           |
 * | Context packet / metrics   | FAKE  in-process analytics context fixture           |
 * | Ads domain                 | TEST STUB RecordingAdsDomain (no Reddit call)        |
 * | Hub / Web                  | simulated by the request sequence below              |
 *
 * portal input (user URL + approved creative) -> research -> acceptance ->
 * campaign create -> metrics -> analytics proposal -> owner approval -> action.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LoopCoordinator } from './coordinator.js';
import { CatalogPolicyEngine } from '../limbs/policy.js';
import { DomainLimbExecutor } from '../limbs/dispatcher.js';
import { FailClosedApprovalGate } from '../adapters/fail-closed-approval.js';
import { MemoryRunStore } from '../adapters/memory-run-store.js';
import { SystemClock } from '../adapters/system-clock.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { testConfig } from '../testing/config.js';
import { RecordingAdsDomain, ScriptedContextPort, ScriptedLlmClient } from '../testing/doubles.js';
import { testCaller, testRunRequest, testToolTurn, testTurn } from '../testing/fixtures.js';
import { MemoryResearchStore } from '../research/memory-store.js';
import { MemoryAnalyticsStore } from '../analytics/memory-store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from '../action-policy/memory-store.js';
import { SourcedResearchProvider, TEST_LANDING_URL, userLanding } from '../testing/research.js';
import { fakeAnalyticsPacket, FAKE_ACCOUNT, FAKE_ANALYTICS_LABEL } from '../testing/analytics.js';

describe('isolated end-to-end loop (fakes for every paid/provider/model call)', () => {
  it('portal input -> research -> acceptance -> create -> metrics -> proposal -> approved pause', async () => {
    expect(FAKE_ANALYTICS_LABEL).toMatch(/^FAKE/);
    const clock = new SystemClock();
    const ads = new RecordingAdsDomain();
    const research = new SourcedResearchProvider();
    const researchStore = new MemoryResearchStore('test');
    const audit = new MemoryAuditPublisher();
    const createdCampaign = 'proba-camp-1'; // returned by the TEST STUB Ads create
    const llm = new ScriptedLlmClient([
      testToolTurn('research.gather', { url: TEST_LANDING_URL }),
      testToolTurn(
        'ads.create_campaign',
        { name: 'Launch', landingPageUrl: TEST_LANDING_URL, dailyBudget: 10, currency: 'USD', platform: 'reddit' },
        'call-create'
      ),
      testTurn({ message: { role: 'assistant', content: 'campaign created' } }),
    ]);
    const context = new ScriptedContextPort(
      fakeAnalyticsPacket({ data: { probaCampaignId: createdCampaign } })
    );
    const coordinator = new LoopCoordinator({
      config: testConfig(),
      clock,
      audit,
      runs: new MemoryRunStore('test'),
      llm,
      context,
      policy: new CatalogPolicyEngine(),
      approval: new FailClosedApprovalGate(),
      tools: new DomainLimbExecutor(ads, { provider: research, store: researchStore, clock }),
      ads,
      researchStore,
      analyticsStore: new MemoryAnalyticsStore('test'),
      actionPolicyStore: new MemoryActionPolicyStore('test'),
      actionOutcomeStore: new MemoryActionOutcomeStore('test'),
    });

    // 1. Portal input: operator-entered URL + operator-approved creative (no default URL).
    const key = randomUUID();
    const launch = (resume?: { askId: string; choice: 'approve' }) =>
      testRunRequest({ idempotencyKey: key, userSuppliedInput: userLanding(), ...(resume ? { resume } : {}) });

    // 2. Research gathers sourced findings and pauses for acceptance.
    const gathered = await coordinator.start(launch(), testCaller());
    expect((gathered.needs?.[0] as { verb: string }).verb).toBe('research.accept');
    expect(ads.calls).toHaveLength(0);

    // 3. Owner accepts research; create now waits for its own approval.
    const accepted = await coordinator.start(
      launch({ askId: (gathered.needs?.[0] as { askId: string }).askId, choice: 'approve' }),
      testCaller()
    );
    expect((accepted.needs?.[0] as { verb: string }).verb).toBe('ads.create_campaign');
    expect(ads.calls).toHaveLength(0);

    // 4. Owner approves create; Ads receives creative + accepted research binding.
    const created = await coordinator.start(
      launch({ askId: (accepted.needs?.[0] as { askId: string }).askId, choice: 'approve' }),
      testCaller()
    );
    expect(created.status).toBe('completed');
    expect(ads.calls).toHaveLength(1);
    expect(ads.calls[0]?.args).toMatchObject({
      landingPageUrl: TEST_LANDING_URL,
      creative: { type: 'TEXT' },
      researchAcceptance: { version: 1 },
      researchAttestation: { status: 'accepted' },
    });

    // 5-6. Metrics (FAKE Context) -> deterministic evaluator dry-run proposal.
    const review = await coordinator.start(
      testRunRequest({
        idempotencyKey: randomUUID(),
        stepType: 'review_performance',
        command: {
          kind: 'command',
          clientMsgId: randomUUID(),
          type: 'send_message',
          payload: {
            text: 'scheduled review',
            probaCampaignId: createdCampaign,
            platform: 'reddit',
            accountId: FAKE_ACCOUNT,
            reviewIntent: 'propose_pause',
          },
          sentAt: new Date().toISOString(),
        },
      }),
      testCaller()
    );
    const analytics = review.analytics as {
      decisionId: string;
      proposal: { verb: string; args: Record<string, unknown>; argsHash: string };
    };
    expect(analytics.proposal.verb).toBe('ads.pause_campaign');
    expect(ads.calls).toHaveLength(1);

    // 7. Owner approves the proposal in the review UI -> Hub -> gateway -> Ads.
    const proposalId = randomUUID();
    const acted = await coordinator.start(
      testRunRequest({
        idempotencyKey: randomUUID(),
        stepType: 'handle_approval',
        command: {
          kind: 'command',
          clientMsgId: randomUUID(),
          type: 'send_message',
          payload: {
            text: 'approve proposal',
            analyticsAction: {
              proposalId,
              decisionId: analytics.decisionId,
              ...analytics.proposal,
              probaCampaignId: createdCampaign,
              platform: 'reddit',
              accountId: FAKE_ACCOUNT,
            },
          },
          sentAt: new Date().toISOString(),
        },
        resume: { askId: proposalId, choice: 'approve' },
      }),
      testCaller()
    );
    expect(acted.status).toBe('completed');
    expect(ads.calls).toHaveLength(2);
    expect(ads.calls[1]).toMatchObject({ verb: 'ads.pause_campaign', args: { probaCampaignId: createdCampaign } });

    // Audit trail covers every decision, action and outcome; nothing grants spend.
    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain('approval.requested');
    expect(actions).toContain('brain.decision_made');
    expect(actions.filter((a) => a === 'tool.executed').length).toBeGreaterThanOrEqual(3);
    expect(audit.events.some((e) => e.details?.grantsSpend === true)).toBe(false);
  });
});
