/**
 * Evaluate the operation's prerequisite graph before every brain/model call
 * and immediately before Ads side effects. Cheap local nodes first; reuse
 * still-fresh workspace/account/operation-scoped evidence; do not probe every
 * provider every iteration. LLM/user/tool output cannot redefine this policy.
 */

import { BudgetExhaustedError, PreflightBlockedError } from '../errors.js';
import { VERB_CATALOG } from '../limbs/catalog.js';
import type { AdsDomainPort } from '../ports/ads.js';
import type { ContextPort } from '../ports/context.js';
import { ContextClientError } from '../ports/context.js';
import type { LlmClient } from '../ports/llm-client.js';
import type { RunRecord } from '../ports/run-store.js';
import type { Clock } from '../ports/clock.js';
import type { GatewayServiceConfig } from '../types/config.js';
import type { HubRunRequest } from '../types/run.js';
import type {
  AdsPreflightReport,
  CapabilityNeed,
  LlmPricingClaim,
  LlmQuotaClaim,
  OperationIntent,
  PreflightDecision,
  PrerequisiteEvidence,
  PrerequisiteId,
  RelaxedCheck,
  RunPhase,
} from '../types/preflight.js';
import type { RunUsageLedger } from '../usage/reservations.js';
import type { ResearchArtifactStore } from '../ports/research.js';
import { researchAcceptedNeed } from '../research/artifact.js';
import { lookupCurrentArtifact } from '../research/gather.js';
import { readUserSuppliedLanding } from '../research/input.js';
import { resolveOperationIntent } from './intent.js';
import { evaluateBillingLock } from './locked-policy.js';
import {
  BILLING_RELAXED_REASON,
  asAdPlatform,
  operationManifest,
  orderPrerequisites,
  spendClassForVerb,
} from './graph.js';

export interface PreflightDeps {
  config: GatewayServiceConfig;
  clock: Clock;
  ads: AdsDomainPort;
  llm: LlmClient;
  context: ContextPort;
  researchStore?: ResearchArtifactStore;
}

export interface RunPreflightOptions {
  phase: RunPhase;
  mutate?: { verb: string; args: Record<string, unknown> };
}

const NEVER_REUSE: ReadonlySet<PrerequisiteId> = new Set(['intent', 'auth.workspace', 'run.budget', 'research.accepted']);

function isoPlus(clock: Clock, ms: number): string {
  return new Date(clock.now().getTime() + ms).toISOString();
}

function unconfiguredAdsReport(clock: Clock, freshnessMs: number): AdsPreflightReport {
  const asOf = clock.isoNow();
  return {
    asOf,
    freshUntil: isoPlus(clock, freshnessMs),
    service: {
      state: 'missing',
      message: 'Ads domain service is not configured (ADS_DOMAIN_URL)',
    },
    connection: { state: 'missing', message: 'no Ads domain to authenticate a provider connection' },
    permissions: { state: 'unavailable', message: 'provider permissions cannot be checked without an Ads domain' },
    blueprint: { state: 'unknown', message: 'campaign blueprint/mapping is not available without an Ads domain' },
    billing: {
      kind: 'unknown',
      reason: 'provider billing cannot be queried; Ads domain is unconfigured. This is not a verified zero or nonzero balance',
    },
  };
}

function isFreshUntil(freshUntil: string, now: Date): boolean {
  const until = Date.parse(freshUntil);
  if (!Number.isFinite(until)) return false;
  return until > now.getTime();
}

function limbEnabled(name: string): boolean {
  return VERB_CATALOG.some((v) => v.limb === name && v.allowlisted);
}

function accountKey(workspaceId: string, platform?: string): string {
  return `${workspaceId}:${platform ?? '_'}`;
}

