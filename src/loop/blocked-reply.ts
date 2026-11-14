/**
 * User-facing copy when a preflight or guardrail block ends a run.
 * Say why it is blocked, what would unblock it, and the next step.
 * Do not turn the raw policy reason into a clarifying question.
 */

import type { BrainOutput } from '../protocol.js';
import type { CapabilityNeed } from '../types/preflight.js';

export function blockedReplyText(needs?: readonly CapabilityNeed[], fallbackMessage?: string): string {
  const need = needs?.[0];
  const capability = need?.capability;
  const raw = (need?.message ?? fallbackMessage ?? 'This step is blocked by a guardrail or preflight check.').trim();

  switch (capability) {
    case 'ads.billing':
      if (need?.claim === 'verified' || need?.state === 'insufficient') {
        return (
          'Campaign creation is blocked because your Reddit Ads wallet is not funded. ' +
          'Add funds to your Reddit Ads wallet, then press Retry. Nothing was spent.'
        );
      }
      return (
        'Campaign creation is blocked because Proba could not verify billing on the ad account ' +
        '(provider funds are unknown or not verified). Check the Ads connection and billing, then press Retry. Nothing was spent.'
      );
    case 'ads.blueprint':
      return (
        'This action needs an existing Proba campaign, and none is linked yet. ' +
        'Create the campaign first, then press Retry. Nothing was spent.'
      );
    case 'ads.connection':
      return (
        'Proba cannot reach your ad account, so this campaign step cannot run. ' +
        'Reconnect the account, then press Retry. Nothing was spent.'
      );
    case 'ads.permissions':
      return (
        'The connected ad account does not have the permissions this step needs. ' +
        'Grant create, update, pause and resume access, then press Retry. Nothing was spent.'
      );
    case 'ads.service':
      return (
        'The Ads service is not ready, so campaign actions cannot run. ' +
        'Check that the Ads domain is configured and up, then press Retry. Nothing was spent.'
      );
    case 'research.accepted':
      return (
        'Campaign creation is blocked until the research for this landing page is accepted. ' +
        'Review and accept the research, then press Retry. Nothing was spent.'
      );
    case 'llm.quota':
    case 'llm.service':
      return (
        'Proba could not start a model call for this step. ' +
        `${plainReason(raw)} Check the LLM service and quota, then press Retry. Nothing was spent.`
      );
    case 'context.ready':
      return (
        'Proba could not load context for this step. ' +
        'Check that the context service is up, then press Retry. Nothing was spent.'
      );
    case 'run.budget':
      return (
        'This run hit its token or cost budget, so the step was blocked. ' +
        'Raise the run budget or start a new step, then press Retry. Nothing was spent.'
      );
    case 'limb.manifest':
      return (
        'This action is not enabled in the current tool allowlist. ' +
        'Turn the tool on in guardrails if it should run, then press Retry. Nothing was spent.'
      );
    default:
      return (
        `This step is blocked: ${plainReason(raw)} ` +
        'Fix that, then press Retry. Nothing was spent.'
      );
  }
}

export function blockedReplyOutputs(needs?: readonly CapabilityNeed[], fallbackMessage?: string): BrainOutput[] {
  return [{ type: 'reply', text: blockedReplyText(needs, fallbackMessage) }];
}

function plainReason(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  if (!trimmed) return 'A required check was not ready.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
