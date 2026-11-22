import { describe, expect, it, vi } from 'vitest';
import { VERB_CATALOG } from './catalog.js';
import { DomainLimbExecutor } from './dispatcher.js';
import { evaluateCampaignPlan, validateAgainstPlannerBounds } from './planner-bounds.js';

describe('H2-03 ads.plan and planner bounds enforcement', () => {
  it('computes deterministic plan with clamps', () => {
    const res = evaluateCampaignPlan(
      {
        totalBudget: 100,
        currency: 'GBP',
        platforms: ['reddit'],
        geolocations: ['GB'],
        requestedCells: 4,
      },
      25
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.cells).toBe(2);
      expect(res.plan.clamps.some((c) => c.field === 'cells')).toBe(true);
    }
  });

  it('refuses ads.create_campaign when dailyBudget or platform exceeds PlannerResult without calling ads.execute', async () => {
    const execute = vi.fn();
    const dispatcher = new DomainLimbExecutor({ execute } as never);

    const planVerb = VERB_CATALOG.find((v) => v.name === 'ads.plan')!;
    const createVerb = VERB_CATALOG.find((v) => v.name === 'ads.create_campaign')!;
    expect(planVerb).toBeDefined();
    expect(planVerb.sideEffecting).toBe(false);
    expect(planVerb.requiresApproval).toBe(false);

    const ctx = {
      traceId: 'trace-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      goalId: 'g-1',
      threadId: 't-1',
      approval: {
        status: 'granted',
        approvalId: 'app-1',
        approvedBy: 'u-1',
        approvedAt: '2026-11-21T20:00:00Z',
      },
      domainState: {} as Record<string, unknown>,
    };

    const planOut = await dispatcher.execute(
      {
        callId: 'call-plan-1',
        verb: planVerb,
        args: {
          totalBudget: 100,
          currency: 'GBP',
          durationDays: 7,
          platforms: ['reddit'],
          geolocations: ['GB'],
        },
        idempotencyKey: 'idem-plan-1',
      },
      ctx as never
    );
    expect(planOut.ok).toBe(true);
    expect(ctx.domainState.lastPlannerResult).toBeDefined();

    const badBudget = await dispatcher.execute(
      {
        callId: 'call-create-1',
        verb: createVerb,
        args: {
          name: 'Over Budget',
          landingPageUrl: 'https://example.com',
          dailyBudget: 99,
          currency: 'GBP',
          platform: 'reddit',
        },
        idempotencyKey: 'idem-create-1',
      },
      ctx as never
    );
    expect(badBudget).toMatchObject({ ok: false, code: 'planner_bounds_exceeded' });

    const badPlatform = validateAgainstPlannerBounds(
      { dailyBudget: 10, platform: 'meta' },
      ctx.domainState.lastPlannerResult as never
    );
    expect(badPlatform).toMatchObject({ ok: false, code: 'planner_bounds_exceeded' });
    expect(execute).not.toHaveBeenCalled();
  });
});
