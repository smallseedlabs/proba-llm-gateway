import { describe, expect, it } from 'vitest';
import { executeWebSearch, parseDuckDuckGoHtml } from './web-search.js';

const SAMPLE_HTML = `
<div class="result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbusiness.reddithelp.com%2Fminimum-budget">Reddit Ads Minimum Budget</a>
  </h2>
  <a class="result__snippet" href="#">Minimum daily budget on Reddit Ads is $5 per day.</a>
</div>
`;

describe('web-search', () => {
  it('parses DuckDuckGo HTML results and unwraps uddg redirect URLs', () => {
    const results = parseDuckDuckGoHtml(SAMPLE_HTML, 5);
    expect(results).toEqual([
      {
        title: 'Reddit Ads Minimum Budget',
        url: 'https://business.reddithelp.com/minimum-budget',
        snippet: 'Minimum daily budget on Reddit Ads is $5 per day.',
      },
    ]);
  });

  it('executes web.search with injected fetch and returns structured results', async () => {
    const mockFetch = async () =>
      new Response(SAMPLE_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    const result = await executeWebSearch('reddit ads minimum daily budget', 3, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      query: 'reddit ads minimum daily budget',
      source: 'duckduckgo',
      results: [
        {
          title: 'Reddit Ads Minimum Budget',
          url: 'https://business.reddithelp.com/minimum-budget',
        },
      ],
    });
  });

  it('fails closed cleanly when search endpoint returns non-200', async () => {
    const mockFetch = async () => new Response('rate limited', { status: 429 });
    const result = await executeWebSearch('reddit ads minimum daily budget', 3, mockFetch);
    expect(result).toEqual({
      ok: false,
      code: 'search_unavailable',
      message: 'Web search returned HTTP 429',
    });
  });
});
