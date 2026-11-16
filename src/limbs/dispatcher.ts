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
import { executeWebSearch } from '../research/web-search.js';
import { listHubAssets, saveHubAsset } from '../media/asset-store.js';
import { fetchWikimediaStock, generateCreativeMedia, type MediaAspectRatio, type MediaKind, type MediaQuality, type MediaSource } from '../media/provider.js';
import type { ResearchArtifact } from '../types/research.js';

export class DomainLimbExecutor implements LimbExecutor {
  readonly name = 'domain';
  private readonly aiMediaByRun = new Map<string, number>();

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
      const lookupUrls = Array.isArray(call.args.lookupUrls)
        ? call.args.lookupUrls.filter((u): u is string => typeof u === 'string')
        : undefined;
      return executeGather(this.research, call, ctx, url, lookupUrls);
    }
    if (call.verb.name === 'web.search') {
      const query = typeof call.args.query === 'string' ? call.args.query : '';
      const maxResults = typeof call.args.maxResults === 'number' ? call.args.maxResults : 5;
      return executeWebSearch(query, maxResults);
    }
    if (call.verb.name === 'geo.brand_audit') {
      const geoUrl = (process.env.GEO_SERVICE_URL ?? '').trim().replace(/\/+$/, '');
      if (!geoUrl) {
        return {
          ok: false,
          code: 'geo_unconfigured',
          message: 'GEO service is not configured (GEO_SERVICE_URL missing)',
        };
      }
      const brandName = typeof call.args.brandName === 'string' ? call.args.brandName.trim() : '';
      const domain = typeof call.args.domain === 'string' ? call.args.domain.trim() : '';
      const prompts = Array.isArray(call.args.prompts)
        ? call.args.prompts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      const competitors = Array.isArray(call.args.competitors)
        ? call.args.competitors.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : [];
      const engines = Array.isArray(call.args.engines)
        ? call.args.engines.filter((e): e is string => typeof e === 'string')
        : undefined;
      try {
        const res = await fetch(`${geoUrl}/v1/geo/audit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: ctx.workspaceId,
            goalId: ctx.goalId,
            brandName,
            domain,
            competitors,
            prompts,
            ...(engines && engines.length > 0 ? { engines } : {}),
          }),
          signal: AbortSignal.timeout(45_000),
        });
        if (!res.ok) {
          const text = await res.text();
          return { ok: false, code: 'geo_failed', message: `geo-domain returned HTTP ${res.status}: ${text.slice(0, 200)}` };
        }
        const data = (await res.json()) as Record<string, unknown>;
        return { ok: true, data };
      } catch (err) {
        return { ok: false, code: 'geo_failed', message: `geo-domain request failed: ${(err as Error).message}` };
      }
    }
    if (call.verb.name === 'creative.list_assets') {
      const listed = await listHubAssets({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        ...(typeof call.args.kind === 'string' ? { kind: call.args.kind as MediaKind } : {}),
        ...(typeof call.args.query === 'string' ? { query: call.args.query } : {}),
        ...(typeof call.args.tag === 'string' ? { tag: call.args.tag } : {}),
        ...(typeof call.args.useCase === 'string' ? { useCase: call.args.useCase } : {}),
        ...(typeof call.args.limit === 'number' ? { limit: call.args.limit } : {}),
      });
      if (!listed.ok) {
        return { ok: false, code: listed.code, message: listed.message };
      }
      return { ok: true, data: { assets: listed.assets, count: listed.assets.length } };
    }
    if (call.verb.name === 'creative.generate_media') {
      const kind = (call.args.kind === 'video' ? 'video' : 'image') as MediaKind;
      const prompt = typeof call.args.prompt === 'string' ? call.args.prompt.trim() : '';
      const aspectRatio = typeof call.args.aspectRatio === 'string' ? (call.args.aspectRatio as MediaAspectRatio) : undefined;
      // Dedupe check against existing workspace assets before billing fal.ai
      const existing = await listHubAssets({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        kind,
        limit: 50,
      });
      if (existing.ok) {
        const match = existing.assets.find(
          (a) =>
            (a.prompt ?? '').trim().toLowerCase() === prompt.toLowerCase() &&
            (!aspectRatio || a.aspectRatio === aspectRatio)
        );
        if (match) {
          return { ok: true, data: { ...match, assetId: match.id, reusedExisting: true } };
        }
      }

      const source = typeof call.args.source === 'string' ? (call.args.source as MediaSource) : 'auto';
      const runKey = ctx.traceId;
      const aiCount = this.aiMediaByRun.get(runKey) ?? 0;
      if (source === 'ai' && aiCount >= 1) {
        return {
          ok: false,
          code: 'ai_media_cap',
          message: 'Per-run AI generation cap reached (1 fal.ai asset per run). Reuse an existing Studio asset or free stock.',
        };
      }
      let researchAccepted = true;
      if (source === 'ai' && this.research?.store) {
        const pageUrl =
          typeof ctx.domainState.landingPageUrl === 'string'
            ? ctx.domainState.landingPageUrl
            : typeof ctx.domainState.url === 'string'
              ? ctx.domainState.url
              : undefined;
        const artifact = pageUrl
          ? await lookupCurrentArtifact(this.research.store, bindingFromCtx(ctx), pageUrl)
          : undefined;
        if (!artifact || artifact.status !== 'accepted' || !artifact.acceptedAt) {
          researchAccepted = false;
        }
      }

      const effectiveSource: MediaSource = !researchAccepted ? 'stock' : source;
      let outcome = await generateCreativeMedia({
        kind,
        prompt,
        ...(typeof call.args.searchQuery === 'string' ? { searchQuery: call.args.searchQuery } : {}),
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(typeof call.args.quality === 'string' ? { quality: call.args.quality as MediaQuality } : {}),
        source: effectiveSource,
        ...(typeof call.args.sourceImageUrl === 'string' ? { sourceImageUrl: call.args.sourceImageUrl } : {}),
        ...(call.args.durationSeconds === 5 || call.args.durationSeconds === 10
          ? { durationSeconds: call.args.durationSeconds }
          : {}),
      });
      if (!outcome.ok && outcome.code === 'media_unconfigured' && kind === 'image') {
        const query = typeof call.args.searchQuery === 'string' && call.args.searchQuery.trim()
          ? call.args.searchQuery.trim()
          : prompt;
        outcome = await fetchWikimediaStock(query, aspectRatio ?? '4:5');
      }
      if (!outcome.ok && !researchAccepted) {
        return {
          ok: false,
          code: 'research_not_accepted',
          message:
            'Research artifact is not accepted yet and no free stock image matched. Do NOT retry creative.generate_media in this turn; proceed with creative.draft_post (text-first) or wait for research acceptance.',
        };
      }
      if (!outcome.ok) {
        return { ok: false, code: outcome.code, message: outcome.message };
      }
      if (outcome.asset.provider === 'fal') {
        this.aiMediaByRun.set(runKey, aiCount + 1);
      }
      const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
      const saved = await saveHubAsset({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        ...(ctx.goalId ? { goalId: ctx.goalId } : {}),
        asset: outcome.asset,
        ...(typeof call.args.title === 'string' ? { title: call.args.title } : {}),
        ...(typeof call.args.description === 'string' ? { description: call.args.description } : {}),
        tags: strArr(call.args.tags),
        ...(typeof call.args.visualStyle === 'string' ? { visualStyle: call.args.visualStyle } : {}),
        brandElements: strArr(call.args.brandElements),
        useCases: strArr(call.args.useCases),
        ...(typeof call.args.parentAssetId === 'string' ? { parentAssetId: call.args.parentAssetId } : {}),
      });
      return {
        ok: true,
        data: {
          ...(outcome.asset as unknown as Record<string, unknown>),
          ...(saved ? { assetId: saved.id, persistedToAssetService: true } : { persistedToAssetService: false }),
        },
      };
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
        if (call.verb.name === 'ads.create_campaign') {
          const firstMapping = result.data.mappings?.[0];
          ctx.domainState.createdCampaign = {
            verb: 'ads.create_campaign',
            ok: true,
            probaCampaignId: result.data.probaCampaignId,
            platform: typeof call.args.platform === 'string' ? call.args.platform : (firstMapping?.provider ?? 'reddit'),
            ...(typeof call.args.dailyBudget === 'number' ? { dailyBudget: call.args.dailyBudget } : {}),
            ...(typeof call.args.currency === 'string' ? { currency: call.args.currency } : {}),
            ...(firstMapping?.providerCampaignId ? { providerCampaignId: firstMapping.providerCampaignId } : {}),
            ...(firstMapping?.providerAdGroupId ? { providerAdGroupId: firstMapping.providerAdGroupId } : {}),
            ...(firstMapping?.providerAdId ? { providerAdId: firstMapping.providerAdId } : {}),
            ...(typeof result.data.deliverableAd === 'boolean' ? { deliverableAd: result.data.deliverableAd } : {}),
            ...(result.data.providerLaunch ? { providerLaunch: result.data.providerLaunch } : {}),
          };
        }
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
