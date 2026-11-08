/**
 * Secret (always) and optional PII masking for audit content and details.
 * Patterns follow Hub/memory so producers treat the same strings alike.
 * Never throws. Never logs the original text.
 */

const REDACTED = '[REDACTED]';

const SECRET_KEY_RE =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|apikey|credential|bearer|jwt|private[-_]?key|session[-_]?id|id[-_]?token)/i;
const PERSONAL_KEY_RE =
  /^(email|e-mail|phone|phonenumber|displayname|display_name|fullname|full_name|firstname|lastname|address|ip|ipaddress|remoteaddress|useragent|user_agent)$/i;

const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const KEY_PREFIX_RE =
  /\b(?:(?:sk|pk|rk)[-_](?:live|test|proj|ant|svcacct)?[-_]?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/g;
const LABELLED_SECRET_RE =
  /\b((?:pass(?:word|wd|code)?|pwd|secret|api[ _-]?key|apikey|(?:access|auth|refresh|session|id)[ _-]?token|token|client[ _-]?secret|private[ _-]?key|pin)\s*[:=]\s*)(?!\[REDACTED)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_TOKEN_RE = /([?&](?:token|access_token|id_token|key|api_key)=)[^&#\s]*/gi;
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const EMAIL_CONTENT_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const PHONE_RE =
  /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?!\w|\.\d)/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of value) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

export interface MaskedText {
  text: string;
  redactions: number;
}

export function maskSecretsInText(value: unknown, options: { pii?: boolean } = {}): MaskedText {
  if (typeof value !== 'string') return { text: '', redactions: 0 };
  let redactions = 0;
  const mask = (replacement: string) => () => {
    redactions += 1;
    return replacement;
  };
  const maskValue = (_m: string, label: string) => {
    redactions += 1;
    return `${label}[REDACTED]`;
  };
  try {
    let text = value
      .replace(PRIVATE_KEY_BLOCK_RE, mask('[REDACTED_PRIVATE_KEY]'))
      .replace(BEARER_RE, mask('Bearer [REDACTED]'))
      .replace(JWT_RE, mask('[REDACTED_TOKEN]'))
      .replace(KEY_PREFIX_RE, mask('[REDACTED_KEY]'))
      .replace(QUERY_TOKEN_RE, (_m, label: string) => {
        redactions += 1;
        return `${label}[REDACTED]`;
      })
      .replace(LABELLED_SECRET_RE, maskValue)
      .replace(CARD_CANDIDATE_RE, (m) => {
        const digits = m.replace(/[ -]/g, '');
        if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
        redactions += 1;
        return '[REDACTED_CARD]';
      });
    if (options.pii) {
      text = text
        .replace(EMAIL_CONTENT_RE, mask('[REDACTED_EMAIL]'))
        .replace(IBAN_RE, (m) => {
          if (!ibanValid(m)) return m;
          redactions += 1;
          return '[REDACTED_IBAN]';
        })
        .replace(PHONE_RE, (m) => {
          const digits = m.replace(/\D/g, '');
          if (digits.length < 9 || digits.length > 15) return m;
          redactions += 1;
          return '[REDACTED_PHONE]';
        });
    }
    return { text, redactions };
  } catch {
    return { text: '[unavailable]', redactions: 0 };
  }
}

export function redactDetails(details: unknown, options: { maxStringLength?: number } = {}): Record<string, unknown> {
  const maxStringLength = options.maxStringLength ?? 300;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>).slice(0, 40)) {
    if (SECRET_KEY_RE.test(key) || PERSONAL_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof value === 'string') {
      const masked = maskSecretsInText(value).text;
      out[key] = masked.length > maxStringLength ? `${masked.slice(0, maxStringLength)}…` : masked;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 25).map((item) =>
        typeof item === 'string' ? maskSecretsInText(item).text.slice(0, maxStringLength) : item
      );
    }
  }
  return out;
}
