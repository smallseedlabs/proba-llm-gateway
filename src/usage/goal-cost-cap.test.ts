import { describe, expect, it } from 'vitest';
import { DEFAULT_GOAL_WEEK_COST_CAP_USD, GoalCostLedger } from './goal-cost-cap.js';

describe('H3-07 per-goal model and media cost cap', () => {
  it('allows spend under cap and denies paid actions above cap with a clear reason', () => {
    const ledger = new GoalCostLedger(DEFAULT_GOAL_WEEK_COST_CAP_USD);
    expect(ledger.canSpend('g1', 4.0)).toMatchObject({ allowed: true });
    ledger.recordSpend('g1', 4.0);

    const over = ledger.canSpend('g1', 3.0);
    expect(over).toMatchObject({ allowed: false, code: 'goal_cost_cap_exceeded' });

    // Free paths (0 cost) remain allowed
    expect(ledger.canSpend('g1', 0)).toMatchObject({ allowed: true });
  });
});
