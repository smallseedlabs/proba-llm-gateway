import type { GeneratedMediaAsset, MediaKind } from './provider.js';

export interface StoredCreativeAsset {
  id: string;
  workspaceId: string;
  userId: string;
  goalId?: string;
  kind: MediaKind;
  url: string;
  aspectRatio?: string;
  provider: string;
  model?: string;
  prompt?: string;
  title?: string;
  description?: string;
  tags: string[];
  visualStyle?: string;
  brandElements: string[];
  useCases: string[];
  curationStatus: 'approved' | 'candidate' | 'do_not_use';
  timesUsed: number;
  createdAt: string;
}

export interface SaveAssetInput {
  workspaceId: string;
  userId: string;
  goalId?: string;
  asset: GeneratedMediaAsset;
  title?: string;
  description?: string;
  tags?: string[];
  visualStyle?: string;
  brandElements?: string[];
  useCases?: string[];
  parentAssetId?: string;
  dedupeByPrompt?: boolean;
}

export interface HubAssetStoreConfig {
  hubBaseUrl?: string;
  internalToken?: string;
  fetchImpl?: typeof fetch;
}

export function hubAssetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HubAssetStoreConfig {
  const hubBaseUrl = (env.HUB_INTERNAL_URL ?? env.HUB_URL ?? '').trim().replace(/\/$/, '');
  const internalToken = (env.HUB_INTERNAL_ASSET_TOKEN ?? '').trim();
  return {
    ...(hubBaseUrl ? { hubBaseUrl } : {}),
    ...(internalToken ? { internalToken } : {}),
  };
}

export async function listHubAssets(
  params: {
    workspaceId: string;
    userId: string;
    goalId?: string;
    kind?: MediaKind;
    tag?: string;
    useCase?: string;
    query?: string;
    limit?: number;
  },
  cfg: HubAssetStoreConfig = hubAssetConfigFromEnv()
): Promise<{ ok: true; assets: StoredCreativeAsset[] } | { ok: false; code: string; message: string }> {
  if (!cfg.hubBaseUrl || !cfg.internalToken) {
    return { ok: true, assets: [] };
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const qs = new URLSearchParams({
    workspaceId: params.workspaceId,
    userId: params.userId,
    excludeDoNotUse: 'true',
  });
  if (params.goalId) qs.set('goalId', params.goalId);
  if (params.kind) qs.set('kind', params.kind);
  if (params.tag) qs.set('tag', params.tag);
  if (params.useCase) qs.set('useCase', params.useCase);
  if (params.query) qs.set('q', params.query);
  if (params.limit) qs.set('limit', String(params.limit));

  const res = await fetchImpl(`${cfg.hubBaseUrl}/v1/internal/assets?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${cfg.internalToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return { ok: false, code: 'asset_store_error', message: `Hub assets list failed (${res.status})` };
  }
  const body = (await res.json()) as { assets?: StoredCreativeAsset[] };
  return { ok: true, assets: Array.isArray(body.assets) ? body.assets : [] };
}

export async function saveHubAsset(
  input: SaveAssetInput,
  cfg: HubAssetStoreConfig = hubAssetConfigFromEnv()
): Promise<StoredCreativeAsset | null> {
  if (!cfg.hubBaseUrl || !cfg.internalToken) {
    return null;
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${cfg.hubBaseUrl}/v1/internal/assets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.internalToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: input.asset.assetId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      ...(input.goalId ? { goalId: input.goalId } : {}),
      kind: input.asset.kind,
      url: input.asset.url,
      sourceUrl: input.asset.url,
      mimeType: input.asset.mimeType,
      ...(input.asset.width ? { width: input.asset.width } : {}),
      ...(input.asset.height ? { height: input.asset.height } : {}),
      ...(input.asset.durationSeconds ? { durationSeconds: input.asset.durationSeconds } : {}),
      aspectRatio: input.asset.aspectRatio,
      provider: input.asset.provider,
      model: input.asset.model,
      prompt: input.asset.prompt,
      ...(input.title ? { title: input.title } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.visualStyle ? { visualStyle: input.visualStyle } : {}),
      ...(input.brandElements?.length ? { brandElements: input.brandElements } : {}),
      ...(input.useCases?.length ? { useCases: input.useCases } : {}),
      ...(input.parentAssetId ? { parentAssetId: input.parentAssetId } : {}),
      dedupeByPrompt: input.dedupeByPrompt ?? true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { asset?: StoredCreativeAsset };
  return body.asset ?? null;
}

export async function recordHubPaidAction(
  input: {
    workspaceId?: string;
    goalId: string;
    userId: string;
    actionType: 'media_generate' | 'research_paid' | 'llm_call';
    estimatedCostUsd: number;
    justification: string;
    evidence: string;
  },
  cfg: HubAssetStoreConfig = hubAssetConfigFromEnv()
): Promise<boolean> {
  if (!cfg.hubBaseUrl || !cfg.internalToken) {
    return false;
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${cfg.hubBaseUrl}/v1/internal/paid-actions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.internalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn('[paid-actions] Hub persistence returned non-ok status:', res.status);
    }
    return res.ok;
  } catch (err) {
    console.warn('[paid-actions] Hub persistence failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
