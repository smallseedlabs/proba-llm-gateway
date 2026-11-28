export const DEFAULT_GOAL_WEEK_COST_CAP_USD = 6.5;

export class GoalCostLedger {
  private readonly spentByGoal = new Map<string, number>();
  private readonly hydratedGoals = new Set<string>();

  constructor(private readonly capUsd: number = DEFAULT_GOAL_WEEK_COST_CAP_USD) {}

  isHydrated(goalId: string): boolean {
    return this.hydratedGoals.has(goalId);
  }

  hydrate(goalId: string, persistedUsd: number): void {
    if (this.hydratedGoals.has(goalId)) return;
    this.hydratedGoals.add(goalId);
    const current = this.getSpent(goalId);
    this.spentByGoal.set(goalId, Number((current + Math.max(0, persistedUsd)).toFixed(4)));
  }

  getSpent(goalId: string): number {
    return this.spentByGoal.get(goalId) ?? 0;
  }

  canSpend(
    goalId: string,
    estimatedCostUsd: number
  ): { allowed: true; remainingUsd: number } | { allowed: false; code: 'goal_cost_cap_exceeded'; reason: string } {
    const current = this.getSpent(goalId);
    const next = current + Math.max(0, estimatedCostUsd);
    if (next > this.capUsd) {
      return {
        allowed: false,
        code: 'goal_cost_cap_exceeded',
        reason: `Per-goal model/media cost (${next.toFixed(2)} USD) exceeds cap (${this.capUsd.toFixed(2)} USD); continuing on free paths only.`,
      };
    }
    return { allowed: true, remainingUsd: Number((this.capUsd - next).toFixed(4)) };
  }

  recordSpend(goalId: string, costUsd: number): number {
    const next = Number((this.getSpent(goalId) + Math.max(0, costUsd)).toFixed(4));
    this.spentByGoal.set(goalId, next);
    return next;
  }
}
