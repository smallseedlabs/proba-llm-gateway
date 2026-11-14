import { describe, expect, it } from 'vitest';
import { probeImage } from './image-probe.js';

/** Minimal IHDR-only PNG with given dimensions (header is enough for the probe). */
export function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('probeImage', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(probeImage(pngHeader(1200, 630))).toEqual({ contentType: 'image/png', width: 1200, height: 630 });
  });

  it('reads GIF, WebP VP8X and JPEG SOF0 dimensions', () => {
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(800, 6);
    gif.writeUInt16LE(420, 8);
    expect(probeImage(gif)).toEqual({ contentType: 'image/gif', width: 800, height: 420 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    webp.write('VP8X', 12, 'ascii');
    webp.writeUIntLE(1199, 24, 3);
    webp.writeUIntLE(629, 27, 3);
    expect(probeImage(webp)).toEqual({ contentType: 'image/webp', width: 1200, height: 630 });

    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x76, 0x04, 0xb0, 0x03, 0x00, 0x00, 0x00,
    ]);
    expect(probeImage(jpeg)).toEqual({ contentType: 'image/jpeg', width: 1200, height: 630 });
  });

  it('refuses truncated or unknown bytes', () => {
    expect(probeImage(Buffer.from('not-an-image'))).toBeUndefined();
    expect(probeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});
