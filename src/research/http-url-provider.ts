/**
 * Opt-in public-URL fetch. Disabled unless RESEARCH_HTTP_FETCH=true.
 * Redirects refused. Resolved addresses must be public. Body is untrusted
 * excerpt only — never a scripted success story or invented citation.
 */

import { createHash } from 'node:crypto';
import type { ResearchProviderPort, ResearchProviderResult, ResearchQuery } from '../ports/research.js';
import type { ResearchFinding, ResearchSource, ResearchUnknown } from '../types/research.js';
import {
  brandFindingText,
  extractBrandNames,
  extractImageCandidates,
  imageSourceExcerpt,
  imageSourceId,
  isOwnSiteUrl,
} from './page-assets.js';
import { probeImage } from './image-probe.js';
import { assertResolvedPublic, parsePublicHttpUrl, UnsafeUrlError } from './ssrf.js';

export const DEFAULT_IMAGE_MAX_BYTES = 3_000_000;
export const MAX_LOOKUP_URLS = 3;
export const MIN_IMAGE_WIDTH = 600;
export const MIN_IMAGE_HEIGHT = 315;

export function imageMeetsSize(width: number, height: number): boolean {
  return (
    width <= 10_000 &&
    height <= 10_000 &&
    ((width >= MIN_IMAGE_WIDTH && height >= MIN_IMAGE_HEIGHT) || (width >= MIN_IMAGE_HEIGHT && height >= MIN_IMAGE_WIDTH))
  );
}

export interface HttpUrlResearchOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Cap for a single landing-page image fetch (separate from the HTML cap). */
  imageMaxBytes?: number;
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
  private readonly imageMaxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAddresses: (url: URL) => Promise<string[]>;

  constructor(options: HttpUrlResearchOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxBytes = options.maxBytes;
    this.imageMaxBytes = options.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES;
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
      const html = buf.toString('utf8');
      const excerpt = untrustedExcerpt(html);
      const fetchedAt = new Date().toISOString();
      const sources: ResearchSource[] = [
        {
          sourceId: SOURCE_ID,
          kind: 'http_url',
          url: url.toString(),
          fetchedAt,
          contentType,
          sha256,
          excerpt: excerpt || undefined,
        },
      ];
      const findings: ResearchFinding[] = excerpt
        ? [{ id: 'f1', text: excerpt.slice(0, 500), sourceIds: [SOURCE_ID] }]
        : [];
      const unknowns: ResearchUnknown[] = excerpt
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

      const brands = extractBrandNames(html);
      brands.forEach((name, i) => {
        findings.push({ id: `brand-${i + 1}`, text: brandFindingText(name), sourceIds: [SOURCE_ID] });
      });

      const imageSources = await this.collectPageImages(url.toString(), html, controller.signal);
      sources.push(...imageSources);
      if (imageSources.length === 0) {
        unknowns.push({
          id: 'u-images',
          text: 'No validated image was found on the operator landing page domain (og:image, twitter:image, or a large hero). A TEXT post can still be drafted.',
        });
      }

      const lookups = await this.collectLookups(query.lookupUrls ?? [], controller.signal);
      sources.push(...lookups.sources);
      findings.push(...lookups.findings);
      unknowns.push(...lookups.unknowns);

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

  private async fetchPublic(
    rawUrl: string,
    signal: AbortSignal,
    accept: string,
    maxBytes: number
  ): Promise<{ ok: true; url: URL; buf: Buffer; contentType: string | undefined } | { ok: false; code: string; message: string }> {
    let url: URL;
    try {
      url = parsePublicHttpUrl(rawUrl);
      await this.resolveAddresses(url);
    } catch (err) {
      const message = err instanceof UnsafeUrlError ? err.message : 'URL is not fetchable';
      return { ok: false, code: 'ssrf_blocked', message };
    }
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: { accept },
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, code: 'ssrf_blocked', message: 'redirects are not followed' };
      }
      if (!response.ok) {
        return { ok: false, code: 'fetch_failed', message: `fetch returned HTTP ${response.status}` };
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > maxBytes) {
        return { ok: false, code: 'untrusted_content', message: 'body exceeded the untrusted content size cap' };
      }
      return { ok: true, url, buf, contentType: response.headers.get('content-type') ?? undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'fetch failed';
      if (/redirect/i.test(message)) {
        return { ok: false, code: 'ssrf_blocked', message: 'redirects are not followed' };
      }
      return { ok: false, code: 'fetch_failed', message };
    }
  }

  private async collectPageImages(landingPageUrl: string, html: string, signal: AbortSignal): Promise<ResearchSource[]> {
    const sources: ResearchSource[] = [];
    for (const candidate of extractImageCandidates(html, landingPageUrl)) {
      if (!isOwnSiteUrl(candidate.url, landingPageUrl)) continue;
      const fetched = await this.fetchPublic(candidate.url, signal, 'image/*,*/*;q=0.1', this.imageMaxBytes);
      if (!fetched.ok) continue;
      const header = (fetched.contentType ?? '').split(';')[0]!.trim().toLowerCase();
      if (header && header !== 'application/octet-stream' && !header.startsWith('image/')) continue;
      const probe = probeImage(fetched.buf);
      if (!probe || !imageMeetsSize(probe.width, probe.height)) continue;
      if (header && header !== 'application/octet-stream' && header !== probe.contentType) continue;
      sources.push({
        sourceId: imageSourceId(candidate.kind),
        kind: 'http_url',
        url: fetched.url.toString(),
        fetchedAt: new Date().toISOString(),
        contentType: probe.contentType,
        sha256: createHash('sha256').update(fetched.buf).digest('hex'),
        excerpt: imageSourceExcerpt(candidate.kind, probe.width, probe.height),
      });
    }
    return sources;
  }

  private async collectLookups(
    rawUrls: readonly string[],
    signal: AbortSignal
  ): Promise<{ sources: ResearchSource[]; findings: ResearchFinding[]; unknowns: ResearchUnknown[] }> {
    const sources: ResearchSource[] = [];
    const findings: ResearchFinding[] = [];
    const unknowns: ResearchUnknown[] = [];
    for (const [i, raw] of rawUrls.slice(0, MAX_LOOKUP_URLS).entries()) {
      const fetched = await this.fetchPublic(raw, signal, 'text/html,text/plain;q=0.9,*/*;q=0.1', this.maxBytes);
      const sourceId = `lookup-${i + 1}`;
      if (!fetched.ok) {
        unknowns.push({
          id: `u-${sourceId}`,
          text: `Lookup ${raw} was not used as research (${fetched.code}: ${fetched.message}). Citations were not invented.`,
        });
        continue;
      }
      const excerpt = untrustedExcerpt(fetched.buf.toString('utf8'));
      sources.push({
        sourceId,
        kind: 'http_url',
        url: fetched.url.toString(),
        fetchedAt: new Date().toISOString(),
        contentType: fetched.contentType,
        sha256: createHash('sha256').update(fetched.buf).digest('hex'),
        excerpt: excerpt || undefined,
      });
      if (excerpt) {
        findings.push({ id: `lf-${i + 1}`, text: excerpt.slice(0, 500), sourceIds: [sourceId] });
      } else {
        unknowns.push({ id: `u-${sourceId}`, text: `Lookup ${fetched.url.toString()} had no extractable text.` });
      }
    }
    return { sources, findings, unknowns };
  }
}

