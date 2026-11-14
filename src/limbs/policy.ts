/**
 * Schema / permission / allowlist checks. No adapter is invoked from here.
 * Unknown verbs and non-allowlisted verbs are denied. Permission in this
 * slice is workspace presence only (Hub already scoped the user).
 */

import type { PolicyContext, PolicyDecision, PolicyEngine } from '../ports/policy.js';
import { normalizeLandingPageUrl } from '../research/input.js';
import { verbByName } from './catalog.js';
import { checkCreativeDraft } from './creative-draft.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOk(expected: string | undefined, value: unknown): boolean {
  if (!expected) return true;
  if (expected === 'object') return isRecord(value);
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'array') return Array.isArray(value);
  return false;
}

/**
 * Minimal JSON-Schema subset: type, required, additionalProperties=false,
 * string min/maxLength, enum. Enough for the fixed catalog; not a general
 * validator and not a source of allow decisions by itself.
 */
export function argumentsMatchSchema(schema: Record<string, unknown>, raw: unknown): string | undefined {
  if (!isRecord(raw)) return 'arguments must be an object';
  if (schema.additionalProperties === false) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(raw)) {
      if (!(key in properties)) return `argument ${key} is not listed`;
    }
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [];
  for (const key of required) {
    if (raw[key] === undefined) return `argument ${key} is required`;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, spec] of Object.entries(properties)) {
    if (raw[key] === undefined) continue;
    if (!isRecord(spec)) continue;
    if (!typeOk(typeof spec.type === 'string' ? spec.type : undefined, raw[key])) {
      return `argument ${key} has the wrong type`;
    }
    if (typeof raw[key] === 'string') {
      const text = raw[key];
      if (typeof spec.minLength === 'number' && text.length < spec.minLength) return `argument ${key} is too short`;
      if (typeof spec.maxLength === 'number' && text.length > spec.maxLength) return `argument ${key} is too long`;
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(raw[key])) return `argument ${key} is not in the enum`;
  }
  return undefined;
}

export class CatalogPolicyEngine implements PolicyEngine {
  evaluate(toolName: string, rawArgs: unknown, ctx: PolicyContext): PolicyDecision {
    if (!ctx.workspaceId || !ctx.userId) {
      return { allowed: false, code: 'permission', reason: 'workspace and user are required' };
    }
    const verb = verbByName(toolName);
    if (!verb) return { allowed: false, code: 'unknown_verb', reason: `verb ${toolName} is not in the fixed catalog` };
    if (!verb.allowlisted) {
      return { allowed: false, code: 'allowlist', reason: `${verb.name} is not allowlisted` };
    }
    const schemaIssue = argumentsMatchSchema(verb.parameters, rawArgs);
    if (schemaIssue) return { allowed: false, code: 'schema', reason: schemaIssue };
    if (!isRecord(rawArgs)) return { allowed: false, code: 'schema', reason: 'arguments must be an object' };
    const userUrl = normalizeLandingPageUrl(ctx.userSuppliedInput?.landingPageUrl);
    if (verb.name === 'creative.draft_post') {
      const checked = checkCreativeDraft(rawArgs, {
        userLandingPageUrl: ctx.userSuppliedInput?.landingPageUrl,
        research: ctx.acceptedResearch,
        rules: ctx.creativeRules,
      });
      if (!checked.ok) {
        // user_input here is still non-fatal for the run: the model is told and can fix the draft or ask.
        return { allowed: false, code: checked.code === 'user_input' ? 'creative_invalid' : checked.code, reason: checked.reason };
      }
      return { allowed: true, verb, args: { ...checked.draft } };
    }
    if (verb.name === 'research.gather' || verb.name === 'ads.create_campaign') {
      if (!userUrl) {
        return {
          allowed: false,
          code: 'user_input',
          reason:
            'Hub userSuppliedInput.landingPageUrl is required; model/tool text is not a user-supplied URL and there is no default landing page',
        };
      }
      const argUrl =
        verb.name === 'research.gather'
          ? normalizeLandingPageUrl(typeof rawArgs.url === 'string' ? rawArgs.url : userUrl)
          : normalizeLandingPageUrl(rawArgs.landingPageUrl);
      if (!argUrl || argUrl !== userUrl) {
        return {
          allowed: false,
          code: 'user_input',
          reason: 'tool URL does not match the authenticated user-supplied landing page for this input revision',
        };
      }
      if (verb.name === 'research.gather') {
        return { allowed: true, verb, args: { ...rawArgs, url: userUrl } };
      }
      const creative = ctx.userSuppliedInput?.creative;
      if (!creative) {
        return {
          allowed: false,
          code: 'creative_missing',
          reason: CREATIVE_MISSING_REASON,
        };
      }
      const imageUrl = typeof creative.mediaUrl === 'string' ? normalizeLandingPageUrl(creative.mediaUrl) : undefined;
      if (creative.type === 'IMAGE' && !imageUrl) {
        return { allowed: false, code: 'user_input', reason: 'creative.mediaUrl must be a public https URL supplied by the operator' };
      }
      const targeting = ctx.userSuppliedInput?.targeting;
      return {
        allowed: true,
        verb,
        args: {
          ...rawArgs,
          landingPageUrl: userUrl,
          creative: imageUrl ? { ...creative, mediaUrl: imageUrl } : { ...creative },
          ...(targeting ? { targeting: { ...targeting } } : {}),
        },
      };
    }
    if (verb.name === 'research.accept') {
      return { allowed: false, code: 'allowlist', reason: 'research.accept is Hub-mediated and is not a model tool' };
    }
    return { allowed: true, verb, args: rawArgs };
  }
}

/**
 * Actionable reason for a create without operator copy. The check is unchanged (no
 * creative, no campaign); the run is told what the operator must do so it can say so
 * and finish, instead of failing the run.
 */
export const CREATIVE_MISSING_REASON =
  'ads.create_campaign needs approved post copy and none is saved for this goal. Draft it with creative.draft_post (from the goal, page and accepted research); the operator approves or edits the draft, which saves it, then call ads.create_campaign again. The operator can also save their own copy in Campaigns. Approved copy is never bypassed.';
