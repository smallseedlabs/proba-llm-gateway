/**
 * Read Context analytics items. Missing/null numbers are unknown, never 0.
 * Packet workspace/user is authoritative; item data must not widen scope.
 */

import type { ContextPacket } from '../protocol.js';
import type { AnalyticsScope, CampaignMetricsSnapshot } from './types.js';

type ContextItem = ContextPacket['sections'][number]['items'][number];

function unknownNumber(value: unknown): number | 'unknown' {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function windowOf(value: unknown): { from: string; to: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const from = asString(row.from);
  const to = asString(row.to);
  return from && to ? { from, to } : undefined;
}

export function hasNoAnalyticsGap(packet: ContextPacket): boolean {
  return packet.gaps.some((gap) => gap.code === 'no_analytics_for_campaign');
}

export function analyticsItems(packet: ContextPacket): ContextItem[] {
  const section = packet.sections.find((s) => s.kind === 'analytics');
  return section?.items ?? [];
}

export function parseCampaignMetrics(
  item: ContextItem,
  packet: ContextPacket
): CampaignMetricsSnapshot | undefined {
  if (typeof item.data !== 'object' || item.data === null || Array.isArray(item.data)) return undefined;
  const data = item.data as Record<string, unknown>;
  if (data.kind !== 'campaign_metrics') return undefined;
  const workspaceId = asString(data.workspaceId) ?? packet.workspaceId;
  const userId = asString(data.userId) ?? packet.userId;
  const platform = asString(data.platform);
  const accountId = asString(data.accountId);
  const campaignId = asString(data.campaignId);
  if (!platform || !accountId || !campaignId) return undefined;
  const asOf = asString(item.observedAt) ?? asString(data.asOf);
  if (!asOf) return undefined;
  return {
    kind: 'campaign_metrics',
    workspaceId,
    userId,
    platform,
    accountId,
    campaignId,
    probaCampaignId: asString(data.probaCampaignId),
    asOf,
    window: windowOf(data.window),
    currency: asString(data.currency),
    impressions: unknownNumber(data.impressions),
    clicks: unknownNumber(data.clicks),
    spend: unknownNumber(data.spend),
    conversions: unknownNumber(data.conversions),
    observationCount: unknownNumber(data.observationCount),
    sourceItemId: item.itemId,
  };
}

export function snapshotsFromPacket(packet: ContextPacket): CampaignMetricsSnapshot[] {
  return analyticsItems(packet)
    .map((item) => parseCampaignMetrics(item, packet))
    .filter((row): row is CampaignMetricsSnapshot => row !== undefined);
}

export function inScope(snapshot: CampaignMetricsSnapshot, scope: AnalyticsScope): boolean {
  if (snapshot.workspaceId !== scope.workspaceId) return false;
  if (snapshot.userId !== scope.userId) return false;
  if (scope.platform && snapshot.platform !== scope.platform) return false;
  if (scope.accountId && snapshot.accountId !== scope.accountId) return false;
  if (scope.providerCampaignId && snapshot.campaignId !== scope.providerCampaignId) return false;
  if (scope.probaCampaignId) {
    if (snapshot.probaCampaignId) return snapshot.probaCampaignId === scope.probaCampaignId;
    // Packet used provider campaign id; Hub proba id must be compared only when present.
    return snapshot.campaignId === scope.probaCampaignId;
  }
  return true;
}

export function unknownMetricNames(snapshot: CampaignMetricsSnapshot): string[] {
  const names: string[] = [];
  if (snapshot.impressions === 'unknown') names.push('impressions');
  if (snapshot.clicks === 'unknown') names.push('clicks');
  if (snapshot.spend === 'unknown') names.push('spend');
  if (snapshot.conversions === 'unknown') names.push('conversions');
  if (snapshot.observationCount === 'unknown') names.push('observationCount');
  return names;
}
