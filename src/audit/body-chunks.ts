import { AUDIT_CONTENT_MAX_CHARS } from '../protocol.js';

/**
 * Split redacted prompt/response so each piece fits protocol `AuditEvent.content`
 * (AUDIT_CONTENT_MAX_CHARS). The audit consumer stores each event's content in
 * `audit_event_content` (ZSTD). Concatenating chunks in order reconstructs the
 * full body without a parallel store or a non-protocol gzip field.
 *
 * First chunk travels on `brain.llm_call` / `brain.reply_generated`; further
 * chunks use `brain.prompt_chunk` / `brain.reply_chunk` (same as proba-llm).
 * Catalog is a recommendation, not an allow-list.
 */
export function splitAuditBody(text: string, max = AUDIT_CONTENT_MAX_CHARS): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    if (end <= i) end = i + 1;
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

export function joinAuditBody(chunks: Array<{ text: string }>): string {
  return chunks.map((c) => c.text).join('');
}
