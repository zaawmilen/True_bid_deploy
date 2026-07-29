// rateLimit.ts
//
// Two separate concerns, because they're abused two different ways:
//
// 1. HTTP endpoints (/auth/login, /estimate/:lotId, /valuation/:lotId) -
//    standard request-flood protection via express-rate-limit.
//
// 2. WebSocket upgrades (/ws/:lotId) - the frontend's current usage is
//    server -> client push only (no client -> server messages after
//    connecting, see index.html), so the actual abuse surface isn't
//    message spam, it's connection-open spam: a script rapidly opening
//    (and possibly not closing) many WS connections to inflate the
//    gateway's `websocket_clients` metric and exhaust file descriptors.
//    So this limits *connection attempts per key*, not messages.
//
// TRADEOFF, stated explicitly rather than left implicit: both limiters
// below are in-memory (a plain Map). That's the right amount of
// engineering for a single-instance demo gateway - it resets on
// restart and doesn't share state if this were ever horizontally
// scaled to multiple gateway replicas. If that becomes real, the fix is
// a Redis-backed store (rate-limiter-flexible's RedisStore, or
// express-rate-limit's rate-limit-redis) - anomaly-service already runs
// against Redis in this stack, so the infra to do that already exists,
// it's just not pulled into gateway today because a single demo
// instance doesn't need it yet.

import rateLimit from 'express-rate-limit';

const HTTP_WINDOW_MS = Number(process.env.RATE_LIMIT_HTTP_WINDOW_MS ?? 60_000);
const HTTP_MAX = Number(process.env.RATE_LIMIT_HTTP_MAX ?? 120); // ~2 req/s sustained

export const httpRateLimiter = rateLimit({
  windowMs: HTTP_WINDOW_MS,
  limit: HTTP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', retry_after_ms: HTTP_WINDOW_MS },
});

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Simple token-bucket limiter, keyed by whatever the caller passes in
 * (here: bidder_id from the verified JWT, so the limit follows the
 * bidder rather than their IP - matters on shared NATs/offices where
 * many legitimate bidders share one IP).
 */
export class WsConnectionLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxConnections: number,
    private readonly windowMs: number
  ) {}

  consume(key: string, now: number = Date.now()): RateLimitDecision {
    const refillRatePerMs = this.maxConnections / this.windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.maxConnections, lastRefillMs: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefillMs;
    bucket.tokens = Math.min(this.maxConnections, bucket.tokens + elapsed * refillRatePerMs);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const msUntilNextToken = Math.ceil((1 - bucket.tokens) / refillRatePerMs);
    return { allowed: false, retryAfterMs: msUntilNextToken };
  }

  /** Prevents unbounded memory growth from one-off/attacker keys. */
  sweep(maxAgeMs: number, now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefillMs > maxAgeMs) this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}

const WS_MAX_CONNECTIONS = Number(process.env.RATE_LIMIT_WS_MAX_CONNECTIONS ?? 10);
const WS_WINDOW_MS = Number(process.env.RATE_LIMIT_WS_WINDOW_MS ?? 60_000);

export const wsConnectionLimiter = new WsConnectionLimiter(WS_MAX_CONNECTIONS, WS_WINDOW_MS);
