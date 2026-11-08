/**
 * Runtime limb executor. No provider/domain adapter is registered.
 * Always throws — never returns `{ ok: true }`, never pretends a tool ran.
 * Test doubles live under src/testing and are refused unless NODE_ENV=test.
 */

import { ToolRefusedError } from '../errors.js';
import type { LimbCall, LimbExecutionContext, LimbExecutor, LimbResult } from '../ports/limbs.js';

export class RefusingLimbExecutor implements LimbExecutor {
  readonly name = 'refusing';

  async execute(call: LimbCall, _ctx: LimbExecutionContext): Promise<LimbResult> {
    throw new ToolRefusedError(
      `limb ${call.verb.name} has no adapter; refusing execution (LLM does not execute tools; Reddit/Microsoft/Google/Meta adapters are not in this slice)`
    );
  }
}
