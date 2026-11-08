import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { ResearchArtifactStore, ResearchProviderPort, ResearchProviderResult, ResearchQuery } from '../ports/research.js';
import type { ResearchArtifact } from '../types/research.js';
import { inputRevisionForUrl, type ResearchBinding } from '../research/input.js';
import { TEST_GOAL_ID, TEST_THREAD_ID, TEST_USER_ID } from './fixtures.js';

export const TEST_LANDING_URL = 'https://example.com/offer';

export function testBinding(overrides: Partial<ResearchBinding> = {}): ResearchBinding {
  return {
    workspaceId: 'seedbed',
    userId: TEST_USER_ID,
    goalId: TEST_GOAL_ID,
    threadId: TEST_THREAD_ID,
    ...overrides,
  };
}

export function sourcedPageResult(url: string, excerpt = 'Example product page'): Extract<ResearchProviderResult, { ok: true }> {
  return {
    ok: true,
    sources: [
      {
        sourceId: 'page-1',
        kind: 'http_url',
        url,
        fetchedAt: new Date().toISOString(),
        sha256: createHash('sha256').update(excerpt).digest('hex'),
        excerpt,
      },
    ],
    findings: [{ id: 'f1', text: excerpt, sourceIds: ['page-1'] }],
    assumptions: [{ id: 'a1', text: `User-supplied landing URL ${url}`, basis: 'user_input' }],
    unknowns: [{ id: 'u1', text: 'Audience and offer were not verified beyond the fetched excerpt' }],
  };
}

/** Test-only provider. Production runtime never registers this class. */
export class SourcedResearchProvider implements ResearchProviderPort {
  readonly name = 'research-test-stub';
  readonly configured = true;
  calls = 0;
  result: ResearchProviderResult | ((query: ResearchQuery) => ResearchProviderResult) = sourcedPageResult(TEST_LANDING_URL);

  async research(query: ResearchQuery): Promise<ResearchProviderResult> {
    this.calls += 1;
    return typeof this.result === 'function' ? this.result(query) : this.result;
  }
}

export async function seedAcceptedResearch(
  store: ResearchArtifactStore,
  url = TEST_LANDING_URL,
  binding: ResearchBinding = testBinding()
): Promise<ResearchArtifact> {
  const page = sourcedPageResult(url);
  const artifact: ResearchArtifact = {
    artifactId: randomUUID(),
    version: 1,
    workspaceId: binding.workspaceId,
    userId: binding.userId,
    goalId: binding.goalId,
    threadId: binding.threadId,
    landingPageUrl: url,
    inputRevision: inputRevisionForUrl(url),
    status: 'accepted',
    providerName: 'research-test-stub',
    sources: page.sources,
    findings: page.findings,
    assumptions: page.assumptions,
    unknowns: page.unknowns,
    acceptedAt: new Date().toISOString(),
    acceptedByAskId: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.put(artifact);
  return artifact;
}

export function userLanding(url = TEST_LANDING_URL): { landingPageUrl: string } {
  return { landingPageUrl: url };
}
