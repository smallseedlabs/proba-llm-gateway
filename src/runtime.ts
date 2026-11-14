/**
 * Runtime wiring. Fake LLM clients and executing limb adapters are not
 * registered. Test doubles may be injected only when NODE_ENV=test.
 * No DeepSeek (or other vendor) key is loaded here.
 */

import type { JWTVerifyGetKey } from 'jose';
import { ConfigError } from './errors.js';
import { loadPublicKeySet } from './auth/public-key-set.js';
import { loadSigningPrivateKey } from './auth/private-key.js';
import { ServiceTokenAuth } from './auth/service-token.js';
import { FirebaseAdminAuth, type AdminAuth } from './auth/admin-auth.js';
import { createLlmTokenSigner } from './auth/mint-llm-token.js';
import { LogAuditPublisher, RedisAuditPublisher } from './adapters/audit-redis.js';
import { FileRunStore } from './adapters/file-run-store.js';
import { MemoryRunStore } from './adapters/memory-run-store.js';
import { SystemClock } from './adapters/system-clock.js';
import { HttpLlmClient } from './adapters/http-llm-client.js';
import { HttpContextClient } from './adapters/http-context-client.js';
import { FailClosedApprovalGate } from './adapters/fail-closed-approval.js';
import { CatalogPolicyEngine } from './limbs/policy.js';
import { DomainLimbExecutor } from './limbs/dispatcher.js';
import { UnconfiguredAdsDomain } from './domains/ads/unconfigured.js';
import { HttpAdsDomain } from './domains/ads/http.js';
import { LoopCoordinator } from './loop/coordinator.js';
import type { AdsDomainPort } from './ports/ads.js';
import { ADS_AUDIENCE } from './auth/constants.js';
import { createLogger, type Logger } from './logger.js';
import type { AuditPublisher } from './ports/audit-publisher.js';
import type { Clock } from './ports/clock.js';
import type { ServiceAuth } from './ports/auth.js';
import type { RunStore } from './ports/run-store.js';
import type { LlmClient } from './ports/llm-client.js';
import type { ContextPort } from './ports/context.js';
import type { LimbExecutor } from './ports/limbs.js';
import type { ResearchArtifactStore, ResearchProviderPort } from './ports/research.js';
import type { AnalyticsDecisionStore } from './analytics/store.js';
import { MemoryAnalyticsStore } from './analytics/memory-store.js';
import { FileAnalyticsStore } from './analytics/file-store.js';
import type { ActionOutcomeStore, ActionPolicyStore } from './action-policy/store.js';
import { MemoryActionOutcomeStore, MemoryActionPolicyStore } from './action-policy/memory-store.js';
import { FileActionOutcomeStore, FileActionPolicyStore } from './action-policy/file-store.js';
import { UnconfiguredResearchProvider } from './research/unconfigured.js';
import { HttpUrlResearchProvider } from './research/http-url-provider.js';
import { MemoryResearchStore } from './research/memory-store.js';
import { FileResearchStore } from './research/file-store.js';
import type { GatewayServiceConfig } from './types/config.js';

export interface RuntimeOverrides {
  audit?: AuditPublisher;
  clock?: Clock;
  auth?: ServiceAuth;
  adminAuth?: AdminAuth;
  hubKeys?: JWTVerifyGetKey;
  assertionKeys?: JWTVerifyGetKey;
  llm?: LlmClient;
  context?: ContextPort;
  tools?: LimbExecutor;
  ads?: AdsDomainPort;
  research?: ResearchProviderPort;
  researchStore?: ResearchArtifactStore;
  analyticsStore?: AnalyticsDecisionStore;
  actionPolicyStore?: ActionPolicyStore;
  actionOutcomeStore?: ActionOutcomeStore;
  runs?: RunStore;
  fetch?: typeof fetch;
  logger?: Logger;
}

export interface GatewayRuntime {
  config: GatewayServiceConfig;
  coordinator: LoopCoordinator;
  auth: ServiceAuth;
  adminAuth?: AdminAuth;
  audit: AuditPublisher;
  clock: Clock;
  logger: Logger;
  llm: LlmClient;
  ready(): Promise<Record<string, 'ok' | 'fail'>>;
  close(): Promise<void>;
}

