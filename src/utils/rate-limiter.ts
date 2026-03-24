/**
 * Token bucket rate limiter for per-session request throttling.
 * Protects the server against request floods from runaway agents.
 */

export interface RateLimiterOptions {
  /** Maximum tokens (= max burst size). Default: 60 */
  maxTokens: number;
  /** Tokens refilled per second. Default: maxTokens / 60 (= 1/sec for 60/min) */
  refillRatePerSec: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly maxTokens: number;
  private readonly refillRatePerSec: number;

  constructor(opts: RateLimiterOptions) {
    this.maxTokens = opts.maxTokens;
    this.refillRatePerSec = opts.refillRatePerSec;
    this.tokens = opts.maxTokens; // Start full
    this.lastRefillAt = Date.now();
  }

  /**
   * Try to consume one token.
   * Returns true if token was consumed; false if the bucket is empty.
   */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Returns the number of seconds until the next token is available.
   * Returns 0 if tokens are available now.
   */
  retryAfterSec(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil(deficit / this.refillRatePerSec);
  }

  /**
   * Current token count (for monitoring/health).
   */
  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillAt) / 1000; // seconds
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerSec);
    this.lastRefillAt = now;
  }
}

/**
 * Manages per-session rate limiters.
 * Creates a bucket for each session on first use; cleans up when sessions are removed.
 */
export class SessionRateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private readonly options: RateLimiterOptions;

  constructor(maxRequestsPerMinute: number) {
    this.options = {
      maxTokens: maxRequestsPerMinute,
      refillRatePerSec: maxRequestsPerMinute / 60,
    };
  }

  /**
   * Check if a request from the given session is allowed.
   * Returns { allowed: true } or { allowed: false, retryAfterSec }.
   */
  check(sessionId: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = new TokenBucket(this.options);
      this.buckets.set(sessionId, bucket);
    }

    if (bucket.consume()) {
      return { allowed: true };
    }

    return {
      allowed: false,
      retryAfterSec: bucket.retryAfterSec(),
    };
  }

  /**
   * Remove a session's bucket (call on session cleanup).
   */
  removeSession(sessionId: string): void {
    this.buckets.delete(sessionId);
  }

  /**
   * Number of tracked sessions (for monitoring).
   */
  get sessionCount(): number {
    return this.buckets.size;
  }
}