function lookupEvidence(
  evidence: readonly PrerequisiteEvidence[] | undefined,
  input: { id: PrerequisiteId; workspaceId: string; accountKey: string; operationId: string; now: Date }
): PrerequisiteEvidence | undefined {
  const row = evidence?.find(
    (item) =>
      item.id === input.id &&
      item.workspaceId === input.workspaceId &&
      item.accountKey === input.accountKey &&
      item.operationId === input.operationId &&
      (item.result === 'ready' || item.result === 'unknown')
  );
  if (!row) return undefined;
  if (!isFreshUntil(row.freshUntil, input.now)) return undefined;
  return row;
}

function upsertEvidence(list: PrerequisiteEvidence[], row: PrerequisiteEvidence): PrerequisiteEvidence[] {
  const next = list.filter(
    (item) =>
      !(
        item.id === row.id &&
        item.workspaceId === row.workspaceId &&
        item.accountKey === row.accountKey &&
        item.operationId === row.operationId
      )
  );
  next.push(row);
  return next;
}

export function invalidateAdsRemoteEvidence(evidence: readonly PrerequisiteEvidence[] | undefined): PrerequisiteEvidence[] {
  return (evidence ?? []).filter((item) => !item.id.startsWith('ads.') || item.id === 'ads.service');
}

function mutateIntent(mutate: { verb: string; args: Record<string, unknown> }): OperationIntent {
  if (mutate.verb.startsWith('page.')) {
    return { kind: 'page_mutate', requiresPage: true, requiresAds: false, spendClass: 'none' };
  }
  if (mutate.verb.startsWith('research.')) {
    return { kind: 'research_mutate', requiresAds: false, requiresPage: false, spendClass: 'none' };
  }
  const verb = mutate.verb;
  const spendClass = spendClassForVerb(verb, mutate.args);
  return {
    kind: 'ads_mutate',
    requiresAds: true,
    requiresPage: false,
    verb,
    platform: asAdPlatform(mutate.args.platform),
    probaCampaignId: typeof mutate.args.probaCampaignId === 'string' ? mutate.args.probaCampaignId : undefined,
    mappingRequired: verb !== 'ads.create_campaign',
    spendClass,
  };
}

async function llmPricing(llm: LlmClient): Promise<LlmPricingClaim> {
  if (typeof llm.pricing !== 'function') {
    return {
      kind: 'unknown',
      reason: 'proba-llm does not expose authoritative unit prices; gateway does not invent rates',
    };
  }
  try {
    return await llm.pricing();
  } catch (err) {
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : 'LLM pricing probe failed' };
  }
}

async function llmQuota(llm: LlmClient): Promise<LlmQuotaClaim> {
  if (typeof llm.quota !== 'function') {
    return { kind: 'unknown', reason: 'proba-llm does not expose an authoritative quota claim; run token/cost budgets still apply' };
  }
  try {
    return await llm.quota();
  } catch (err) {
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : 'LLM quota probe failed' };
  }
}

function needForQuota(
  quota: LlmQuotaClaim,
  policy: GatewayServiceConfig['llm']['quotaUnknownPolicy']
): CapabilityNeed | undefined {
  if (quota.kind === 'unavailable') {
    return {
      type: 'capability',
      capability: 'llm.service',
      state: 'unavailable',
      claim: 'unavailable',
      message: quota.reason,
    };
  }
  if (quota.kind === 'verified' && !quota.eligible) {
    return {
      type: 'capability',
      capability: 'llm.quota',
      state: 'insufficient',
      claim: 'verified',
      message: 'proba-llm reported the workspace is not eligible for another paid completion',
    };
  }
  if (quota.kind === 'unknown' && policy === 'refuse') {
    return {
      type: 'capability',
      capability: 'llm.quota',
      state: 'unknown',
      claim: 'unknown',
      message:
        'proba-llm quota is unknown (no authoritative /v1/quota). LLM_QUOTA_UNKNOWN_POLICY=refuse blocks paid model calls; unknown is not a verified credit balance',
    };
  }
  return undefined;
}

