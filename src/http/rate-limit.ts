/**
 * In-process sliding window. Isolation is by verified issuer+subject so one
 * Hub identity cannot starve another.
 */

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const start = now - this.windowMs;
    const next = (this.hits.get(key) ?? []).filter((t) => t > start);
    if (next.length >= this.max) {
      this.hits.set(key, next);
      return false;
    }
    next.push(now);
    this.hits.set(key, next);
    return true;
  }
}
