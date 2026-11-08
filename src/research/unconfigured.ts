import type { ResearchProviderPort, ResearchProviderResult, ResearchQuery } from '../ports/research.js';

/**
 * Default research provider. Fails closed. Does not invent findings or citations.
 */
export class UnconfiguredResearchProvider implements ResearchProviderPort {
  readonly name = 'research-unconfigured';
  readonly configured = false;

  async research(_query: ResearchQuery): Promise<ResearchProviderResult> {
    return {
      ok: false,
      code: 'research_unconfigured',
      message:
        'Research provider is not configured (RESEARCH_HTTP_FETCH is off). Context retrieval is not web research and was not used as a citation source',
    };
  }
}