function adsServiceNeed(report: AdsPreflightReport): CapabilityNeed | undefined {
  if (report.service.state === 'ready') return undefined;
  return {
    type: 'capability',
    capability: 'ads.service',
    state: report.service.state === 'missing' ? 'missing' : report.service.state === 'unavailable' ? 'unavailable' : 'unknown',
    message: report.service.message ?? 'Ads domain service is not ready',
    question: 'Configure ADS_DOMAIN_URL and a reachable Ads domain. Provider adapters Reddit/Microsoft/Google/Meta sit below that service.',
  };
}

function adsConnectionNeed(report: AdsPreflightReport): CapabilityNeed | undefined {
  if (report.connection.state === 'ready') return undefined;
  return {
    type: 'capability',
    capability: 'ads.connection',
    state:
      report.connection.state === 'unauthorized'
        ? 'unauthorized'
        : report.connection.state === 'missing'
          ? 'missing'
          : report.connection.state === 'unavailable'
            ? 'unavailable'
            : 'unknown',
    message: report.connection.message ?? 'workspace/provider connection is not ready',
    question: 'Connect and authorize the workspace provider account in the Ads domain (not in this gateway).',
  };
}

function adsPermissionsNeed(report: AdsPreflightReport): CapabilityNeed | undefined {
  if (report.permissions.state === 'ready') return undefined;
  return {
    type: 'capability',
    capability: 'ads.permissions',
    state: report.permissions.state === 'unauthorized' ? 'unauthorized' : report.permissions.state === 'unavailable' ? 'unavailable' : 'unknown',
    message: report.permissions.message ?? 'Ads domain did not confirm required provider permissions',
  };
}

function adsBlueprintNeed(report: AdsPreflightReport): CapabilityNeed | undefined {
  if (report.blueprint.state === 'ready' || report.blueprint.state === 'not_required') return undefined;
  return {
    type: 'capability',
    capability: 'ads.blueprint',
    state: report.blueprint.state === 'missing' ? 'missing' : 'unknown',
    message: report.blueprint.message ?? 'Proba campaign blueprint/mapping is not ready',
    question: 'Pass a known probaCampaignId. Updates must target mapped provider campaign/ad-group/ad ids.',
  };
}

