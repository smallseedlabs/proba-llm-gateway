/**
 * The run brief: facts about THIS run that the self memory cannot know (which inputs exist, which tools are on, how much of the
 * run budget is left). It informs the model; it does not tell it what to return. The model decides how many loops to use and
 * whether to answer, explain, ask, propose or act.
 */
import type { HubRunRequest } from '../types/run.js';
import { normalizeLandingPageUrl } from '../research/input.js';

export interface RunBudgetView {
  /** Loop (iteration) being run now, 1-based. */
  iteration: number;
  maxIterations: number;
  toolCalls: number;
  maxToolCalls: number;
  tokens: number;
  maxTotalTokens: number | null;
}

export interface RunBriefFacts {
  /** Tool names offered to the model on this loop. */
  offeredTools: readonly string[];
  /** Verbs the operator guardrails turned off. */
  deniedByGuardrails: readonly string[];
  /** Brain campaign review facts (trigger, plan, audited metrics present, bounds); absent for other runs. */
  review?: string;
}

/** Used only when the context packet carries no self memory (memory-api unavailable). The full self lives in proba-memory. */
export const FALLBACK_SELF =
  "You are Proba, Small Seed Labs' AI marketing operator. The end goal is to take the operator's goal to a launched, measured ad campaign, " +
  'within their budget and with their approval for anything that spends or changes a campaign.';

function creativeLine(request: HubRunRequest | undefined): string {
  const creative = request?.userSuppliedInput?.creative as { type?: unknown } | undefined;
  if (creative) {
    const type = typeof creative.type === 'string' ? ` (${creative.type})` : '';
    return `Post copy: operator-approved copy is saved on the goal${type}.`;
  }
  return (
    'Ad creative: none saved yet. Draft it with creative.draft_post from the goal, the operator page and the accepted research; ' +
    'propose plans for connected platforms (when both Meta Facebook/Instagram and Reddit are connected, or when running via managed accounts, draft a visual-first creative with an image from creative.generate_media and target BOTH Meta and Reddit). ' +
    'The operator approves or edits the draft card, which saves it on the goal (goals.approved_creative). ads.create_campaign is blocked until approved creative exists.'
  );
}

export function runBriefText(request: HubRunRequest | undefined, facts: RunBriefFacts): string {
  const url = normalizeLandingPageUrl(request?.userSuppliedInput?.landingPageUrl);
  const rawConnected = (request?.userSuppliedInput as { connectedPlatforms?: unknown } | undefined)?.connectedPlatforms;
  const connected = Array.isArray(rawConnected)
    ? rawConnected.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const lines = [
    '[run]',
    request ? `Step: ${request.stepType}.` : '',
    connected.length > 0
      ? `Connected ad platforms in this workspace: ${connected.join(', ')}.` +
        (connected.length > 1
          ? ` Launch on ALL connected platforms (${connected.join(' AND ')}) by calling ads.create_campaign separately for each platform.`
          : '')
      : '',
    url
      ? `Landing page: ${url} (operator-supplied).`
      : 'Landing page: none supplied. The operator sets it on the goal; research.gather and ads.create_campaign need it.',
    creativeLine(request),
    'Defaults: do not ask the operator for success metric, platform, targeting or duration. Choose them yourself from the goal, page and research ' +
      'and put them in the creative.draft_post plan card (plan + targeting, each with a "chose X because Y" reason); the operator can override any of it. ' +
      'Act decisively from the submitted URL (even for social links or Reels): generate visuals with creative.generate_media and pop out a creative.draft_post decision card with your recommended creative, audience, and plan instead of stopping to ask clarifying questions. ' +
      'When calling ads.create_campaign, match the goal/workspace cap currency (e.g. GBP, USD, EUR) from context rather than guessing USD.',
    'Metrics: come from the Hub analytics review (the analytics section of your context), not from a tool you call.',
    facts.review ? `[review]\n${facts.review}` : '',
    facts.review && facts.offeredTools.length > 0
      ? `Tools you can call now: ${facts.offeredTools.join(', ')}. They record your note; they never execute a change.`
      : facts.offeredTools.length > 0
      ? `Tools you can call now: ${facts.offeredTools.join(', ')}. ${
          facts.offeredTools.includes('research.gather') ? 'Every one except research.gather' : 'Each one'
        } raises an approval card for the operator.`
      : 'Tools you can call now: none.',
    facts.deniedByGuardrails.length > 0
      ? `Turned off by the gateway guardrails config (deployment-wide): ${facts.deniedByGuardrails.join(', ')}.`
      : '',
  ];
  lines.push(
    'How you work: you may think, research, re-evaluate and refine over several loops; how many is your choice within the run budget (sent each loop as [run budget]). ' +
      'Then return whatever best moves the goal forward: an answer, an explanation, a clarifying question, a proposal, or a tool call. ' +
      'If an action is blocked, say why and what would unblock it.'
  );
  return lines.filter((l) => l.length > 0).join('\n');
}

/** Budget used vs the run's upper bounds, for the current loop. Sent as the last message of each model call. */
export function runBudgetText(b: RunBudgetView): string {
  const tokens = b.maxTotalTokens === null ? `${b.tokens} tokens used` : `${b.tokens} of ${b.maxTotalTokens} tokens used`;
  const lines = [`[run budget] Loop ${b.iteration} of at most ${b.maxIterations}; ${b.toolCalls} of ${b.maxToolCalls} tool calls used; ${tokens}.`];
  if (b.iteration >= b.maxIterations) {
    lines.push('This is the last loop the budget allows: respond with the most useful answer you have now, and say what is still unknown.');
  }
  return lines.join('\n');
}
