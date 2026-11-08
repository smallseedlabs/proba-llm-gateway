import { gzipSync } from 'node:zlib';

/** Gzip size of UTF-8 bytes, for metadata indexes. Does not replace protocol content. */
export function gzipBytes(text: string): number {
  return gzipSync(Buffer.from(text, 'utf8')).length;
}
