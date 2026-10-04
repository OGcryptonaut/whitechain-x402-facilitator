import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter } from "../../src/policy/ratelimit.js";

describe("TokenBucketRateLimiter", () => {
  it("allows `limit` requests per window, then refuses with a retry hint", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);
    const refused = limiter.consume("a");
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(20);
    // other keys are independent
    expect(limiter.consume("b").allowed).toBe(true);
    // tokens refill over time
    now = 30_000;
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("peek never consumes", () => {
    const limiter = new TokenBucketRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.peek("k").allowed).toBe(true);
    expect(limiter.peek("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.peek("k").allowed).toBe(false);
  });

  it("applies a multiplier (API keys) to the limit", () => {
    const limiter = new TokenBucketRateLimiter({ limit: 2, windowMs: 60_000, now: () => 0 });
    for (let i = 0; i < 20; i++) expect(limiter.consume("vip", 1, 10).allowed).toBe(true);
    expect(limiter.consume("vip", 1, 10).allowed).toBe(false);
    expect(limiter.consume("vip", 1, 10).limit).toBe(20);
  });

  it("bounds memory with LRU eviction", () => {
    const limiter = new TokenBucketRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 3, now: () => 0 });
    for (const k of ["a", "b", "c", "d"]) limiter.consume(k);
    expect(limiter.size()).toBe(3);
  });

  it("rejects non-positive configuration", () => {
    expect(() => new TokenBucketRateLimiter({ limit: 0, windowMs: 1000 })).toThrow();
    expect(() => new TokenBucketRateLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});
