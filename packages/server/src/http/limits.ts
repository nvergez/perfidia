import type { Limits } from "../config.ts";

// The HTTP rate limit (phase-3 design §3.4): a token bucket per client IP, refilled at
// `httpPerMinute` and holding at most `httpBurst` tokens. A request without a token gets 429 with
// `Retry-After`. Client IPs are kept in memory only, for this.

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly perMs: number;
  private readonly burst: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(limits: Limits) {
    this.perMs = limits.httpPerMinute / 60_000;
    this.burst = limits.httpBurst;
  }

  /** Takes a token for `ip`; returns 0 when allowed, else the seconds to wait. */
  take(ip: string, now: number): number {
    let b = this.buckets.get(ip);
    if (b === undefined) {
      if (this.buckets.size >= 50_000) this.prune(now);
      b = { tokens: this.burst, at: now };
      this.buckets.set(ip, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * this.perMs);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.perMs / 1000));
  }

  /** Drops the buckets that are full again. */
  private prune(now: number): void {
    for (const [ip, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.perMs >= this.burst) this.buckets.delete(ip);
    }
  }
}
