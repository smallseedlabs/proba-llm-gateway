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
  budget?: RunBudgetView;
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
    'Post copy: none saved yet. It comes from the operator in the web app under Campaigns > Reddit post form ' +
    '(stored on the goal as goals.approved_creative). ads.create_campaign is blocked until it exists; you do not write ad copy.'
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
    facts.offeredTools.length > 0
      ? `Tools you can call now: ${facts.offeredTools.join(', ')}. Calling any of them except research.gather raises an approval card for the operator.`
      : 'Tools you can call now: none.',
    facts.deniedByGuardrails.length > 0 ? `Turned off by the operator's guardrails: ${facts.deniedByGuardrails.join(', ')}.` : '',
  ];
  const b = facts.budget;
  if (b) {
    const tokens = b.maxTotalTokens === null ? `${b.tokens} tokens used` : `${b.tokens} of ${b.maxTotalTokens} tokens used`;
    lines.push(`Run budget: loop ${b.iteration} of at most ${b.maxIterations}; ${b.toolCalls} of ${b.maxToolCalls} tool calls used; ${tokens}.`);
    if (b.iteration >= b.maxIterations) {
      lines.push('This is the last loop the budget allows: respond with the most useful answer you have now, and say what is still unknown.');
    }
  }
  lines.push(
    'How you work: you may think, research, re-evaluate and refine over several loops; how many is your choice within the budget. ' +
      'Then return whatever best moves the goal forward: an answer, an explanation, a clarifying question, a proposal, or a tool call. ' +
      'If an action is blocked, say why and what would unblock it.'
  );
  return lines.filter((l) => l.length > 0).join('\n');
}