function isTagNameBoundary(char: string | undefined): boolean {
  return char === undefined || char === '>' || char === '/' || char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isHtmlWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function indexOfOpenTag(html: string, tag: string, from = 0): number {
  const needle = `<${tag.toLowerCase()}`;
  const lower = html.toLowerCase();
  let searchFrom = from;
  while (searchFrom < html.length) {
    const at = lower.indexOf(needle, searchFrom);
    if (at < 0) return -1;
    if (isTagNameBoundary(html[at + needle.length])) return at;
    searchFrom = at + 1;
  }
  return -1;
}

/** Start index of `</tag` whose `>` may be preceded by whitespace (`</script >`). */
function indexOfCloseTag(html: string, tag: string, from: number): { start: number; after: number } | undefined {
  const needle = `</${tag.toLowerCase()}`;
  const lower = html.toLowerCase();
  let searchFrom = from;
  while (searchFrom < html.length) {
    const at = lower.indexOf(needle, searchFrom);
    if (at < 0) return undefined;
    let i = at + needle.length;
    while (i < html.length && isHtmlWhitespace(html[i])) i += 1;
    if (html[i] === '>') return { start: at, after: i + 1 };
    searchFrom = at + 1;
  }
  return undefined;
}

/**
 * Drop a named element's body from untrusted HTML before excerpting.
 *
 * Closing tags may include whitespace before `>` (`</script >`, `</style\t>`).
 * A replace() of `</script>` without optional whitespace is not a filter
 * (CodeQL js/bad-tag-filter). Unclosed elements drop the remainder (fail
 * closed). This does not make the excerpt trusted.
 */
function dropElementBodies(html: string, tag: string): string {
  let remaining = html;
  for (let n = 0; n < 32; n += 1) {
    const start = indexOfOpenTag(remaining, tag);
    if (start < 0) return remaining;
    const gt = remaining.indexOf('>', start);
    if (gt < 0) return remaining.slice(0, start);
    const close = indexOfCloseTag(remaining, tag, gt + 1);
    if (!close) return remaining.slice(0, start);
    remaining = `${remaining.slice(0, start)} ${remaining.slice(close.after)}`;
  }
  return remaining;
}

function innerText(html: string, tag: string): string {
  const start = indexOfOpenTag(html, tag);
  if (start < 0) return '';
  const gt = html.indexOf('>', start);
  if (gt < 0) return '';
  const close = indexOfCloseTag(html, tag, gt + 1);
  if (!close) return '';
  return html.slice(gt + 1, close.start);
}

function untrustedExcerpt(html: string): string {
  const noScript = dropElementBodies(dropElementBodies(html, 'script'), 'style');
  const title = innerText(noScript, 'title');
  const text = `${title} ${noScript.replace(/<[^>]+>/g, ' ')}`.replace(/\s+/g, ' ').trim();
  return text.slice(0, 2000);
}
