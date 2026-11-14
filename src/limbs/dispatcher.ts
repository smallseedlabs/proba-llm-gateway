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
import type { ResearchArtifact } from '../types/research.js';

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
    if (call.verb.name === 'creative.draft_post') {
      // Hub writes goals.approved_creative when the operator approves (or edits) the draft card; the
      // gateway stores nothing. The saved copy reaches later calls as userSuppliedInput.creative.
      return {
        ok: true,
        data: {
          status: 'approved',
          savedBy: 'hub',
          note: 'The operator approved this draft (possibly with edits). Hub saved it as the goal creative; ads.create_campaign now uses the saved copy, not these arguments.',
        },
      };
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
      let args = call.args;
      if (call.verb.name === 'ads.create_campaign') {
        const accepted = await this.acceptedResearch(call, ctx);
        if (!accepted.ok) return accepted;
        // Forward the Hub-accepted research binding plus a gateway attestation so
        // Ads can verify (it never calls Hub). Not part of the approval hash.
        args = {
          ...call.args,
          researchAcceptance: {
            artifactId: accepted.artifact.artifactId,
            version: accepted.artifact.version,
            inputRevision: accepted.artifact.inputRevision,
          },
          researchAttestation: {
            status: 'accepted',
            landingPageUrl: accepted.artifact.landingPageUrl,
            acceptedAt: accepted.artifact.acceptedAt,
            sourceCount: accepted.artifact.sources.length,
            findingCount: accepted.artifact.findings.length,
          },
        };
      }
      const result = await this.ads.execute({
        traceId: ctx.traceId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        goalId: ctx.goalId,
        verb: call.verb.name,
        args,
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

  private async acceptedResearch(
    call: LimbCall,
    ctx: LimbExecutionContext
  ): Promise<{ ok: true; artifact: ResearchArtifact } | { ok: false; code: string; message: string }> {
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
    if (need || !artifact || artifact.status !== 'accepted' || !artifact.acceptedAt) {
      return { ok: false, code: 'research_not_accepted', message: need?.message ?? 'research artifact is not accepted' };
    }
    return { ok: true, artifact };
  }
}
