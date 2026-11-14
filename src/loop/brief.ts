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
    'Post copy: none saved yet. Draft it with creative.draft_post from the goal, the operator page and the accepted research; ' +
    'the operator approves or edits the draft card, which saves it on the goal (goals.approved_creative). The operator may instead save ' +
    'their own copy in the web app under Campaigns > Reddit post form. ads.create_campaign is blocked until approved copy exists.'
  );
}

export function runBriefText(request: HubRunRequest | undefined, facts: RunBriefFacts): string {
  const url = normalizeLandingPageUrl(request?.userSuppliedInput?.landingPageUrl);
  const lines = [
    '[run]',
    request ? `Step: ${request.stepType}.` : '',
    url
      ? `Landing page: ${url} (operator-supplied).`
      : 'Landing page: none supplied. The operator sets it on the goal; research.gather and ads.create_campaign need it.',
    creativeLine(request),
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