export async function runPreflight(
  deps: PreflightDeps,
  request: HubRunRequest,
  record: RunRecord,
  usage: RunUsageLedger,
  signal: AbortSignal,
  options: RunPreflightOptions = { phase: 'brain' }
): Promise<PreflightDecision> {
  const phase = options.phase;
  const intent = options.mutate ? mutateIntent(options.mutate) : resolveOperationIntent(request, record.pendingApproval, record.domainState);
  const manifest = operationManifest({ phase, intent });
  const order = orderPrerequisites(manifest.requires);
  const asOf = deps.clock.isoNow();
  const freshnessMs = deps.config.ads.preflightFreshnessMs;
  const now = deps.clock.now();
  const platform = intent.kind === 'ads_mutate' ? intent.platform : undefined;
  const acct = accountKey(request.workspaceId, platform);
  const revalidateAds = phase === 'mutate' && intent.kind === 'ads_mutate';

  const needs: CapabilityNeed[] = [];
  const relaxed: RelaxedCheck[] = [];
  const evaluated: PreflightDecision['evaluated'] = [];
  let evidence = [...(record.lastPreflight?.evidence ?? [])];
  let adsReport: AdsPreflightReport | undefined = record.lastPreflight?.ads;
  let quota: LlmQuotaClaim = record.lastPreflight?.llmQuota ?? {
    kind: 'unknown',
    reason: 'proba-llm quota was not yet observed; run token/cost budgets still apply',
  };
  let adsProbed = false;

  let runEligible = true;
  let runMessage: string | undefined;
  let runBudgetState: CapabilityNeed['state'] = 'insufficient';
  try {
    if (phase === 'brain') {
      if (usage.hasMonetaryCap()) usage.observePricing(await llmPricing(deps.llm));
      usage.assertCanStartIteration();
      usage.assertCanCallLlm();
    } else usage.assertCanCallTool();
  } catch (err) {
    runEligible = false;
    runMessage = err instanceof Error ? err.message : 'run budget exhausted';
    runBudgetState = err instanceof BudgetExhaustedError ? err.budgetState : 'insufficient';
  }
  const runBudget = { kind: 'local_run_budget' as const, eligible: runEligible, message: runMessage };

  const remember = (id: PrerequisiteId, result: PrerequisiteEvidence['result'], reason: string, reused: boolean): void => {
    evaluated.push({ id, reused, result });
    if (NEVER_REUSE.has(id)) return;
    evidence = upsertEvidence(evidence, {
      id,
      workspaceId: request.workspaceId,
      accountKey: acct,
      operationId: manifest.id,
      observedAt: asOf,
      freshUntil: isoPlus(deps.clock, freshnessMs),
      result,
      reason,
    });
  };

  const cachedReady = (id: PrerequisiteId): PrerequisiteEvidence | undefined => {
    if (NEVER_REUSE.has(id)) return undefined;
    if (revalidateAds && id.startsWith('ads.')) return undefined;
    return lookupEvidence(evidence, {
      id,
      workspaceId: request.workspaceId,
      accountKey: acct,
      operationId: manifest.id,
      now,
    });
  };

  const ensureAdsReport = async (): Promise<AdsPreflightReport> => {
    if (adsProbed && adsReport) return adsReport;
    if (!deps.ads.configured) {
      adsReport = unconfiguredAdsReport(deps.clock, freshnessMs);
      adsProbed = true;
      return adsReport;
    }
    try {
      adsReport = await deps.ads.preflight({
        workspaceId: request.workspaceId,
        userId: request.userId,
        goalId: request.goalId,
        verb: intent.kind === 'ads_mutate' ? intent.verb : undefined,
        platform: intent.kind === 'ads_mutate' ? intent.platform : undefined,
        probaCampaignId: intent.kind === 'ads_mutate' ? intent.probaCampaignId : undefined,
        mappingRequired: intent.kind === 'ads_mutate' ? intent.mappingRequired : false,
        signal,
      });
      if (!isFreshUntil(adsReport.freshUntil, deps.clock.now())) {
        needs.push({
          type: 'capability',
          capability: 'ads.service',
          state: 'stale',
          message: 'Ads preflight report was already stale when received',
        });
      }
    } catch (err) {
      adsReport = {
        ...unconfiguredAdsReport(deps.clock, freshnessMs),
        service: {
          state: 'unavailable',
          message: err instanceof Error ? err.message : 'Ads domain preflight failed',
        },
        billing: {
          kind: 'unavailable',
          reason: 'Ads domain preflight did not return an authoritative billing claim',
        },
      };
    }
    adsProbed = true;
    return adsReport;
  };

  for (const id of order) {
    if (needs.length > 0) break;
    const reuse = cachedReady(id);
    if (reuse) {
      remember(id, reuse.result, reuse.reason, true);
      continue;
    }

    if (id === 'intent') {
      if (intent.kind === 'insufficient_intent') {
        for (const question of intent.questions) {
          needs.push({
            type: 'capability',
            capability: 'intent',
            state: 'missing',
            message: 'structured intent is required before a paid model call',
            question,
          });
        }
        remember(id, 'blocked', 'structured intent missing', false);
        break;
      }
      remember(id, 'ready', 'structured operation intent from Hub stepType/command', false);
      continue;
    }

    if (id === 'auth.workspace') {
      if (!request.workspaceId) {
        needs.push({
          type: 'capability',
          capability: 'auth.workspace',
          state: 'unauthorized',
          message: 'workspace scoping is required and cannot be relaxed',
        });
        remember(id, 'blocked', 'workspace missing', false);
        break;
      }
      remember(id, 'ready', 'workspace scoped on the Hub request; not inferred from account running', false);
      continue;
    }

    if (id === 'run.budget') {
      if (!runEligible) {
        needs.push({
          type: 'capability',
          capability: 'run.budget',
          state: runBudgetState,
          message: runMessage ?? 'Proba run token/cost budget is exhausted',
        });
        remember(id, 'blocked', runMessage ?? 'run budget exhausted', false);
        break;
      }
      remember(id, 'ready', 'local run token/cost budget allows another model call', false);
      continue;
    }

    if (id === 'limb.manifest') {
      const limb =
        intent.kind === 'research_mutate'
          ? 'research'
          : intent.kind === 'page_mutate' || (intent.kind === 'read_or_plan' && intent.requiresPage)
            ? 'page'
            : 'ads';
      const requiredLimb = intent.kind === 'ads_mutate' ? 'ads' : limb;
      if (!limbEnabled(requiredLimb)) {
        needs.push({
          type: 'capability',
          capability: 'limb.manifest',
          state: 'missing',
          message: `${requiredLimb} limb is not enabled in the registered catalog for this operation`,
        });
        remember(id, 'blocked', `${requiredLimb} limb missing`, false);
        break;
      }
      remember(id, 'ready', `${requiredLimb} limb is registered and allowlisted`, false);
      continue;
    }

    if (id === 'context.ready') {
      if (!deps.config.context.baseUrl.trim()) {
        needs.push({
          type: 'capability',
          capability: 'context.ready',
          state: 'missing',
          message: 'CONTEXT_BRIDGE_URL is not configured; refusing paid model calls',
        });
        remember(id, 'blocked', 'context bridge unconfigured', false);
        break;
      }
      if (!request.goalId || !request.threadId) {
        needs.push({
          type: 'capability',
          capability: 'context.ready',
          state: 'missing',
          message: 'goalId and threadId are required for context enrichment before a paid model call',
        });
        remember(id, 'blocked', 'context identity missing', false);
        break;
      }
      if (deps.config.env !== 'test' && !request.actAsAssertion) {
        needs.push({
          type: 'capability',
          capability: 'context.ready',
          state: 'unauthorized',
          message: 'act-as assertion is required for context enrichment before a paid model call',
        });
        remember(id, 'blocked', 'act-as missing', false);
        break;
      }
      try {
        await deps.context.ping();
      } catch (err) {
        const down = err instanceof ContextClientError ? err : undefined;
        needs.push({
          type: 'capability',
          capability: 'context.ready',
          state: down?.code === 'timeout' ? 'unavailable' : down?.code === 'unreachable' ? 'unavailable' : 'unavailable',
          message: down?.message ?? (err instanceof Error ? err.message : 'context bridge is not ready'),
        });
        remember(id, 'blocked', down?.message ?? 'context ping failed', false);
        break;
      }
      remember(id, 'ready', 'context bridge readiness probe succeeded', false);
      continue;
    }

    if (id === 'llm.quota') {
      quota = await llmQuota(deps.llm);
      const quotaNeed = needForQuota(quota, deps.config.llm.quotaUnknownPolicy);
      if (quotaNeed) {
        needs.push(quotaNeed);
        remember(id, 'blocked', quotaNeed.message, false);
        break;
      }
      remember(
        id,
        quota.kind === 'unknown' ? 'unknown' : 'ready',
        quota.kind === 'unknown'
          ? `${quota.reason} Policy: ${deps.config.llm.quotaUnknownPolicy} (local token/iteration caps still apply; unknown is not a provider credit balance)`
          : 'llm quota eligible',
        false
      );
      continue;
    }

    if (id === 'research.accepted') {
      const landingPageUrl = readUserSuppliedLanding(request.userSuppliedInput);
      const mutateUrl =
        options.mutate?.verb === 'ads.create_campaign'
          ? readUserSuppliedLanding({ landingPageUrl: String(options.mutate.args.landingPageUrl ?? '') }) ?? landingPageUrl
          : landingPageUrl;
      const binding =
        request.goalId && request.threadId
          ? {
              workspaceId: request.workspaceId,
              userId: request.userId,
              goalId: request.goalId,
              threadId: request.threadId,
            }
          : undefined;
      if (!binding) {
        needs.push({
          type: 'capability',
          capability: 'research.accepted',
          state: 'missing',
          message: 'goalId and threadId are required to bind a research review artifact',
        });
        remember(id, 'blocked', 'research binding missing', false);
        break;
      }
      const artifact = deps.researchStore ? await lookupCurrentArtifact(deps.researchStore, binding, mutateUrl) : undefined;
      const need = researchAcceptedNeed(artifact, mutateUrl);
      if (need) {
        needs.push(need);
        remember(id, 'blocked', need.message, false);
        break;
      }
      remember(id, 'ready', 'accepted source-backed research artifact matches the current user-supplied URL revision', false);
      continue;
    }

    if (id === 'ads.service' || id === 'ads.connection' || id === 'ads.permissions' || id === 'ads.blueprint' || id === 'ads.billing') {
      const report = await ensureAdsReport();
      let nodeNeed: CapabilityNeed | undefined;
      if (id === 'ads.service') nodeNeed = adsServiceNeed(report);
      else if (id === 'ads.connection') nodeNeed = adsConnectionNeed(report);
      else if (id === 'ads.permissions') nodeNeed = adsPermissionsNeed(report);
      else if (id === 'ads.blueprint') nodeNeed = adsBlueprintNeed(report);
      else {
        const billing = evaluateBillingLock({
          claim: report.billing,
          unknownPolicy: deps.config.ads.unknownBalancePolicy,
          requirement: deps.config.ads.billingRequirement,
          mutating: true,
          spendClass: 'spend_increase',
        });
        nodeNeed = billing.need;
      }
      if (nodeNeed) {
        needs.push(nodeNeed);
        remember(id, 'blocked', nodeNeed.message, false);
        break;
      }
      remember(id, 'ready', `${id} ready from Ads domain observation`, false);
    }
  }

  if (intent.kind === 'ads_mutate' && intent.spendClass !== 'spend_increase') {
    relaxed.push({ capability: 'ads.billing', reason: BILLING_RELAXED_REASON });
    remember('ads.billing', 'relaxed', BILLING_RELAXED_REASON, false);
  }

  const offeredLimbs = [
    'page',
    'research',
    ...(intent.kind === 'ads_mutate'
      ? adsReport?.service.state === 'ready'
        ? (['ads'] as const)
        : []
      : limbEnabled('ads')
        ? (['ads'] as const)
        : []),
  ].filter((name, index, all) => all.indexOf(name) === index && limbEnabled(name));

  return {
    allowed: needs.length === 0,
    intent,
    manifest,
    ads: adsReport,
    llmQuota: quota,
    runBudget,
    needs,
    relaxed,
    evidence,
    evaluated,
    offeredLimbs,
    asOf,
  };
}

