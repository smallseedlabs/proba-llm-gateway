/**
 * Plan sections the brain may attach to its creative.draft_post card, so the operator approves ONE plan
 * card (copy + targeting + success metric + schedule) and can override any part. Every default carries a
 * plain "why" so the card reads "chose X because Y". Shapes match the Ads domain (official Reddit Create
 * Ad Group targeting: subreddit NAMES, not t5_ ids). Platform is reddit only (the only adapter).
 */

export const PLAN_LOCKS = Object.freeze({ maxCommunities: 25, maxInterests: 20, maxKeywords: 50, maxGeolocations: 50, maxScheduleDays: 90 });

export const SUCCESS_METRICS = ['clicks', 'ctr', 'cpc', 'landing_page_views', 'signups', 'conversions'] as const;
export type SuccessMetric = (typeof SUCCESS_METRICS)[number];

const REDDIT_PLATFORMS = ['ALL', 'DESKTOP', 'MOBILE_NATIVE', 'MOBILE_WEB'] as const;
const REDDIT_LANGUAGES = ['AR', 'CS', 'DA', 'DE', 'EL', 'EN', 'ES', 'FI', 'FR', 'HU', 'IT', 'JA', 'KO', 'NL', 'NO', 'PL', 'PT', 'RO', 'SV', 'VI', 'ZH'] as const;

export interface PlanRules {
  maxCommunities: number;
  maxScheduleDays: number;
}
export const DEFAULT_PLAN_RULES: PlanRules = Object.freeze({ maxCommunities: PLAN_LOCKS.maxCommunities, maxScheduleDays: PLAN_LOCKS.maxScheduleDays });

export interface CheckedTargeting {
  communities?: string[];
  geolocations?: string[];
  interests?: string[];
  keywords?: string[];
  platforms?: string[];
  languages?: string[];
}

export interface CheckedPlan {
  platform: 'reddit';
  successMetric: SuccessMetric;
  /** Target value of the success metric over the run (e.g. 200 clicks, 1.2 ctr %). */
  successTarget?: number;
  durationDays?: number;
  reasons: Record<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, max: number, item: (s: string) => string | undefined, label: string): string[] | string | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max) return `${label} must be a list of at most ${max}`;
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') return `${label} must contain text`;
    const s = item(raw.trim());
    if (!s) return `${label} has an invalid entry "${String(raw).slice(0, 40)}"`;
    if (!out.includes(s)) out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

const SUBREDDIT = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;

export function checkTargeting(raw: unknown, rules: PlanRules = DEFAULT_PLAN_RULES): { ok: true; targeting?: CheckedTargeting } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw)) return { ok: false, reason: 'targeting must be an object' };
  const allowed = new Set(['communities', 'geolocations', 'interests', 'keywords', 'platforms', 'languages']);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) return { ok: false, reason: `targeting.${k} is not supported` };
  const fields: Array<[keyof CheckedTargeting, number, (s: string) => string | undefined]> = [
    ['communities', Math.min(rules.maxCommunities, PLAN_LOCKS.maxCommunities), (s) => {
      const name = s.replace(/^\/?r\//i, '');
      return /^t5_/i.test(name) || !SUBREDDIT.test(name) ? undefined : name;
    }],
    ['geolocations', PLAN_LOCKS.maxGeolocations, (s) => (/^[A-Za-z0-9_-]{2,64}$/.test(s) ? s.toUpperCase() : undefined)],
    ['interests', PLAN_LOCKS.maxInterests, (s) => (s.length >= 1 && s.length <= 128 ? s : undefined)],
    ['keywords', PLAN_LOCKS.maxKeywords, (s) => (s.length >= 1 && s.length <= 128 ? s : undefined)],
    ['platforms', REDDIT_PLATFORMS.length, (s) => ((REDDIT_PLATFORMS as readonly string[]).includes(s.toUpperCase()) ? s.toUpperCase() : undefined)],
    ['languages', REDDIT_LANGUAGES.length, (s) => ((REDDIT_LANGUAGES as readonly string[]).includes(s.toUpperCase()) ? s.toUpperCase() : undefined)],
  ];
  const out: CheckedTargeting = {};
  for (const [key, max, item] of fields) {
    const r = stringList(raw[key], max, item, `targeting.${key}`);
    if (typeof r === 'string') return { ok: false, reason: r };
    if (r) out[key] = r;
  }
  return { ok: true, targeting: Object.keys(out).length > 0 ? out : undefined };
}

export function checkPlan(raw: unknown, rules: PlanRules = DEFAULT_PLAN_RULES): { ok: true; plan?: CheckedPlan } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw)) return { ok: false, reason: 'plan must be an object' };
  const allowed = new Set(['platform', 'successMetric', 'successTarget', 'durationDays', 'reasons']);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) return { ok: false, reason: `plan.${k} is not supported` };
  const platform = raw.platform ?? 'reddit';
  if (platform !== 'reddit') return { ok: false, reason: 'plan.platform must be reddit (the only connected ad platform)' };
  if (typeof raw.successMetric !== 'string' || !(SUCCESS_METRICS as readonly string[]).includes(raw.successMetric)) {
    return { ok: false, reason: `plan.successMetric must be one of ${SUCCESS_METRICS.join(', ')}` };
  }
  let successTarget: number | undefined;
  if (raw.successTarget !== undefined) {
    if (typeof raw.successTarget !== 'number' || !Number.isFinite(raw.successTarget) || raw.successTarget <= 0) return { ok: false, reason: 'plan.successTarget must be a positive number' };
    successTarget = raw.successTarget;
  }
  let durationDays: number | undefined;
  const maxDays = Math.min(rules.maxScheduleDays, PLAN_LOCKS.maxScheduleDays);
  if (raw.durationDays !== undefined) {
    if (typeof raw.durationDays !== 'number' || !Number.isInteger(raw.durationDays) || raw.durationDays < 1 || raw.durationDays > maxDays) {
      return { ok: false, reason: `plan.durationDays must be a whole number from 1 to ${maxDays}` };
    }
    durationDays = raw.durationDays;
  }
  const reasons: Record<string, string> = {};
  if (raw.reasons !== undefined) {
    if (!isRecord(raw.reasons)) return { ok: false, reason: 'plan.reasons must map a field to a short reason' };
    for (const [k, v] of Object.entries(raw.reasons).slice(0, 12)) {
      if (typeof v === 'string' && v.trim()) reasons[k.slice(0, 40)] = v.trim().slice(0, 300);
    }
  }
  return { ok: true, plan: { platform: 'reddit', successMetric: raw.successMetric as SuccessMetric, ...(successTarget ? { successTarget } : {}), ...(durationDays ? { durationDays } : {}), reasons } };
}
