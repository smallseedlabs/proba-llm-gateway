export interface PlannerBoundsClamp {
  field: string;
  requested: unknown;
  applied: unknown;
  reason: string;
}

export interface PlannerBoundsPlan {
  totalBudget: number;
  dailyBudget: number;
  currency: string;
  durationDays: number;
  platforms: string[];
  cells: number;
  objective: string;
  optimizationGoal: string;
  creativeFormat: string;
  countries: string[];
  clamps: PlannerBoundsClamp[];
}

export function evaluateCampaignPlan(raw: Record<string, unknown>, maxDailyCap = 500):
  | { ok: true; plan: PlannerBoundsPlan }
  | { ok: false; code: string; message: string } {
  const totalBudget = Number(raw.totalBudget);
  const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : 'USD';
  const durationDays = Math.min(30, Math.max(3, Math.round(Number(raw.durationDays ?? 7))));
  const platforms = Array.isArray(raw.platforms)
    ? raw.platforms.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];
  const countries = Array.isArray(raw.geolocations)
    ? raw.geolocations
        .filter((g): g is string => typeof g === 'string')
        .map((g) => g.trim().toUpperCase())
        .filter((g) => /^[A-Z]{2}$/.test(g))
    : [];

  if (countries.length === 0) {
    return { ok: false, code: 'missing_targeting', message: 'At least one ISO-2 country code is required.' };
  }
  if (platforms.length === 0) {
    return { ok: false, code: 'missing_platform', message: 'At least one platform is required.' };
  }
  if (!Number.isFinite(totalBudget) || totalBudget < 30) {
    return {
      ok: false,
      code: 'budget_below_minimum',
      message: `Total budget ${totalBudget} is below minimum viable test budget (30).`,
    };
  }

  const clamps: PlannerBoundsClamp[] = [];
  let effectivePlatforms = [...platforms];
  if (effectivePlatforms.length > 1 && totalBudget < 100) {
    clamps.push({
      field: 'platforms',
      requested: effectivePlatforms,
      applied: [effectivePlatforms[0]],
      reason: 'Multi-platform requires budget >= 100',
    });
    effectivePlatforms = [effectivePlatforms[0]];
  }

  const maxCells = totalBudget >= 300 ? 4 : totalBudget >= 100 ? 2 : 1;
  const reqCells = typeof raw.requestedCells === 'number' ? Math.floor(raw.requestedCells) : maxCells;
  let cells = maxCells;
  if (reqCells >= 1 && reqCells <= maxCells) {
    cells = reqCells;
  } else if (reqCells > maxCells) {
    clamps.push({
      field: 'cells',
      requested: reqCells,
      applied: maxCells,
      reason: `Budget ${totalBudget} supports at most ${maxCells} cell(s)`,
    });
  }

  const reqDaily =
    typeof raw.requestedDailyBudget === 'number' && raw.requestedDailyBudget > 0
      ? raw.requestedDailyBudget
      : Number((totalBudget / durationDays).toFixed(2));
  let dailyBudget = reqDaily;
  if (dailyBudget > maxDailyCap) {
    clamps.push({
      field: 'dailyBudget',
      requested: dailyBudget,
      applied: maxDailyCap,
      reason: `Clamped to maxDailyCap (${maxDailyCap})`,
    });
    dailyBudget = maxDailyCap;
  }

  const hasPixel = Boolean(raw.hasPixel) && Boolean(raw.pixelVerified);
  const intent = typeof raw.goalIntent === 'string' ? raw.goalIntent : 'traffic';
  let objective = 'OUTCOME_TRAFFIC';
  let optimizationGoal = 'LINK_CLICKS';
  if (intent === 'awareness') {
    objective = 'OUTCOME_AWARENESS';
    optimizationGoal = 'IMPRESSIONS';
  } else if ((intent === 'sales' || intent === 'leads') && hasPixel) {
    if (intent === 'sales' && dailyBudget < 100) {
      objective = 'OUTCOME_TRAFFIC';
      optimizationGoal = 'LANDING_PAGE_VIEWS';
      clamps.push({
        field: 'objective',
        requested: 'OUTCOME_SALES',
        applied: 'OUTCOME_TRAFFIC',
        reason: 'dailyBudget < 100 cannot sustain purchase conversion learning',
      });
    } else {
      objective = intent === 'sales' ? 'OUTCOME_SALES' : 'OUTCOME_LEADS';
      optimizationGoal = 'OFFSITE_CONVERSIONS';
    }
  }

  return {
    ok: true,
    plan: {
      totalBudget,
      dailyBudget,
      currency,
      durationDays,
      platforms: effectivePlatforms,
      cells,
      objective,
      optimizationGoal,
      creativeFormat: typeof raw.creativeFormat === 'string' ? raw.creativeFormat : 'IMAGE',
      countries,
      clamps,
    },
  };
}

export function validateAgainstPlannerBounds(
  args: Record<string, unknown>,
  plan: PlannerBoundsPlan
): { ok: true } | { ok: false; code: 'planner_bounds_exceeded'; message: string } {
  if (typeof args.dailyBudget === 'number' && args.dailyBudget > plan.dailyBudget) {
    return {
      ok: false,
      code: 'planner_bounds_exceeded',
      message: `dailyBudget ${args.dailyBudget} exceeds planner bound ${plan.dailyBudget}`,
    };
  }
  if (typeof args.platform === 'string' && !plan.platforms.includes(args.platform)) {
    return {
      ok: false,
      code: 'planner_bounds_exceeded',
      message: `platform ${args.platform} is not in planner platforms [${plan.platforms.join(', ')}]`,
    };
  }
  if (typeof args.objective === 'string' && args.objective !== plan.objective) {
    return {
      ok: false,
      code: 'planner_bounds_exceeded',
      message: `objective ${args.objective} does not match planner objective ${plan.objective}`,
    };
  }
  return { ok: true };
}