export function applyPreflightToRecord(record: RunRecord, decision: PreflightDecision): void {
  record.lastPreflight = {
    asOf: decision.asOf,
    ads: decision.ads,
    llmQuota: decision.llmQuota,
    evidence: decision.evidence,
    relaxed: decision.relaxed,
    manifestId: decision.manifest.id,
  };
}

export function graphAuditDetails(decision: PreflightDecision): Record<string, unknown> {
  return {
    manifestId: decision.manifest.id,
    phase: decision.manifest.phase,
    spendClass: decision.manifest.spendClass,
    evaluated: decision.evaluated.map((row) => row.id),
    reused: decision.evaluated.filter((row) => row.reused).map((row) => row.id),
    blocked: decision.needs.map((need) => need.capability),
    relaxed: decision.relaxed.map((row) => ({ capability: row.capability, reason: row.reason })),
  };
}

export function assertPreflightAllowed(decision: PreflightDecision): void {
  if (decision.allowed) return;
  const message = decision.needs[0]?.message ?? 'preflight blocked this operation before a paid model call';
  throw new PreflightBlockedError(message, decision.needs);
}

export function offeredToolFilter(offeredLimbs: readonly string[]): (name: string) => boolean {
  const allowed = new Set(offeredLimbs);
  return (name: string) => {
    const verb = VERB_CATALOG.find((v) => v.name === name);
    if (!verb || !verb.allowlisted) return false;
    return allowed.has(verb.limb);
  };
}
