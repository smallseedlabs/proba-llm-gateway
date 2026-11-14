import type { LimbResult } from '../ports/limbs.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_RESULTS_LIMIT = 8;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseBingRss(xml: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;

  for (const match of xml.matchAll(itemRe)) {
    if (results.length >= maxResults) break;
    const block = match[1] ?? '';
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/i);

    const title = decodeXmlEntities(titleMatch?.[1] ?? '');
    const url = decodeXmlEntities(linkMatch?.[1] ?? '');
    const snippet = decodeXmlEntities(descMatch?.[1] ?? '');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

export async function executeWebSearch(
  query: string,
  maxResults = 5,
  fetchFn: WebSearchFetch = fetch
): Promise<LimbResult> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return { ok: false, code: 'user_input', message: 'web.search query must be at least 2 characters' };
  }
  const limit = Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.trunc(maxResults)));
  const url = `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}&format=rss`;

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ProbaResearchBot/1.0)',
        accept: 'application/rss+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        code: 'search_unavailable',
        message: `Web search returned HTTP ${res.status}`,
      };
    }
    const xml = await res.text();
    const results = parseBingRss(xml, limit);
    return {
      ok: true,
      data: {
        query: trimmed,
        source: 'bing_rss',
        results,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: 'search_unavailable',
      message: err instanceof Error ? err.message : 'Web search failed',
    };
  }
}
