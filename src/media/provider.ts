import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type MediaKind = 'image' | 'video';
export type MediaAspectRatio = '1:1' | '4:5' | '9:16' | '16:9';
export type MediaQuality = 'fast' | 'high';
export type MediaSource = 'auto' | 'ai' | 'stock';

export interface MediaGenerateInput {
  kind: MediaKind;
  prompt: string;
  searchQuery?: string;
  aspectRatio?: MediaAspectRatio;
  quality?: MediaQuality;
  source?: MediaSource;
  sourceImageUrl?: string;
  durationSeconds?: 5 | 10;
}

export interface GeneratedMediaAsset {
  assetId: string;
  kind: MediaKind;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  aspectRatio: MediaAspectRatio;
  provider: 'fal' | 'pexels';
  model: string;
  prompt: string;
}

export type MediaGenerateOutcome =
  | { ok: true; asset: GeneratedMediaAsset }
  | { ok: false; code: 'media_unconfigured' | 'media_failed' | 'invalid_input'; message: string };

export interface MediaProviderConfig {
  falKey?: string;
  pexelsApiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  }
  return (env[name] ?? '').trim();
}

export function mediaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MediaProviderConfig {
  return {
    falKey: readSecret(env, 'FAL_KEY') || undefined,
    pexelsApiKey: readSecret(env, 'PEXELS_API_KEY') || undefined,
    timeoutMs: 90_000,
  };
}

function falImageSize(aspectRatio: MediaAspectRatio): string | { width: number; height: number } {
  switch (aspectRatio) {
    case '1:1':
      return 'square_hd';
    case '4:5':
      return { width: 1024, height: 1280 };
    case '9:16':
      return 'portrait_16_9';
    case '16:9':
      return 'landscape_16_9';
  }
}

function pexelsOrientation(aspectRatio: MediaAspectRatio): 'square' | 'portrait' | 'landscape' {
  if (aspectRatio === '1:1') return 'square';
  if (aspectRatio === '4:5' || aspectRatio === '9:16') return 'portrait';
  return 'landscape';
}

