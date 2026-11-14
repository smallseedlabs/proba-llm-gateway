import { describe, expect, it } from 'vitest';
import { executeWebSearch, parseBingRss } from './web-search.js';

const SAMPLE_RSS = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0"><channel>
  <item>
    <title>Reddit Ads Minimum Budget &amp; Spend</title>
    <link>https://business.reddithelp.com/minimum-budget</link>
    <description>Minimum daily budget on Reddit Ads is $5 per day.</description>
  </item>
</channel></rss>
`;

describe('web-search', () => {
  it('parses Bing RSS items cleanly', () => {
    const results = parseBingRss(SAMPLE_RSS, 5);
    expect(results).toEqual([
      {
        title: 'Reddit Ads Minimum Budget & Spend',
        url: 'https://business.reddithelp.com/minimum-budget',
        snippet: 'Minimum daily budget on Reddit Ads is $5 per day.',
      },
    ]);
  });

  it('executes web.search with injected fetch and returns structured results', async () => {
    const mockFetch = async () =>
      new Response(SAMPLE_RSS, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      });

    const result = await executeWebSearch('reddit ads minimum daily budget', 3, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      query: 'reddit ads minimum daily budget',
      source: 'bing_rss',
      results: [
        {
          title: 'Reddit Ads Minimum Budget & Spend',
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
