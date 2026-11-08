/**
 * TEST STUBS / doubles. createRuntime refuses these unless NODE_ENV=test.
 * They are not registered in production runtime wiring.
 */

import { ToolRefusedError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import { ContextClientError, type ContextBuildOptions, type ContextPort } from '../ports/context.js';
import type { LimbCall, LimbExecutionContext, LimbExecutor, LimbResult } from '../ports/limbs.js';
import { LlmClientError, type LlmClient, type LlmCompleteOptions } from '../ports/llm-client.js';
import type { AdsDomainAction, AdsDomainPort, AdsDomainResult } from '../ports/ads.js';
import type { AdsBillingClaim, AdsPreflightQuery, AdsPreflightReport, LlmQuotaClaim } from '../types/preflight.js';
import type { CompleteRequest, TurnResponse } from '../types/llm.js';
import type { ContextPacket, ContextRequest } from '../protocol.js';
import { testContextPacket } from './fixtures.js';

export class TrackingLlmClient implements LlmClient {
  readonly name = 'fake';
  completeCalls = 0;

  async complete(_request: CompleteRequest, _options: LlmCompleteOptions): Promise<TurnResponse> {
    this.completeCalls += 1;
    throw new LlmClientError('invalid_request', 'test LLM client must not be called in this slice');
  }

  async ping(): Promise<void> {
    return;
  }
}

/** TEST STUB: sequenced LLM turns. Never used outside NODE_ENV=test. */
export class ScriptedLlmClient implements LlmClient {
  readonly name = 'fake';
  completeCalls = 0;
  quotaCalls = 0;
  requests: CompleteRequest[] = [];
  hang?: () => Promise<void>;
  quotaClaim?: LlmQuotaClaim | (() => Promise<LlmQuotaClaim>);

  constructor(private readonly turns: TurnResponse[]) {}

  async quota(): Promise<LlmQuotaClaim> {
    this.quotaCalls += 1;
    if (typeof this.quotaClaim === 'function') return this.quotaClaim();
    if (this.quotaClaim) return this.quotaClaim;
    return { kind: 'unknown', reason: 'proba-llm has no quota endpoint; /ready is not a credit balance' };
  }

  async complete(request: CompleteRequest, options: LlmCompleteOptions): Promise<TurnResponse> {
    this.completeCalls += 1;
    this.requests.push(request);
    if (this.hang) {
      if (options.signal?.aborted) throw new LlmClientError('aborted', 'test LLM aborted', 504);
      await Promise.race([
        this.hang(),
        new Promise<void>((_, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new LlmClientError('aborted', 'test LLM aborted', 504)),
            { once: true }
          );
        }),
      ]);
    }
    const next = this.turns[this.completeCalls - 1];
    if (!next) throw new LlmClientError('provider_error', 'scripted LLM has no remaining turn');
    return next;
  }

  async ping(): Promise<void> {
    return;
  }
}

export class TrackingContextPort implements ContextPort {
  builds = 0;
  pings = 0;

  async ping(): Promise<void> {
    this.pings += 1;
    throw new ContextClientError('unreachable', 'test context port must not be called in this slice');
  }

  async build(_request: ContextRequest, _options: ContextBuildOptions): Promise<ContextPacket> {
    this.builds += 1;
    throw new Error('test context port must not be called in this slice');
  }
}

/** TEST STUB: returns a protocol ContextPacket. */
export class ScriptedContextPort implements ContextPort {
  builds = 0;
  pings = 0;
  requests: ContextRequest[] = [];
  packet: ContextPacket;
  pingError?: ContextClientError;

  constructor(packet: ContextPacket = testContextPacket()) {
    this.packet = packet;
  }

  async ping(): Promise<void> {
    this.pings += 1;
    if (this.pingError) throw this.pingError;
    return;
  }

  async build(request: ContextRequest, _options: ContextBuildOptions): Promise<ContextPacket> {
    this.builds += 1;
    this.requests.push(request);
    return { ...this.packet, traceId: request.traceId, workspaceId: request.workspaceId, goalId: request.goalId };
  }
}

export class TrackingLimbExecutor implements LimbExecutor {
  readonly name = 'fake';
  executions = 0;

  async execute(_call: LimbCall, _ctx: LimbExecutionContext): Promise<LimbResult> {
    this.executions += 1;
    throw new ToolRefusedError('test limb executor must not run tools');
  }
}

