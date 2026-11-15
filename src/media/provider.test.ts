import { describe, expect, it } from 'vitest';
import { generateCreativeMedia } from './provider.js';

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
