import { describe, expect, it } from 'vitest';
import {
  brandFindingText,
  extractBrandNames,
  extractImageCandidates,
  isOwnSiteUrl,
  parseBrandNameFromFinding,
  resolvePageUrl,
} from './page-assets.js';

const page = 'https://example.com/offer';

describe('page asset extraction', () => {
  it('reads og:site_name and prefers og:image, then twitter, then a large hero', () => {
    const html = `
      <html>
        <head>
          <meta property="og:site_name" content="Small Seed Labs">
          <meta property="og:title" content="Proba | Small Seed Labs">
          <meta property="og:image" content="/og.png">
          <meta name="twitter:image" content="https://cdn.example.com/tw.png">
          <title>Proba | Small Seed Labs</title>
        </head>
        <body>
          <img src="/favicon.ico" width="16" height="16">
          <img class="hero-banner" src="https://example.com/hero.jpg" width="1200" height="630">
        </body>
      </html>`;
    expect(extractBrandNames(html)).toEqual(['Small Seed Labs']);
    expect(extractImageCandidates(html, page).map((c) => c.kind)).toEqual(['og:image', 'twitter:image', 'hero']);
    expect(extractImageCandidates(html, page).map((c) => c.url)).toEqual([
      'https://example.com/og.png',
      'https://cdn.example.com/tw.png',
      'https://example.com/hero.jpg',
    ]);
  });

  it('drops data URLs, skips icon-like images, and resolves relative hero src', () => {
    const html = `
      <img src="data:image/png;base64,aaa">
      <img src="/sprite.png" class="icon">
      <img src="../media/wide.png" width="900" height="400">
    `;
    expect(extractImageCandidates(html, page)).toEqual([{ kind: 'hero', url: 'https://example.com/media/wide.png' }]);
  });

  it('allows images on the landing site or its subdomains, not a different site', () => {
    expect(isOwnSiteUrl('https://cdn.example.com/og.png', page)).toBe(true);
    expect(isOwnSiteUrl('https://www.example.com/og.png', page)).toBe(true);
    expect(isOwnSiteUrl('https://other.example/og.png', page)).toBe(false);
    expect(resolvePageUrl('javascript:alert(1)', page)).toBeUndefined();
  });

  it('round-trips the brand finding text', () => {
    expect(parseBrandNameFromFinding(brandFindingText('Small Seed Labs'))).toBe('Small Seed Labs');
  });
});
