import { describe, it, expect } from 'vitest';
import { WsConnectionLimiter } from '../../src/rateLimit.js';

describe('WsConnectionLimiter', () => {
  it('allows up to maxConnections immediately, then denies', () => {
    const limiter = new WsConnectionLimiter(3, 60_000);
    const now = 1_000_000;
    expect(limiter.consume('bidder-1', now).allowed).toBe(true);
    expect(limiter.consume('bidder-1', now).allowed).toBe(true);
    expect(limiter.consume('bidder-1', now).allowed).toBe(true);
    const fourth = limiter.consume('bidder-1', now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks separate keys independently', () => {
    const limiter = new WsConnectionLimiter(1, 60_000);
    const now = 1_000_000;
    expect(limiter.consume('bidder-1', now).allowed).toBe(true);
    expect(limiter.consume('bidder-1', now).allowed).toBe(false);
    // A different bidder is unaffected by bidder-1 exhausting their bucket.
    expect(limiter.consume('bidder-2', now).allowed).toBe(true);
  });

  it('refills tokens gradually over the window', () => {
    const limiter = new WsConnectionLimiter(2, 10_000); // 2 tokens per 10s
    const t0 = 1_000_000;
    expect(limiter.consume('bidder-1', t0).allowed).toBe(true);
    expect(limiter.consume('bidder-1', t0).allowed).toBe(true);
    expect(limiter.consume('bidder-1', t0).allowed).toBe(false); // exhausted

    // Halfway through the window: should have refilled ~1 token.
    const tHalf = t0 + 5_000;
    expect(limiter.consume('bidder-1', tHalf).allowed).toBe(true);
    expect(limiter.consume('bidder-1', tHalf).allowed).toBe(false);

    // Fully past the window: back to full capacity.
    const tFull = t0 + 20_000;
    expect(limiter.consume('bidder-1', tFull).allowed).toBe(true);
    expect(limiter.consume('bidder-1', tFull).allowed).toBe(true);
  });

  it('sweep() removes stale keys past maxAgeMs', () => {
    const limiter = new WsConnectionLimiter(5, 60_000);
    const t0 = 1_000_000;
    limiter.consume('bidder-1', t0);
    limiter.consume('bidder-2', t0);
    expect(limiter.size()).toBe(2);

    limiter.sweep(30_000, t0 + 10_000); // nothing stale yet
    expect(limiter.size()).toBe(2);

    limiter.sweep(30_000, t0 + 50_000); // both now stale
    expect(limiter.size()).toBe(0);
  });
});
