/**
 * Read width, height and a sniffed content-type from the first bytes of a public image.
 * Used only to validate landing-page images before they become research sources.
 * No decoder or image-generation path.
 */

export interface ImageProbe {
  contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
}

export function probeImage(buf: Buffer): ImageProbe | undefined {
  if (buf.length < 10) return undefined;
  return probePng(buf) ?? probeGif(buf) ?? probeWebp(buf) ?? probeJpeg(buf);
}

function u32be(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function u16le(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function u24le(buf: Buffer, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16);
}

function probePng(buf: Buffer): ImageProbe | undefined {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return undefined;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = u32be(buf, 16);
  const height = u32be(buf, 20);
  if (width < 1 || height < 1) return undefined;
  return { contentType: 'image/png', width, height };
}

function probeGif(buf: Buffer): ImageProbe | undefined {
  const header = buf.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return undefined;
  if (buf.length < 10) return undefined;
  const width = u16le(buf, 6);
  const height = u16le(buf, 8);
  if (width < 1 || height < 1) return undefined;
  return { contentType: 'image/gif', width, height };
}

function probeWebp(buf: Buffer): ImageProbe | undefined {
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return undefined;
  }
  const kind = buf.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (kind === 'VP8X' && buf.length >= 30) {
    width = u24le(buf, 24) + 1;
    height = u24le(buf, 27) + 1;
  } else if (kind === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else if (kind === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else {
    return undefined;
  }
  if (width < 1 || height < 1) return undefined;
  return { contentType: 'image/webp', width, height };
}

function probeJpeg(buf: Buffer): ImageProbe | undefined {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 3 >= buf.length) return undefined;
    const size = buf.readUInt16BE(i + 2);
    if (size < 2) return undefined;
    // SOF0 / SOF1 / SOF2 (baseline, extended, progressive)
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (i + 8 >= buf.length) return undefined;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (width < 1 || height < 1) return undefined;
      return { contentType: 'image/jpeg', width, height };
    }
    i += 2 + size;
  }
  return undefined;
}
