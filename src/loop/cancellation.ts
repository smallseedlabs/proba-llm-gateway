import { RunAbortedError } from '../errors.js';
import type { AbortReason, Cancellation, Deadline } from '../ports/cancellation.js';

export class RunCancellation implements Cancellation {
  private readonly controller: AbortController;
  private _reason: AbortReason | undefined;
  readonly signal: AbortSignal;

  constructor(parent?: AbortSignal) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    if (parent) {
      if (parent.aborted) this.abort('disconnect');
      else parent.addEventListener('abort', () => this.abort('disconnect'), { once: true });
    }
  }

  get reason(): AbortReason | undefined {
    return this._reason;
  }

  abort(reason: AbortReason): void {
    if (this.controller.signal.aborted) return;
    this._reason = reason;
    this.controller.abort();
  }

  throwIfAborted(): void {
    if (!this.controller.signal.aborted) return;
    throw new RunAbortedError(`run aborted (${this._reason ?? 'hub_cancel'})`, this._reason ?? 'hub_cancel');
  }
}

export class RunDeadline implements Deadline {
  constructor(readonly deadlineAt: Date) {}

  remainingMs(now: Date = new Date()): number {
    return this.deadlineAt.getTime() - now.getTime();
  }

  throwIfExpired(now: Date = new Date()): void {
    if (this.remainingMs(now) <= 0) {
      throw new RunAbortedError('run deadline exceeded', 'deadline');
    }
  }

  link(cancellation: Cancellation): void {
    const ms = this.remainingMs();
    if (ms <= 0) {
      cancellation.abort('deadline');
      return;
    }
    const timer = setTimeout(() => cancellation.abort('deadline'), ms);
    if (typeof timer.unref === 'function') timer.unref();
    cancellation.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
}
