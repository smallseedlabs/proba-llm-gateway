/**
 * Cancellation and deadline interfaces for the bounded loop.
 * Hub pause / emergency stop arrive as cancel reasons; they never approve work.
 */

export type AbortReason = 'hub_cancel' | 'hub_pause' | 'emergency_stop' | 'deadline' | 'disconnect';

export interface Cancellation {
  readonly signal: AbortSignal;
  readonly reason: AbortReason | undefined;
  abort(reason: AbortReason): void;
  throwIfAborted(): void;
}

export interface Deadline {
  readonly deadlineAt: Date;
  remainingMs(now?: Date): number;
  throwIfExpired(now?: Date): void;
  link(cancellation: Cancellation): void;
}
