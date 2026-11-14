import type { LimbResult } from '../ports/limbs.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_RESULTS_LIMIT = 8;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '));
}

function resolveResultUrl(rawHref: string): string {
  const href = decodeHtmlEntities(rawHref);
  if (href.startsWith('//')) {
    return resolveResultUrl(`https:${href}`);
  }
  try {
    const parsed = new URL(href, 'https://html.duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg && /^https?:\/\//i.test(uddg)) {
      return uddg;
    }
    if (/^https?:\/\//i.test(parsed.toString())) {
      return parsed.toString();
    }
  } catch {
    return '';
  }
  return '';
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<(?:a|div|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/gi;

  const anchors = [...html.matchAll(anchorRe)];
  const snippets = [...html.matchAll(snippetRe)];

  for (let i = 0; i < anchors.length && results.length < maxResults; i++) {
    const match = anchors[i]!;
    const url = resolveResultUrl(match[1] ?? '');
    const title = stripTags(match[2] ?? '');
    if (!url || !title) continue;
    const snippet = stripTags(snippets[i]?.[1] ?? '');
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
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ProbaResearchBot/1.0)',
        accept: 'text/html',
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
    const html = await res.text();
    const results = parseDuckDuckGoHtml(html, limit);
    return {
      ok: true,
      data: {
        query: trimmed,
        source: 'duckduckgo',
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
