/**
 * Untrusted HTML helpers: brand names and image URLs advertised on the operator's landing page.
 * Candidates are not used until they are fetched, probed, and confirmed to be on the page's own site.
 */

export const IMAGE_CANDIDATE_KINDS = ['og:image', 'twitter:image', 'hero'] as const;
export type ImageCandidateKind = (typeof IMAGE_CANDIDATE_KINDS)[number];

export interface ImageCandidate {
  kind: ImageCandidateKind;
  url: string;
}

const ICONISH = /favicon|icon|sprite|pixel|tracking|1x1|badge|avatar/i;

export function hostOf(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** Same registrable site: exact host (www-stripped) or a subdomain of it. */
export function isOwnSiteUrl(candidateUrl: string, landingPageUrl: string): boolean {
  const imageHost = hostOf(candidateUrl);
  const landingHost = hostOf(landingPageUrl);
  if (!imageHost || !landingHost) return false;
  return imageHost === landingHost || imageHost.endsWith(`.${landingHost}`) || landingHost.endsWith(`.${imageHost}`);
}

export function resolvePageUrl(raw: string, baseUrl: string): string | undefined {
  const value = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!value || value.startsWith('data:') || value.startsWith('javascript:')) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return (m?.[1] ?? m?.[2] ?? m?.[3])?.trim() || undefined;
}

function* tags(html: string, tagName: string): Generator<string> {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    yield m[0];
  }
}

function metaContent(html: string, keys: readonly string[]): string | undefined {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  for (const tag of tags(html, 'meta')) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (!want.has(key)) continue;
    const content = attr(tag, 'content');
    if (content) return content;
  }
  return undefined;
}

function innerText(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i');
  const m = html.match(re);
  if (!m) return '';
  return (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractBrandNames(html: string): string[] {
  const names: string[] = [];
  const push = (value: string | undefined) => {
    const n = value?.replace(/\s+/g, ' ').trim();
    if (!n || n.length < 2 || n.length > 120) return;
    if (names.some((existing) => existing.toLowerCase() === n.toLowerCase())) return;
    names.push(n);
  };
  push(metaContent(html, ['og:site_name', 'application-name']));
  const title = metaContent(html, ['og:title', 'twitter:title']) || innerText(html, 'title');
  if (title) {
    const parts = title.split(/\s*[|\u2013\u2014-]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) push(parts[parts.length - 1]);
  }
  return names.slice(0, 4);
}

function heroSrc(html: string, baseUrl: string): string | undefined {
  const scored: Array<{ score: number; url: string }> = [];
  for (const tag of tags(html, 'img')) {
    const src = attr(tag, 'src') ?? attr(tag, 'data-src');
    const resolved = src ? resolvePageUrl(src, baseUrl) : undefined;
    if (!resolved || ICONISH.test(resolved) || ICONISH.test(tag)) continue;
    const width = Number(attr(tag, 'width') ?? '');
    const height = Number(attr(tag, 'height') ?? '');
    const hint = `${attr(tag, 'id') ?? ''} ${attr(tag, 'class') ?? ''} ${attr(tag, 'alt') ?? ''}`;
    let score = 1;
    if (/hero|banner|cover|og|masthead/i.test(hint)) score += 8;
    if (width >= 600 && height >= 300) score += 4;
    else if (width >= 200 || height >= 200) score += 1;
    else if (width > 0 && width < 64) continue;
    scored.push({ score, url: resolved });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.url;
}

/**
 * Prefer og:image, then twitter:image, then a large hero <img>. Duplicates (same resolved URL) are dropped.
 */
export function extractImageCandidates(html: string, landingPageUrl: string): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: ImageCandidateKind, raw: string | undefined) => {
    const url = raw ? resolvePageUrl(raw, landingPageUrl) : undefined;
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ kind, url });
  };
  add('og:image', metaContent(html, ['og:image', 'og:image:url']));
  add('twitter:image', metaContent(html, ['twitter:image', 'twitter:image:src']));
  add('hero', heroSrc(html, landingPageUrl));
  return out;
}

export const PAGE_IMAGE_SOURCE_PREFIX = 'img-';

export function imageSourceId(kind: ImageCandidateKind): string {
  return `${PAGE_IMAGE_SOURCE_PREFIX}${kind.replace(':', '-')}`;
}

export function isPageImageSourceId(sourceId: string): boolean {
  return sourceId.startsWith(PAGE_IMAGE_SOURCE_PREFIX);
}

export function brandFindingText(name: string): string {
  return `The landing page names the brand as "${name}".`;
}

export function parseBrandNameFromFinding(text: string): string | undefined {
  const m = text.match(/names the brand as "([^"]+)"/i);
  const name = m?.[1]?.trim();
  return name || undefined;
}

export function imageSourceExcerpt(kind: ImageCandidateKind, width: number, height: number): string {
  return `page image (${kind}) ${width}x${height}`;
}

export function parseImageExcerpt(excerpt: string | undefined): { width?: number; height?: number } {
  if (!excerpt) return {};
  const m = excerpt.match(/(\d+)x(\d+)/);
  if (!m) return {};
  return { width: Number(m[1]), height: Number(m[2]) };
}
