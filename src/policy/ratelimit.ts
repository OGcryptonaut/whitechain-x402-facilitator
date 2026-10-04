// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory token-bucket rate limiter. One bucket per key; `limit` tokens refill evenly over
 * `windowMs`. Memory is bounded by `maxKeys` (least-recently-touched keys are evicted).
 *
 * A multi-replica deployment should put a shared limiter (Redis) behind the same interface; the
 * server only depends on `peek` / `consume`.
 */
export interface RateLimiter {
  /** True when at least `cost` tokens are available (nothing is consumed). */
  peek(key: string, cost?: number, multiplier?: number): RateLimitDecision;
  /** Consumes `cost` tokens; returns the decision (allowed=false when the bucket is empty). */
  consume(key: string, cost?: number, multiplier?: number): RateLimitDecision;
  size(): number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left after this call (floored). */
  remaining: number;
  /** Seconds until at least one token is available again (0 when allowed). */
  retryAfterSeconds: number;
  limit: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface TokenBucketOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    if (opts.limit <= 0) throw new Error("rate limit must be positive");
    if (opts.windowMs <= 0) throw new Error("rate limit window must be positive");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 50_000;
    this.now = opts.now ?? (() => Date.now());
  }

  peek(key: string, cost = 1, multiplier = 1): RateLimitDecision {
    return this.apply(key, cost, multiplier, false);
  }

  consume(key: string, cost = 1, multiplier = 1): RateLimitDecision {
    return this.apply(key, cost, multiplier, true);
  }

  size(): number {
    return this.buckets.size;
  }

  private apply(key: string, cost: number, multiplier: number, commit: boolean): RateLimitDecision {
    const limit = Math.max(1, Math.floor(this.limit * multiplier));
    const refillPerMs = limit / this.windowMs;
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: limit, updatedAt: now };
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(limit, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;
      // Re-insert to refresh LRU position.
      this.buckets.delete(key);
    }
    const allowed = bucket.tokens >= cost;
    if (allowed && commit) bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    this.evictIfNeeded();
    const deficit = allowed ? 0 : cost - bucket.tokens;
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil(deficit / refillPerMs / 1000));
    return { allowed, remaining: Math.floor(bucket.tokens), retryAfterSeconds, limit };
  }

  private evictIfNeeded(): void {
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