async function generateWithFal(
  input: MediaGenerateInput,
  falKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<MediaGenerateOutcome> {
  const aspectRatio = input.aspectRatio ?? (input.kind === 'video' ? '9:16' : '1:1');
  if (input.kind === 'image') {
    const model = input.quality === 'high' ? 'fal-ai/flux-pro/v1.1' : 'fal-ai/flux/schnell';
    const res = await fetchImpl(`https://fal.run/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: input.prompt,
        image_size: falImageSize(aspectRatio),
        num_images: 1,
        enable_safety_checker: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, code: 'media_failed', message: `fal.ai image failed (${res.status}): ${errText.slice(0, 200)}` };
    }
    const body = (await res.json()) as { images?: Array<{ url?: string; width?: number; height?: number; content_type?: string }> };
    const img = body.images?.[0];
    if (!img?.url) {
      return { ok: false, code: 'media_failed', message: 'fal.ai returned no image URL' };
    }
    return {
      ok: true,
      asset: {
        assetId: `ast_${randomUUID()}`,
        kind: 'image',
        url: img.url,
        mimeType: img.content_type ?? 'image/jpeg',
        ...(img.width ? { width: img.width } : {}),
        ...(img.height ? { height: img.height } : {}),
        aspectRatio,
        provider: 'fal',
        model,
        prompt: input.prompt,
      },
    };
  }

  // Video via Kling v2.5 Turbo on fal.ai queue
  const model = input.sourceImageUrl
    ? 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video'
    : 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video';
  const duration = String(input.durationSeconds ?? 5);
  const submitRes = await fetchImpl(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: input.prompt,
      duration,
      aspect_ratio: aspectRatio === '4:5' ? '9:16' : aspectRatio,
      ...(input.sourceImageUrl ? { image_url: input.sourceImageUrl } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => '');
    return { ok: false, code: 'media_failed', message: `fal.ai video submit failed (${submitRes.status}): ${errText.slice(0, 200)}` };
  }
  const queued = (await submitRes.json()) as { status_url?: string; response_url?: string; video?: { url?: string } };
  if (queued.video?.url) {
    return {
      ok: true,
      asset: {
        assetId: `ast_${randomUUID()}`,
        kind: 'video',
        url: queued.video.url,
        mimeType: 'video/mp4',
        durationSeconds: Number(duration),
        aspectRatio,
        provider: 'fal',
        model,
        prompt: input.prompt,
      },
    };
  }
  if (!queued.status_url || !queued.response_url) {
    return { ok: false, code: 'media_failed', message: 'fal.ai video queue did not return status/response URLs' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_500));
    const statusRes = await fetchImpl(queued.status_url, {
      headers: { Authorization: `Key ${falKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!statusRes.ok) continue;
    const statusBody = (await statusRes.json()) as { status?: string };
    if (statusBody.status === 'COMPLETED') {
      const finalRes = await fetchImpl(queued.response_url, {
        headers: { Authorization: `Key ${falKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!finalRes.ok) {
        return { ok: false, code: 'media_failed', message: `fal.ai video result fetch failed (${finalRes.status})` };
      }
      const resultBody = (await finalRes.json()) as { video?: { url?: string; content_type?: string } };
      if (!resultBody.video?.url) {
        return { ok: false, code: 'media_failed', message: 'fal.ai video completed with no video URL' };
      }
      return {
        ok: true,
        asset: {
          assetId: `ast_${randomUUID()}`,
          kind: 'video',
          url: resultBody.video.url,
          mimeType: resultBody.video.content_type ?? 'video/mp4',
          durationSeconds: Number(duration),
          aspectRatio,
          provider: 'fal',
          model,
          prompt: input.prompt,
        },
      };
    }
    if (statusBody.status === 'FAILED') {
      return { ok: false, code: 'media_failed', message: 'fal.ai video generation failed' };
    }
  }
  return { ok: false, code: 'media_failed', message: 'fal.ai video generation timed out' };
}

async function fetchFromPexels(
  input: MediaGenerateInput,
  apiKey: string,
  fetchImpl: typeof fetch
): Promise<MediaGenerateOutcome> {
  const aspectRatio = input.aspectRatio ?? (input.kind === 'video' ? '9:16' : '1:1');
  const orientation = pexelsOrientation(aspectRatio);
  const queryText = (input.searchQuery?.trim() || input.prompt).slice(0, 120);
  const query = encodeURIComponent(queryText);

  if (input.kind === 'image') {
    const res = await fetchImpl(`https://api.pexels.com/v1/search?query=${query}&orientation=${orientation}&per_page=3`, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, code: 'media_failed', message: `Pexels image search failed (${res.status})` };
    }
    const body = (await res.json()) as {
      photos?: Array<{ width?: number; height?: number; src?: { large2x?: string; large?: string; original?: string } }>;
    };
    const photo = body.photos?.[0];
    const url = photo?.src?.large2x ?? photo?.src?.large ?? photo?.src?.original;
    if (!url) {
      return { ok: false, code: 'media_failed', message: `No stock photo found on Pexels for "${input.prompt}"` };
    }
    return {
      ok: true,
      asset: {
        assetId: `ast_${randomUUID()}`,
        kind: 'image',
        url,
        mimeType: 'image/jpeg',
        ...(photo?.width ? { width: photo.width } : {}),
        ...(photo?.height ? { height: photo.height } : {}),
        aspectRatio,
        provider: 'pexels',
        model: 'pexels-photo-search',
        prompt: input.prompt,
      },
    };
  }

  const res = await fetchImpl(`https://api.pexels.com/videos/search?query=${query}&orientation=${orientation}&per_page=3`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return { ok: false, code: 'media_failed', message: `Pexels video search failed (${res.status})` };
  }
  const body = (await res.json()) as {
    videos?: Array<{
      duration?: number;
      width?: number;
      height?: number;
      video_files?: Array<{ link?: string; file_type?: string; quality?: string; width?: number; height?: number }>;
    }>;
  };
  const video = body.videos?.[0];
  const file =
    video?.video_files?.find((f) => f.file_type === 'video/mp4' && f.quality === 'hd') ??
    video?.video_files?.find((f) => f.file_type === 'video/mp4') ??
    video?.video_files?.[0];
  if (!file?.link) {
    return { ok: false, code: 'media_failed', message: `No stock video found on Pexels for "${input.prompt}"` };
  }
  return {
    ok: true,
    asset: {
      assetId: `ast_${randomUUID()}`,
      kind: 'video',
      url: file.link,
      mimeType: file.file_type ?? 'video/mp4',
      ...(file.width ?? video?.width ? { width: file.width ?? video?.width } : {}),
      ...(file.height ?? video?.height ? { height: file.height ?? video?.height } : {}),
      ...(video?.duration ? { durationSeconds: video.duration } : {}),
      aspectRatio,
      provider: 'pexels',
      model: 'pexels-video-search',
      prompt: input.prompt,
    },
  };
}

export async function generateCreativeMedia(
  input: MediaGenerateInput,
  cfg: MediaProviderConfig = mediaConfigFromEnv()
): Promise<MediaGenerateOutcome> {
  const prompt = input.prompt.trim();
  if (prompt.length < 3) {
    return { ok: false, code: 'invalid_input', message: 'prompt must be at least 3 characters' };
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 90_000;
  const source = input.source ?? 'auto';

  if (source === 'ai') {
    if (!cfg.falKey) {
      return { ok: false, code: 'media_unconfigured', message: 'FAL_KEY is not configured for AI media generation.' };
    }
    return generateWithFal({ ...input, prompt }, cfg.falKey, fetchImpl, timeoutMs);
  }

  if (source === 'stock') {
    if (!cfg.pexelsApiKey) {
      return { ok: false, code: 'media_unconfigured', message: 'PEXELS_API_KEY is not configured for stock media search.' };
    }
    return fetchFromPexels({ ...input, prompt }, cfg.pexelsApiKey, fetchImpl);
  }

  // Stock-first waterfall in 'auto': try free stock (Pexels) before spending fal.ai credits,
  // except for image-to-video animation which requires fal.ai.
  if (cfg.pexelsApiKey && !input.sourceImageUrl) {
    const stockOutcome = await fetchFromPexels({ ...input, prompt }, cfg.pexelsApiKey, fetchImpl);
    if (stockOutcome.ok || !cfg.falKey) {
      return stockOutcome;
    }
  }
  if (cfg.falKey) {
    return generateWithFal({ ...input, prompt }, cfg.falKey, fetchImpl, timeoutMs);
  }
  return {
    ok: false,
    code: 'media_unconfigured',
    message:
      'No media provider configured. Set FAL_KEY (fal.ai FLUX + Kling) or PEXELS_API_KEY (free stock) to generate or fetch ad images/videos.',
  };
}

const WIKI_STOPWORDS = new Set([
  'editorial', 'documentary', 'photo', 'photograph', 'vertical', 'horizontal', 'square',
  'shot', 'over', 'the', 'shoulder', 'with', 'and', 'for', 'from', 'into', 'high',
  'resolution', 'lighting', 'natural', 'minimal', 'modern', 'clean', 'aesthetic', 'ugc',
  '4:5', '9:16', '1:1', '16:9', 'no', 'text', 'garbled', 'aspect', 'ratio',
]);

function extractStockKeywords(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !WIKI_STOPWORDS.has(w));
}

export async function fetchWikimediaStock(
  queryText: string,
  aspectRatio: MediaAspectRatio = '4:5',
  fetchImpl: typeof fetch = fetch
): Promise<MediaGenerateOutcome> {
  const words = extractStockKeywords(queryText);
  const attempts = [
    words.slice(0, 3).join(' '),
    words.slice(0, 2).join(' '),
    words[0] || '',
  ].filter((q, idx, arr) => q.length >= 2 && arr.indexOf(q) === idx);
  if (attempts.length === 0) return { ok: false, code: 'invalid_input', message: 'query is required' };

  for (const q of attempts) {
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(q)}&gsrlimit=8&prop=imageinfo&iiprop=url|mime|size&format=json`;
    try {
      const res = await fetchImpl(apiUrl, {
        headers: { 'User-Agent': 'ProbaMediaAgent/1.0 (+https://smallseedlabs.com)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        query?: {
          pages?: Record<
            string,
            { imageinfo?: Array<{ url?: string; mime?: string; width?: number; height?: number }> }
          >;
        };
      };
      const pages = Object.values(body.query?.pages ?? {});
      for (const p of pages) {
        const info = p.imageinfo?.[0];
        if (!info?.url || !info.mime) continue;
        if (!/^image\/(jpeg|jpg|png|webp)$/i.test(info.mime)) continue;
        if ((info.width ?? 0) < 400 || (info.height ?? 0) < 300) continue;
        return {
          ok: true,
          asset: {
            assetId: `ast_${randomUUID()}`,
            kind: 'image',
            url: info.url,
            mimeType: info.mime,
            ...(info.width ? { width: info.width } : {}),
            ...(info.height ? { height: info.height } : {}),
            aspectRatio,
            provider: 'pexels',
            model: 'wikimedia-commons-stock',
            prompt: queryText,
          },
        };
      }
    } catch {
      // try shorter keyword fallback
    }
  }
  return { ok: false, code: 'media_failed', message: `No suitable Wikimedia stock image found for "${attempts[0]}"` };
}
