import type { AnalyticsDecisionRecord, AnalyticsEvaluatorConfig, AnalyticsGateCode, CampaignMetricsSnapshot } from './types.js';

export interface GateFailure {
  code: AnalyticsGateCode;
  message: string;
}

const WINDOW_MS: Record<string, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function windowLengthMs(snapshot: CampaignMetricsSnapshot): number | undefined {
  if (snapshot.window?.from && snapshot.window?.to) {
    const from = Date.parse(snapshot.window.from);
    const to = Date.parse(snapshot.window.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) return to - from;
  }
  return WINDOW_MS['7d'];
}

export function freshnessGate(snapshot: CampaignMetricsSnapshot, now: Date, maxAgeMs: number): GateFailure | undefined {
  const asOf = Date.parse(snapshot.asOf);
  if (!Number.isFinite(asOf)) {
    return { code: 'unknown_freshness', message: 'analytics asOf is missing or not a timestamp; unknown is not treated as fresh' };
  }
  if (now.getTime() - asOf > maxAgeMs) {
    return { code: 'stale', message: `analytics asOf ${snapshot.asOf} is older than maxAgeMs ${maxAgeMs}` };
  }
  return undefined;
}

export function sampleGate(snapshot: CampaignMetricsSnapshot, minImpressions: number, minObservations: number): GateFailure | undefined {
  const impressions = snapshot.impressions;
  const observations = snapshot.observationCount;
  if (impressions === 'unknown' && observations === 'unknown') {
    return { code: 'unknown_sample', message: 'impressions and observationCount are unknown; unknown is not a zero sample' };
  }
  const impressionsOk = impressions !== 'unknown' && impressions >= minImpressions;
  const observationsOk = observations !== 'unknown' && observations >= minObservations;
  if (impressionsOk || observationsOk) return undefined;
  return {
    code: 'insufficient_sample',
    message: `sample below minImpressions=${minImpressions} and minObservations=${minObservations}`,
  };
}

export function coverageGate(snapshot: CampaignMetricsSnapshot, minWindowCoverage: number): GateFailure | undefined {
  if (snapshot.observationCount === 'unknown') {
    return { code: 'unknown_coverage', message: 'observationCount is unknown; window coverage is not assumed complete' };
  }
  const lengthMs = windowLengthMs(snapshot);
  if (!lengthMs) {
    return { code: 'unknown_coverage', message: 'analytics window length is unknown; coverage is not assumed complete' };
  }
  const expectedHourly = Math.max(1, Math.round(lengthMs / (60 * 60 * 1000)));
  const ratio = snapshot.observationCount / expectedHourly;
  if (ratio < minWindowCoverage) {
    return {
      code: 'insufficient_coverage',
      message: `observationCount ${snapshot.observationCount} covers ${(ratio * 100).toFixed(0)}% of ~${expectedHourly} hourly buckets (min ${(minWindowCoverage * 100).toFixed(0)}%)`,
    };
  }
  return undefined;
}

export function cooldownGate(last: AnalyticsDecisionRecord | undefined, now: Date): GateFailure | undefined {
  if (!last) return undefined;
  const until = Date.parse(last.cooldownUntil);
  if (!Number.isFinite(until)) return undefined;
  if (now.getTime() < until) {
    return { code: 'cooldown', message: `campaign ${last.probaCampaignId} is in cooldown until ${last.cooldownUntil}` };
  }
  return undefined;
}

export function staleDecisionGate(last: AnalyticsDecisionRecord | undefined, asOf: string): GateFailure | undefined {
  if (!last) return undefined;
  if (asOf < last.asOf) {
    return { code: 'stale_decision', message: `incoming asOf ${asOf} is behind campaign decision version ${last.asOf}` };
  }
  return undefined;
}

export function proposalBoundsGate(input: {
  intent: 'report' | 'propose_pause' | 'propose_cap';
  dailyBudget?: number;
  currentDailyBudget?: number;
  config: AnalyticsEvaluatorConfig;
}): GateFailure | undefined {
  if (input.intent === 'report' || input.intent === 'propose_pause') return undefined;
  if (input.dailyBudget === undefined || !Number.isFinite(input.dailyBudget) || input.dailyBudget <= 0) {
    return { code: 'proposal_bounds', message: 'propose_cap requires a positive dailyBudget; missing is unknown, not zero' };
  }
  if (input.config.maxProposalDailyBudget !== null && input.dailyBudget > input.config.maxProposalDailyBudget) {
    return {
      code: 'proposal_bounds',
      message: `proposed dailyBudget ${input.dailyBudget} exceeds maxProposalDailyBudget ${input.config.maxProposalDailyBudget}`,
    };
  }
  if (input.currentDailyBudget === undefined) {
    return { code: 'proposal_bounds', message: 'propose_cap requires currentDailyBudget; unknown current is not treated as zero' };
  }
  if (input.dailyBudget > input.currentDailyBudget) {
    return { code: 'proposal_bounds', message: 'propose_cap cannot increase dailyBudget; that would grant spend' };
  }
  if (input.config.maxProposalDecreasePct !== null && input.currentDailyBudget > 0) {
    const decreasePct = (input.currentDailyBudget - input.dailyBudget) / input.currentDailyBudget;
    if (decreasePct > input.config.maxProposalDecreasePct) {
      return {
        code: 'proposal_bounds',
        message: `proposed decrease ${(decreasePct * 100).toFixed(0)}% exceeds maxProposalDecreasePct ${(input.config.maxProposalDecreasePct * 100).toFixed(0)}%`,
      };
    }
  }
  return undefined;
}

export function firstSnapshotGate(
  snapshot: CampaignMetricsSnapshot,
  now: Date,
  config: AnalyticsEvaluatorConfig
): GateFailure | undefined {
  return (
    freshnessGate(snapshot, now, config.maxAgeMs) ??
    sampleGate(snapshot, config.minImpressions, config.minObservations) ??
    coverageGate(snapshot, config.minWindowCoverage)
  );
}
