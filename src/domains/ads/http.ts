/**
 * HTTP Ads domain client. Later Ads service plugs in at ADS_DOMAIN_URL
 * without rebuilding the gateway loop. This process still never holds
 * Reddit/Microsoft/Google/Meta credentials.
 *
 * POST {base}/v1/campaign-actions
 * Authorization: Bearer <EdDSA aud=proba-ads>
 * Idempotency-Key: action.idempotencyKey
 */

import { ToolRefusedError } from '../../errors.js';
import type { AdsDomainAction, AdsDomainPort, AdsDomainResult } from '../../ports/ads.js';
import type { LlmServiceTokenSigner } from '../../ports/token-signer.js';
import { assertAllowedBaseUrl, trimBaseUrl } from '../../http/allowlist.js';
import { adsPreflightReportSchema, type AdsPreflightQuery, type AdsPreflightReport } from '../../types/preflight.js';

export const ADS_ACTION_PATH = '/v1/campaign-actions';
export const ADS_PREFLIGHT_PATH = '/v1/preflight';

export interface HttpAdsDomainOptions {
  baseUrl: string;
  allowedHosts: readonly string[];
  nodeEnv: string;
  timeoutMs: number;
  signer: LlmServiceTokenSigner;
  fetchImpl?: typeof fetch;
}

export class HttpAdsDomain implements AdsDomainPort {
  readonly name = 'ads-http';
  readonly configured = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly signer: LlmServiceTokenSigner;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpAdsDomainOptions) {
    const url = assertAllowedBaseUrl(options.baseUrl, options.allowedHosts, options.nodeEnv);
    this.baseUrl = trimBaseUrl(url.toString());
    this.timeoutMs = options.timeoutMs;
    this.signer = options.signer;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async preflight(query: AdsPreflightQuery): Promise<AdsPreflightReport> {
    const token = await this.signer.mint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuter = () => controller.abort();
    query.signal?.addEventListener('abort', onOuter, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${ADS_PREFLIGHT_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          workspaceId: query.workspaceId,
          userId: query.userId,
          goalId: query.goalId,
          verb: query.verb,
          platform: query.platform,
          probaCampaignId: query.probaCampaignId,
          mappingRequired: query.mappingRequired,
        }),
        signal: controller.signal,
      });
      if (response.status === 404) {
        return healthIsNotBalance(new Date().toISOString(), 'Ads domain has no /v1/preflight; /ready is not a billing claim');
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        return healthIsNotBalance(
          new Date().toISOString(),
          `Ads domain preflight returned HTTP ${response.status}`
        );
      }
      const parsed = adsPreflightReportSchema.safeParse(sanitizeAdsPreflight(body));
      if (!parsed.success) {
        return healthIsNotBalance(new Date().toISOString(), 'Ads domain preflight body is not an authoritative capability report');
      }
      return parsed.data;
    } catch (err) {
      return healthIsNotBalance(
        new Date().toISOString(),
        err instanceof Error ? err.message : 'Ads domain preflight unreachable'
      );
    } finally {
      clearTimeout(timer);
      query.signal?.removeEventListener('abort', onOuter);
    }
  }

  async execute(action: AdsDomainAction): Promise<AdsDomainResult> {
    const token = await this.signer.mint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuter = () => controller.abort();
    action.signal?.addEventListener('abort', onOuter, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${ADS_ACTION_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'idempotency-key': action.idempotencyKey,
        },
        body: JSON.stringify({
          traceId: action.traceId,
          workspaceId: action.workspaceId,
          userId: action.userId,
          goalId: action.goalId,
          verb: action.verb,
          args: action.args,
          idempotencyKey: action.idempotencyKey,
        }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (controller.signal.aborted) {
        throw new ToolRefusedError('ads domain call was cancelled or timed out; outcome is ambiguous');
      }
      if (!response.ok) {
        const errBody = body as { error?: string; message?: string } | undefined;
        return {
          ok: false,
          code: errBody?.error ?? `http_${response.status}`,
          message: errBody?.message ?? `Ads domain returned HTTP ${response.status}`,
        };
      }
      const parsed = body as AdsDomainResult | undefined;
      if (!parsed || typeof parsed !== 'object' || !('ok' in parsed)) {
        return { ok: false, code: 'invalid_response', message: 'Ads domain returned an unexpected body' };
      }
      if (parsed.ok === true && typeof parsed.data?.probaCampaignId !== 'string') {
        return { ok: false, code: 'invalid_response', message: 'Ads domain success omitted probaCampaignId' };
      }
      return parsed;
    } catch (err) {
      if (err instanceof ToolRefusedError) throw err;
      if (controller.signal.aborted) {
        throw new ToolRefusedError('ads domain call was cancelled or timed out; outcome is ambiguous');
      }
      throw new ToolRefusedError(err instanceof Error ? err.message : 'ads domain unreachable');
    } finally {
      clearTimeout(timer);
      action.signal?.removeEventListener('abort', onOuter);
    }
  }
}

function healthIsNotBalance(asOf: string, reason: string): AdsPreflightReport {
  return {
    asOf,
    freshUntil: new Date(Date.parse(asOf) + 15_000).toISOString(),
    service: { state: 'unknown', message: reason },
    connection: { state: 'unknown', message: reason },
    permissions: { state: 'unknown', message: reason },
    blueprint: { state: 'unknown', message: reason },
    billing: { kind: 'unknown', reason: `${reason}. Provider funds were not verified` },
  };
}

function sanitizeAdsPreflight(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const row = { ...(body as Record<string, unknown>) };
  const billing = row.billing;
  if (typeof billing === 'object' && billing !== null) {
    const claim = { ...(billing as Record<string, unknown>) };
    if (claim.kind !== 'verified' || claim.mode !== 'exact_balance') {
      delete claim.amount;
    }
    if (claim.kind === 'verified' && claim.mode !== 'billing_eligibility' && claim.mode !== 'exact_balance') {
      row.billing = { kind: 'unknown', reason: 'Ads domain verified claim omitted an explicit billing mode' };
      return row;
    }
    row.billing = claim;
  }
  return row;
}
