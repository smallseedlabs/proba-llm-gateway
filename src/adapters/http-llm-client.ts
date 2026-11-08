/**
 * HTTP client for proba-llm POST /v1/complete. Mints a short-lived EdDSA
 * token per call. Does not hold a vendor API key.
 */

import { LlmClientError, type LlmClient, type LlmCompleteOptions } from '../ports/llm-client.js';
import type { LlmServiceTokenSigner } from '../ports/token-signer.js';
import { completeRequestSchema, turnResponseSchema, type CompleteRequest, type TurnResponse } from '../types/llm.js';
import type { LlmPricingClaim, LlmQuotaClaim } from '../types/preflight.js';
import { assertAllowedBaseUrl, trimBaseUrl } from '../http/allowlist.js';

export interface HttpLlmClientOptions {
  baseUrl: string;
  allowedHosts: readonly string[];
  nodeEnv: string;
  timeoutMs: number;
  signer: LlmServiceTokenSigner;
  fetchImpl?: typeof fetch;
}

const STATUS_TO_CODE: Record<number, LlmClientError['code']> = {
  400: 'invalid_request',
  401: 'invalid_token',
  409: 'idempotency_conflict',
  429: 'rate_limited',
  502: 'provider_error',
  504: 'provider_ambiguous',
};

export class HttpLlmClient implements LlmClient {
  readonly name = 'proba-llm';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly signer: LlmServiceTokenSigner;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpLlmClientOptions) {
    const url = assertAllowedBaseUrl(options.baseUrl, options.allowedHosts, options.nodeEnv);
    this.baseUrl = trimBaseUrl(url.toString());
    this.timeoutMs = options.timeoutMs;
    this.signer = options.signer;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: CompleteRequest, options: LlmCompleteOptions): Promise<TurnResponse> {
    const parsed = completeRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new LlmClientError('invalid_request', parsed.error.issues[0]?.message ?? 'invalid complete request');
    }
    const token = await this.signer.mint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuter = () => controller.abort();
    options.signal?.addEventListener('abort', onOuter, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/complete`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'idempotency-key': options.idempotencyKey,
        },
        body: JSON.stringify(parsed.data),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const errBody = body as { error?: string; message?: string } | undefined;
        const code =
          errBody?.error === 'model_refused'
            ? 'model_refused'
            : errBody?.error === 'token_expired'
              ? 'token_expired'
              : errBody?.error === 'aborted'
                ? 'aborted'
                : (STATUS_TO_CODE[response.status] ?? 'provider_error');
        throw new LlmClientError(code, errBody?.message ?? `proba-llm returned HTTP ${response.status}`, response.status, response.status === 429);
      }
      const turn = turnResponseSchema.safeParse(body);
      if (!turn.success) throw new LlmClientError('invalid_response', 'proba-llm returned a body that is not TurnResponse');
      return turn.data;
    } catch (err) {
      if (err instanceof LlmClientError) throw err;
      if (controller.signal.aborted) throw new LlmClientError('aborted', 'proba-llm call was cancelled or timed out', 504, false);
      throw new LlmClientError('unreachable', err instanceof Error ? err.message : 'proba-llm unreachable');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuter);
    }
  }

  async ping(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/ready`);
    if (!response.ok) throw new LlmClientError('unreachable', `proba-llm /ready returned HTTP ${response.status}`);
  }

  async quota(): Promise<LlmQuotaClaim> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/quota`);
      if (response.status === 404) {
        return { kind: 'unknown', reason: 'proba-llm has no quota endpoint; /ready is not a credit balance' };
      }
      if (!response.ok) {
        return { kind: 'unavailable', reason: `proba-llm /v1/quota returned HTTP ${response.status}` };
      }
      const body = (await response.json().catch(() => undefined)) as { eligible?: unknown; asOf?: unknown } | undefined;
      if (typeof body?.eligible !== 'boolean') {
        return { kind: 'unknown', reason: 'proba-llm quota body did not include an authoritative eligible flag' };
      }
      return {
        kind: 'verified',
        eligible: body.eligible,
        asOf: typeof body.asOf === 'string' ? body.asOf : new Date().toISOString(),
        source: 'proba-llm',
      };
    } catch (err) {
      return { kind: 'unavailable', reason: err instanceof Error ? err.message : 'proba-llm quota unreachable' };
    }
  }

  async pricing(): Promise<LlmPricingClaim> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/pricing`);
      if (response.status === 404) {
        return { kind: 'unknown', reason: 'proba-llm has no pricing endpoint; /ready is not a unit price' };
      }
      if (!response.ok) {
        return { kind: 'unavailable', reason: `proba-llm /v1/pricing returned HTTP ${response.status}` };
      }
      const body = (await response.json().catch(() => undefined)) as {
        promptUsdPerMillion?: unknown;
        completionUsdPerMillion?: unknown;
        version?: unknown;
      } | undefined;
      const prompt = body?.promptUsdPerMillion;
      const completion = body?.completionUsdPerMillion;
      const version = body?.version;
      if (typeof prompt !== 'number' || !(prompt > 0) || typeof completion !== 'number' || !(completion > 0) || typeof version !== 'string' || version.trim() === '') {
        return { kind: 'unknown', reason: 'proba-llm pricing body did not include authoritative positive unit rates' };
      }
      return { kind: 'verified', promptUsdPerMillion: prompt, completionUsdPerMillion: completion, version };
    } catch (err) {
      return { kind: 'unavailable', reason: err instanceof Error ? err.message : 'proba-llm pricing unreachable' };
    }
  }
}
