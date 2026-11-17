import { describe, expect, it } from 'vitest';
import { fetchWikimediaStock, generateCreativeMedia } from './provider.js';

describe('generateCreativeMedia', () => {
  it('fails closed when neither FAL_KEY nor PEXELS_API_KEY is configured', async () => {
    const res = await generateCreativeMedia({ kind: 'image', prompt: 'modern minimalist SaaS dashboard' }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('media_unconfigured');
  });

  it('generates an image via fal.ai FLUX when FAL_KEY is configured', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      expect(String(input)).toContain('https://fal.run/fal-ai/flux/schnell');
      return new Response(
        JSON.stringify({
          images: [{ url: 'https://v3.fal.media/files/monkey/test-ad.jpg', width: 1024, height: 1024, content_type: 'image/jpeg' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const res = await generateCreativeMedia(
      { kind: 'image', prompt: 'bold studio shot of espresso machine', aspectRatio: '1:1' },
      { falKey: 'fal-test-key', fetchImpl: fakeFetch }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.asset.provider).toBe('fal');
      expect(res.asset.model).toBe('fal-ai/flux/schnell');
      expect(res.asset.url).toBe('https://v3.fal.media/files/monkey/test-ad.jpg');
      expect(res.asset.assetId).toMatch(/^ast_/);
    }
  });

  it('fetches stock video from Pexels when source is stock or only PEXELS_API_KEY is set', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      expect(String(input)).toContain('https://api.pexels.com/videos/search');
      return new Response(
        JSON.stringify({
          videos: [
            {
              duration: 8,
              width: 1080,
              height: 1920,
              video_files: [{ link: 'https://videos.pexels.com/video-files/123/hd.mp4', file_type: 'video/mp4', quality: 'hd' }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const res = await generateCreativeMedia(
      { kind: 'video', prompt: 'founder working on laptop', aspectRatio: '9:16' },
      { pexelsApiKey: 'pexels-test-key', fetchImpl: fakeFetch }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.asset.provider).toBe('pexels');
      expect(res.asset.kind).toBe('video');
      expect(res.asset.url).toBe('https://videos.pexels.com/video-files/123/hd.mp4');
    }
  });
});

describe('fetchWikimediaStock', () => {
  it('strips art-direction stopwords, falls back to shorter queries, and skips SVG/oversized assets', async () => {
    const queries: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const gsrsearch = url.searchParams.get('gsrsearch') ?? '';
      queries.push(gsrsearch);
      if (queries.length === 1) {
        return new Response(JSON.stringify({ query: { pages: {} } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              '1': { imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/icon.svg', mime: 'image/svg+xml', width: 800, height: 800 }] },
              '2': { imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/b/huge.jpg', mime: 'image/jpeg', width: 4000, height: 3000, size: 12_000_000 }] },
              '3': { imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/c/studio.jpg', mime: 'image/jpeg', width: 1200, height: 900, size: 420_000 }] },
            },
          },
        }),
        { status: 200 }
      );
    };

    const res = await fetchWikimediaStock(
      'clean minimalist photography of modern workspace laptop creative studio',
      '4:5',
      fakeFetch
    );
    expect(queries[0]).toBe('workspace laptop creative');
    expect(queries[1]).toBe('workspace laptop');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.asset.url).toBe('https://upload.wikimedia.org/wikipedia/commons/c/studio.jpg');
      expect(res.asset.model).toBe('wikimedia-commons-stock');
    }
  });
});
