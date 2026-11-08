/**
 * Ads domain port. Campaign creation and updates are Proba-domain operations
 * against Proba campaign identity/blueprint/state. Provider adapters
 * (Reddit, Microsoft, Google, Meta) sit below this domain and are not
 * called from generic limbs or the coordinator.
 *
 * Updates MUST address a Proba campaign id that the domain maps to real
 * provider campaign/ad-group/ad ids. This gateway never invents provider ids.
 *
 * Unconfigured implementations must throw / return ok:false. Never fabricate
 * a successful provider mutation. Preflight must not invent a verified
 * balance from config or health.
 */

import type { AdsPreflightQuery, AdsPreflightReport } from '../types/preflight.js';

export interface AdsDomainAction {
  traceId: string;
  workspaceId: string;
  userId: string;
  goalId?: string;
  verb: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export type AdsDomainResult =
  | {
      ok: true;
      data: {
        probaCampaignId: string;
        mappings?: Array<{
          probaCampaignId: string;
          provider: 'reddit' | 'microsoft' | 'google' | 'meta';
          providerCampaignId: string;
          providerAdGroupId?: string;
          providerAdId?: string;
        }>;
        [key: string]: unknown;
      };
    }
  | { ok: false; code: string; message: string };

export interface AdsDomainPort {
  readonly name: string;
  /** False when ADS_DOMAIN_URL is unset — executor must fail closed. */
  readonly configured: boolean;
  execute(action: AdsDomainAction): Promise<AdsDomainResult>;
  /**
   * Authoritative workspace/provider readiness + billing claim.
   * Health/config is not a verified balance. Test doubles only in tests.
   */
  preflight(query: AdsPreflightQuery): Promise<AdsPreflightReport>;
}
