import { ToolRefusedError } from '../../errors.js';
import type { AdsDomainAction, AdsDomainPort, AdsDomainResult } from '../../ports/ads.js';
import type { AdsPreflightQuery, AdsPreflightReport } from '../../types/preflight.js';

/**
 * Default Ads domain when ADS_DOMAIN_URL is unset.
 * Fails explicitly. Does not invent Proba or provider campaign ids.
 * Reddit/Microsoft/Google/Meta provider adapters are external dependencies.
 */
export class UnconfiguredAdsDomain implements AdsDomainPort {
  readonly name = 'ads-unconfigured';
  readonly configured = false;

  async preflight(_query: AdsPreflightQuery): Promise<AdsPreflightReport> {
    const asOf = new Date().toISOString();
    return {
      asOf,
      freshUntil: new Date(Date.now() + 15_000).toISOString(),
      service: { state: 'missing', message: 'Ads domain service is not configured (ADS_DOMAIN_URL)' },
      connection: { state: 'missing', message: 'no Ads domain to authenticate a provider connection' },
      permissions: { state: 'unavailable', message: 'provider permissions cannot be checked without an Ads domain' },
      blueprint: { state: 'unknown', message: 'campaign blueprint/mapping is not available without an Ads domain' },
      billing: {
        kind: 'unknown',
        reason:
          'provider billing cannot be queried; Ads domain is unconfigured. This is not a verified zero or nonzero balance',
      },
    };
  }

  async execute(_action: AdsDomainAction): Promise<AdsDomainResult> {
    throw new ToolRefusedError(
      'Ads domain service is not configured (ADS_DOMAIN_URL). Provider adapters Reddit/Microsoft/Google/Meta are not in this process and were not called'
    );
  }
}
