import type { LimbCall, LimbExecutionContext, LimbResult } from '../ports/limbs.js';
import type { ResearchArtifactStore, ResearchProviderPort } from '../ports/research.js';
import type { Clock } from '../ports/clock.js';
import { artifactFromProvider } from './artifact.js';
import { inputRevisionForUrl, type ResearchBinding } from './input.js';

export interface ResearchRuntime {
  provider: ResearchProviderPort;
  store: ResearchArtifactStore;
  clock: Clock;
}

export function bindingFromCtx(ctx: LimbExecutionContext): ResearchBinding | undefined {
  if (!ctx.goalId || !ctx.threadId) return undefined;
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    goalId: ctx.goalId,
    threadId: ctx.threadId,
  };
}

export async function executeGather(
  runtime: ResearchRuntime,
  _call: LimbCall,
  ctx: LimbExecutionContext,
  landingPageUrl: string,
  lookupUrls?: readonly string[]
): Promise<LimbResult> {
  const binding = bindingFromCtx(ctx);
  if (!binding) {
    return {
      ok: false,
      code: 'research_scope',
      message: 'research.gather requires workspace, user, goalId, and threadId',
    };
  }
  const revision = inputRevisionForUrl(landingPageUrl);
  const existing = await runtime.store.get(binding, revision);
  if (existing?.status === 'awaiting_acceptance' || existing?.status === 'accepted') {
    return { ok: true, data: existing };
  }
  const result = await runtime.provider.research({
    workspaceId: binding.workspaceId,
    userId: binding.userId,
    goalId: binding.goalId,
    threadId: binding.threadId,
    landingPageUrl,
    ...(lookupUrls?.length ? { lookupUrls } : {}),
    signal: ctx.signal,
  });
  const artifact = artifactFromProvider({
    binding,
    landingPageUrl,
    providerName: runtime.provider.name,
    now: runtime.clock.isoNow(),
    existing,
    result,
  });
  await runtime.store.put(artifact);
  if (artifact.status === 'failed') {
    return {
      ok: false,
      code: artifact.errorCode ?? 'research_failed',
      message: artifact.errorMessage ?? 'research provider failed',
    };
  }
  return { ok: true, data: artifact };
}

export async function lookupCurrentArtifact(
  store: ResearchArtifactStore,
  binding: ResearchBinding | undefined,
  landingPageUrl: string | undefined
) {
  if (!binding || !landingPageUrl) return undefined;
  return store.get(binding, inputRevisionForUrl(landingPageUrl));
}
