import type { GatewayServiceConfig } from '../types/config.js';

export function testConfig(overrides: Partial<GatewayServiceConfig> = {}): GatewayServiceConfig {
  return {
    env: 'test',
    logLevel: 'silent',
    listen: { host: '127.0.0.1', port: 3700 },
    auth: {
      hubPublicKeyFile: '',
      allowedIssuers: ['proba-hub'],
      allowedSubjects: ['hub'],
      hubAssertionPublicKeyFile: '',
    },
    llm: {
      baseUrl: 'http://llm:3600',
      allowedHosts: ['llm'],
      timeoutMs: 1000,
      signingKeyFile: '',
      signingKeyId: 'test',
      tokenIssuer: 'proba-gateway',
      tokenSubject: 'gateway',
      tokenTtlSeconds: 60,
    },
    context: {
      baseUrl: 'http://context:3500',
      allowedHosts: ['context'],
      timeoutMs: 1000,
      maxBudgetTokens: 4000,
    },
    ads: {
      baseUrl: '',
      allowedHosts: [],
      timeoutMs: 1000,
      tokenAudience: 'proba-ads',
      unknownBalancePolicy: 'refuse_mutating',
      billingRequirement: 'billing_eligibility',
      preflightFreshnessMs: 15_000,
    },
    limits: {
      maxRequestBytes: 262_144,
      rateLimitMax: 60,
      rateLimitWindowMs: 60_000,
      maxIterations: 8,
      maxLlmCalls: 8,
      maxToolCalls: 16,
      maxPromptTokens: null,
      maxCompletionTokens: null,
      maxTotalTokens: 8000,
      maxCostUsd: null,
      responseTokenReserve: 512,
    },
    audit: {
      kind: 'log',
      stream: 'proba.audit.events',
      redisUrl: '',
      contentEnabled: true,
      contentMaskPii: true,
      maxStreamLength: 0,
    },
    runStoreDir: '',
    ...overrides,
  };
}