/** TEST STUB: deterministic clock. Not used in production runtime. */
export class AdjustableClock implements Clock {
  constructor(private ms: number = Date.now()) {}

  now(): Date {
    return new Date(this.ms);
  }

  isoNow(): string {
    return this.now().toISOString();
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

/** TEST STUB: Ads domain double. Does not call Reddit/Microsoft/Google/Meta. */
export class RecordingAdsDomain implements AdsDomainPort {
  readonly name = 'ads-test-stub';
  readonly configured = true;
  calls: AdsDomainAction[] = [];
  preflightCalls = 0;
  hang?: () => Promise<void>;
  failAmbiguous = false;
  preflightDown = false;
  preflightUnauthorized = false;
  mappingReady = true;
  campaignRunning = false;
  billing: AdsBillingClaim = {
    kind: 'verified',
    mode: 'billing_eligibility',
    eligible: true,
    asOf: new Date().toISOString(),
    source: 'ads_domain',
  };

  async preflight(query: AdsPreflightQuery): Promise<AdsPreflightReport> {
    this.preflightCalls += 1;
    const asOf = new Date().toISOString();
    if (this.preflightDown) {
      return {
        asOf,
        freshUntil: new Date(Date.now() + 15_000).toISOString(),
        service: { state: 'unavailable', message: 'TEST STUB: Ads domain down' },
        connection: { state: 'unavailable', message: 'TEST STUB: Ads domain down' },
        permissions: { state: 'unavailable', message: 'TEST STUB: Ads domain down' },
        blueprint: { state: 'unknown' },
        billing: { kind: 'unavailable', reason: 'TEST STUB: Ads domain down; billing was not verified' },
      };
    }
    if (this.preflightUnauthorized) {
      return {
        asOf,
        freshUntil: new Date(Date.now() + 15_000).toISOString(),
        service: { state: 'ready' },
        connection: { state: 'unauthorized', platform: query.platform, message: 'TEST STUB: workspace/provider not authorized' },
        permissions: { state: 'unauthorized', message: 'TEST STUB: missing provider permissions' },
        blueprint: {
          state: query.mappingRequired ? (this.mappingReady && query.probaCampaignId ? 'ready' : 'missing') : 'not_required',
          probaCampaignId: query.probaCampaignId,
          mapped: this.mappingReady,
          running: this.campaignRunning,
        },
        billing: this.billing,
      };
    }
    return {
      asOf,
      freshUntil: new Date(Date.now() + 15_000).toISOString(),
      service: { state: 'ready' },
      connection: { state: 'ready', platform: query.platform ?? 'reddit' },
      permissions: { state: 'ready', actions: query.verb ? [query.verb] : ['ads.create_campaign'] },
      blueprint: {
        state: query.mappingRequired ? (this.mappingReady && query.probaCampaignId ? 'ready' : 'missing') : 'not_required',
        probaCampaignId: query.probaCampaignId,
        mapped: Boolean(query.probaCampaignId) && this.mappingReady,
        running: this.campaignRunning,
      },
      billing: this.billing,
    };
  }

  async execute(action: AdsDomainAction): Promise<AdsDomainResult> {
    this.calls.push(action);
    if (this.failAmbiguous) {
      throw new ToolRefusedError('ads domain call was cancelled or timed out; outcome is ambiguous');
    }
    if (this.hang) {
      await Promise.race([
        this.hang(),
        new Promise<void>((_, reject) => {
          action.signal?.addEventListener(
            'abort',
            () => reject(new ToolRefusedError('ads domain call was cancelled or timed out; outcome is ambiguous')),
            { once: true }
          );
        }),
      ]);
    }
    if (action.verb === 'ads.create_campaign') {
      return {
        ok: true,
        data: {
          probaCampaignId: 'proba-camp-1',
          mappings: [
            {
              probaCampaignId: 'proba-camp-1',
              provider: 'reddit',
              providerCampaignId: 'r-mapped-1',
              providerAdGroupId: 'r-ag-1',
              providerAdId: 'r-ad-1',
            },
          ],
        },
      };
    }
    if (typeof action.args.probaCampaignId !== 'string') {
      return { ok: false, code: 'missing_proba_id', message: 'probaCampaignId is required' };
    }
    return {
      ok: true,
      data: {
        probaCampaignId: action.args.probaCampaignId,
        mappings: [
          {
            probaCampaignId: action.args.probaCampaignId,
            provider: 'reddit',
            providerCampaignId: 'r-mapped-1',
          },
        ],
      },
    };
  }
}
