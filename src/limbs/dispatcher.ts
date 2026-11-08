/**
 * Routes catalog verbs to domain ports. Generic limbs stay vendor-free.
 * Ads verbs go to the Ads domain (HTTP when configured, otherwise fail closed).
 * Research uses the research provider port; Context is never a citation source.
 */

import { ToolRefusedError } from '../errors.js';
import type { AdsDomainPort } from '../ports/ads.js';
import type { LimbCall, LimbExecutionContext, LimbExecutor, LimbResult } from '../ports/limbs.js';
import { attachUserPage } from '../domains/page/local.js';
import { researchAcceptedNeed } from '../research/artifact.js';
import { bindingFromCtx, executeGather, lookupCurrentArtifact, type ResearchRuntime } from '../research/gather.js';
import { normalizeLandingPageUrl } from '../research/input.js';

export class DomainLimbExecutor implements LimbExecutor {
  readonly name = 'domain';

  constructor(
    private readonly ads: AdsDomainPort,
    private readonly research?: ResearchRuntime
  ) {}

  async execute(call: LimbCall, ctx: LimbExecutionContext): Promise<LimbResult> {
    if (ctx.approval.status !== 'granted' && call.verb.requiresApproval) {
      throw new ToolRefusedError(`refusing ${call.verb.name}: Hub approval is not granted`);
    }
    if (call.verb.limb === 'page' && call.verb.verb === 'attach_user_page') {
      return attachUserPage(call, ctx);
    }
    if (call.verb.name === 'research.gather') {
      if (!this.research) {
        return {
          ok: false,
          code: 'research_unconfigured',
          message: 'Research provider is not configured; citations were not invented',
        };
      }
      const url = normalizeLandingPageUrl(call.args.url);
      if (!url) {
        return { ok: false, code: 'user_input', message: 'research.gather requires the user-supplied landing page URL' };
      }
      return executeGather(this.research, call, ctx, url);
    }
    if (call.verb.limb === 'ads') {
      if (typeof call.args.providerCampaignId === 'string' || typeof call.args.providerAdId === 'string') {
        return {
          ok: false,
          code: 'provider_id_refused',
          message: 'pass probaCampaignId only; provider resource ids are mapped by the Ads domain',
        };
      }
      if (call.verb.name === 'ads.create_campaign') {
        const blocked = await this.assertAcceptedResearch(call, ctx);
        if (blocked) return blocked;
      }
      const result = await this.ads.execute({
        traceId: ctx.traceId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        goalId: ctx.goalId,
        verb: call.verb.name,
        args: call.args,
        idempotencyKey: call.idempotencyKey,
        signal: ctx.signal,
      });
      if (result.ok) {
        const campaigns = Array.isArray(ctx.domainState.probaCampaigns)
          ? (ctx.domainState.probaCampaigns as string[])
          : [];
        if (!campaigns.includes(result.data.probaCampaignId)) campaigns.push(result.data.probaCampaignId);
        ctx.domainState.probaCampaigns = campaigns;
        if (result.data.mappings) ctx.domainState.providerMappings = result.data.mappings;
      }
      return result.ok ? { ok: true, data: result.data } : { ok: false, code: result.code, message: result.message };
    }
    throw new ToolRefusedError(`no domain adapter for ${call.verb.name}`);
  }

  private async assertAcceptedResearch(call: LimbCall, ctx: LimbExecutionContext): Promise<LimbResult | undefined> {
    if (!this.research) {
      return {
        ok: false,
        code: 'research_unconfigured',
        message: 'ads.create_campaign requires an accepted source-backed research artifact; research runtime is missing',
      };
    }
    const landingPageUrl = normalizeLandingPageUrl(call.args.landingPageUrl);
    const artifact = await lookupCurrentArtifact(this.research.store, bindingFromCtx(ctx), landingPageUrl);
    const need = researchAcceptedNeed(artifact, landingPageUrl);
    if (!need) return undefined;
    return { ok: false, code: 'research_not_accepted', message: need.message };
  }
}
