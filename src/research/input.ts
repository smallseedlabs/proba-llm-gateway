/**
 * User-supplied landing URL and input revision. Model/tool text is not a
 * substitute. There is no default landing URL.
 */

import { createHash } from 'node:crypto';
import { canonicalArgsHash, stableStringify } from '../audit/canonical.js';
import { parsePublicHttpUrl, UnsafeUrlError } from './ssrf.js';

export interface UserSuppliedInput {
  landingPageUrl: string;
  creative?: Record<string, unknown>;
  targeting?: Record<string, unknown>;
}

export interface ResearchBinding {
  workspaceId: string;
  userId: string;
  goalId: string;
  threadId: string;
}

export function normalizeLandingPageUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const url = parsePublicHttpUrl(raw);
    url.hash = '';
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname === '' ? '/' : url.pathname;
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}${pathname}${url.search}`;
  } catch (err) {
    if (err instanceof UnsafeUrlError) return undefined;
    return undefined;
  }
}

export function inputRevisionForUrl(landingPageUrl: string): string {
  return canonicalArgsHash({ landingPageUrl });
}

export function researchBindingKey(binding: ResearchBinding): string {
  return createHash('sha256').update(stableStringify(binding)).digest('hex');
}

export function readUserSuppliedLanding(input: UserSuppliedInput | undefined): string | undefined {
  return normalizeLandingPageUrl(input?.landingPageUrl);
}
