/**
 * Opt-in public-URL fetch. Disabled unless RESEARCH_HTTP_FETCH=true.
 * Redirects refused. Resolved addresses must be public. Body is untrusted
 * excerpt only — never a scripted success story or invented citation.
 */

import { createHash } from 'node:crypto';
import type { ResearchProviderPort, ResearchProviderResult, ResearchQuery } from '../ports/research.js';
import { assertResolvedPublic, parsePublicHttpUrl, UnsafeUrlError } from './ssrf.js';

export interface HttpUrlResearchOptions {
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  /** Test-only. Production uses DNS + public-IP checks. */
  resolveAddresses?: (url: URL) => Promise<string[]>;
}

const SOURCE_ID = 'page-1';

export class HttpUrlResearchProvider implements ResearchProviderPort {
  readonly name = 'research-http-url';
  readonly configured = true;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAddresses: (url: URL) => Promise<string[]>;

  constructor(options: HttpUrlResearchOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxBytes = options.maxBytes;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveAddresses = options.resolveAddresses ?? assertResolvedPublic;
  }

  async research(query: ResearchQuery): Promise<ResearchProviderResult> {
    let url: URL;
    try {
      url = parsePublicHttpUrl(query.landingPageUrl);
      await this.resolveAddresses(url);
    } catch (err) {
      const message = err instanceof UnsafeUrlError ? err.message : 'landing page URL is not fetchable';
      return { ok: false, code: 'ssrf_blocked', message };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuter = () => controller.abort();
    query.signal?.addEventListener('abort', onOuter, { once: true });
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, code: 'ssrf_blocked', message: 'landing page redirects are not followed' };
      }
      if (!response.ok) {
        return {
          ok: false,
          code: 'fetch_failed',
          message: `landing page fetch returned HTTP ${response.status}; contents were not used as research`,
        };
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > this.maxBytes) {
        return { ok: false, code: 'untrusted_content', message: 'landing page exceeded the untrusted content size cap' };
      }
      const contentType = response.headers.get('content-type') ?? undefined;
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const excerpt = untrustedExcerpt(buf.toString('utf8'));
      const fetchedAt = new Date().toISOString();
      const sources = [
        {
          sourceId: SOURCE_ID,
          kind: 'http_url' as const,
          url: url.toString(),
          fetchedAt,
          contentType,
          sha256,
          excerpt: excerpt || undefined,
        },
      ];
      const findings = excerpt
        ? [{ id: 'f1', text: excerpt.slice(0, 500), sourceIds: [SOURCE_ID] }]
        : [];
      const unknowns = excerpt
        ? [
            {
              id: 'u1',
              text: 'Page bytes are untrusted user-controlled content. Audience, budget, and offer claims were not verified by this fetch.',
            },
          ]
        : [{ id: 'u1', text: 'The fetched page had no extractable text. Product, audience, and offer remain unknown.' }];
      const assumptions = [
        {
          id: 'a1',
          text: `User-supplied landing URL ${url.toString()} is the campaign destination for this input revision.`,
          basis: 'user_input' as const,
        },
      ];
      return { ok: true, sources, findings, assumptions, unknowns };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'landing page fetch failed';
      if (/redirect/i.test(message)) {
        return { ok: false, code: 'ssrf_blocked', message: 'landing page redirects are not followed' };
      }
      return { ok: false, code: 'fetch_failed', message };
    } finally {
      clearTimeout(timer);
      query.signal?.removeEventListener('abort', onOuter);
    }
  }
}

function untrustedExcerpt(html: string): string {
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const title = noScript.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const text = `${title} ${noScript.replace(/<[^>]+>/g, ' ')}`.replace(/\s+/g, ' ').trim();
  return text.slice(0, 2000);
}
