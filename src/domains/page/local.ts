/**
 * User-provided landing page attachment. This is a Proba-side record on the
 * run, not page generation and not an ad-network call.
 */

import type { LimbCall, LimbExecutionContext, LimbResult } from '../../ports/limbs.js';

export function attachUserPage(call: LimbCall, ctx: LimbExecutionContext): LimbResult {
  const url = call.args.url;
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, code: 'invalid_args', message: 'url is required' };
  }
  ctx.domainState.userPageUrl = url.trim();
  ctx.domainState.userPageWorkspaceId = ctx.workspaceId;
  return { ok: true, data: { url: url.trim(), workspaceId: ctx.workspaceId, goalId: ctx.goalId } };
}