export async function createRuntime(config: GatewayServiceConfig, overrides: RuntimeOverrides = {}): Promise<GatewayRuntime> {
  if (overrides.llm && config.env === 'production') {
    throw new ConfigError('LLM client overrides are not allowed when NODE_ENV=production');
  }
  if (overrides.tools && config.env === 'production') {
    throw new ConfigError('limb executor overrides are not allowed when NODE_ENV=production');
  }
  if (overrides.llm?.name === 'fake' && config.env !== 'test') {
    throw new ConfigError('fake LLM clients are test-only');
  }
  if (overrides.tools && config.env !== 'test') {
    throw new ConfigError('limb executor overrides are test-only');
  }
  if (overrides.ads && config.env === 'production') {
    throw new ConfigError('Ads domain overrides are not allowed when NODE_ENV=production');
  }
  if ((overrides.research || overrides.researchStore) && config.env === 'production') {
    throw new ConfigError('Research overrides are not allowed when NODE_ENV=production');
  }
  if (overrides.analyticsStore && config.env === 'production') {
    throw new ConfigError('Analytics store overrides are not allowed when NODE_ENV=production');
  }
  if ((overrides.actionPolicyStore || overrides.actionOutcomeStore) && config.env === 'production') {
    throw new ConfigError('Action policy store overrides are not allowed when NODE_ENV=production');
  }

  const clock = overrides.clock ?? new SystemClock();
  const logger = overrides.logger ?? createLogger(config.logLevel);

  let audit = overrides.audit;
  if (!audit) {
    if (config.audit.kind === 'log') {
      audit = new LogAuditPublisher(undefined, config.env);
    } else {
      audit = new RedisAuditPublisher({
        url: config.audit.redisUrl,
        clock,
        stream: config.audit.stream,
        maxStreamLength: config.audit.maxStreamLength,
      });
    }
  }

  let auth = overrides.auth;
  if (!auth) {
    const keys =
      overrides.hubKeys ??
      (await loadPublicKeySet(config.auth.hubPublicKeyFile, { envName: 'HUB_SERVICE_PUBLIC_KEY_FILE', nodeEnv: config.env })).keys;
    auth = new ServiceTokenAuth({
      keys,
      allowedIssuers: config.auth.allowedIssuers,
      allowedSubjects: config.auth.allowedSubjects,
      now: () => clock.now(),
    });
  }

  let llm = overrides.llm;
  if (!llm) {
    const signingKey = await loadSigningPrivateKey(config.llm.signingKeyFile, {
      envName: 'GATEWAY_LLM_PRIVATE_KEY_FILE',
      kid: config.llm.signingKeyId,
      nodeEnv: config.env,
    });
    const signer = createLlmTokenSigner({
      signingKey,
      issuer: config.llm.tokenIssuer,
      subject: config.llm.tokenSubject,
      ttlSeconds: config.llm.tokenTtlSeconds,
      now: () => clock.now(),
    });
    llm = new HttpLlmClient({
      baseUrl: config.llm.baseUrl,
      allowedHosts: config.llm.allowedHosts,
      nodeEnv: config.env,
      timeoutMs: config.llm.timeoutMs,
      signer,
      fetchImpl: overrides.fetch,
    });
  }

  let context = overrides.context;
  if (!context) {
    context = new HttpContextClient({
      baseUrl: config.context.baseUrl,
      allowedHosts: config.context.allowedHosts,
      nodeEnv: config.env,
      timeoutMs: config.context.timeoutMs,
      fetchImpl: overrides.fetch,
    });
  }

  let ads = overrides.ads;
  if (!ads) {
    if (config.ads.baseUrl) {
      const signingKey = await loadSigningPrivateKey(config.llm.signingKeyFile, {
        envName: 'GATEWAY_LLM_PRIVATE_KEY_FILE',
        kid: config.llm.signingKeyId,
        nodeEnv: config.env,
      });
      ads = new HttpAdsDomain({
        baseUrl: config.ads.baseUrl,
        allowedHosts: config.ads.allowedHosts,
        nodeEnv: config.env,
        timeoutMs: config.ads.timeoutMs,
        signer: createLlmTokenSigner({
          signingKey,
          issuer: config.llm.tokenIssuer,
          subject: config.llm.tokenSubject,
          audience: config.ads.tokenAudience || ADS_AUDIENCE,
          ttlSeconds: config.llm.tokenTtlSeconds,
          now: () => clock.now(),
        }),
        fetchImpl: overrides.fetch,
      });
    } else {
      ads = new UnconfiguredAdsDomain();
    }
  }
  const researchProvider =
    overrides.research ??
    (config.research.httpFetchEnabled
      ? new HttpUrlResearchProvider({
          timeoutMs: config.research.timeoutMs,
          maxBytes: config.research.maxBytes,
          fetchImpl: overrides.fetch,
        })
      : new UnconfiguredResearchProvider());
  const researchStore =
    overrides.researchStore ??
    (config.env === 'test' || !config.research.storeDir
      ? new MemoryResearchStore(config.env)
      : new FileResearchStore(config.research.storeDir));
  const analyticsStore =
    overrides.analyticsStore ??
    (config.env === 'test' || !config.analytics.storeDir
      ? new MemoryAnalyticsStore(config.env)
      : new FileAnalyticsStore(config.analytics.storeDir));
  const actionPolicyStore =
    overrides.actionPolicyStore ??
    (config.env === 'test' || !config.actionPolicy.storeDir
      ? new MemoryActionPolicyStore(config.env)
      : new FileActionPolicyStore(config.actionPolicy.storeDir));
  const actionOutcomeStore =
    overrides.actionOutcomeStore ??
    (config.env === 'test' || !config.actionPolicy.outcomeStoreDir
      ? new MemoryActionOutcomeStore(config.env)
      : new FileActionOutcomeStore(config.actionPolicy.outcomeStoreDir));
  const researchRuntime = { provider: researchProvider, store: researchStore, clock };
  const tools = overrides.tools ?? new DomainLimbExecutor(ads, researchRuntime);
  const runs =
    overrides.runs ??
    (config.env === 'test' || !config.runStoreDir ? new MemoryRunStore(config.env) : new FileRunStore(config.runStoreDir));

  let assertionKeys = overrides.assertionKeys;
  if (!assertionKeys && config.auth.hubAssertionPublicKeyFile) {
    assertionKeys = (
      await loadPublicKeySet(config.auth.hubAssertionPublicKeyFile, {
        envName: 'HUB_ASSERTION_PUBLIC_KEY_FILE',
        nodeEnv: config.env,
      })
    ).keys;
  }

  let adminAuth = overrides.adminAuth;
  if (!adminAuth && config.admin.firebaseProjectId) {
    adminAuth = new FirebaseAdminAuth({
      projectId: config.admin.firebaseProjectId,
      adminEmails: config.admin.adminEmails,
    });
  }

  const coordinator = new LoopCoordinator({
    config,
    clock,
    audit,
    runs,
    llm,
    context,
    policy: new CatalogPolicyEngine(),
    approval: new FailClosedApprovalGate(),
    tools,
    ads,
    researchStore,
    analyticsStore,
    actionPolicyStore,
    actionOutcomeStore,
    assertionKeys,
  });

  return {
    config,
    coordinator,
    auth,
    adminAuth,
    audit,
    clock,
    logger,
    llm,
    async ready() {
      const checks: Record<string, 'ok' | 'fail'> = { config: 'ok' };
      if (config.audit.kind === 'log') {
        checks.audit = config.env === 'production' ? 'fail' : 'ok';
      } else if (audit.ping) {
        try {
          await audit.ping();
          checks.audit = 'ok';
        } catch {
          checks.audit = 'fail';
        }
      }
      try {
        await llm.ping();
        checks.llm = 'ok';
      } catch {
        checks.llm = 'fail';
      }
      return checks;
    },
    async close() {
      await runs.close();
      await researchStore.close();
      await analyticsStore.close();
      await actionPolicyStore.close();
      await actionOutcomeStore.close();
      await audit.close?.();
      await llm.close?.();
    },
  };
}
