import { execSync } from "node:child_process";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BidAnomalyDetector } from "../../src/detectors/bidVelocity.js";

// Complements test/unit/bidVelocity.test.ts (which uses ioredis-mock for
// fast, deterministic logic checks) with a real Redis instance, to catch
// anything an in-memory mock wouldn't: TTL/expire behavior, actual
// list/sorted-set semantics, and reconnection-shaped usage patterns.

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(dockerAvailable())("BidAnomalyDetector - real Redis integration", () => {
  let container: StartedTestContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .start();
    const port = container.getMappedPort(6379);
    redis = new Redis({ host: container.getHost(), port });
  }, 60_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  it("persists rolling bid-time history in a real Redis list, capped at 50 entries", async () => {
    const detector = new BidAnomalyDetector(redis);
    for (let i = 0; i < 60; i++) {
      await detector.scoreBid("LOT-REAL-1", "bidder-x", 100, i);
    }
    const stored = await redis.lrange("lot:LOT-REAL-1:bid_times", 0, -1);
    expect(stored.length).toBe(50);
  });

  it("sets a TTL on the rolling bid-time key so idle lots don't leak memory", async () => {
    const detector = new BidAnomalyDetector(redis);
    await detector.scoreBid("LOT-REAL-2", "bidder-y", 100, 1);
    const ttl = await redis.ttl("lot:LOT-REAL-2:bid_times");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it("flags a genuine velocity anomaly using real Redis-backed rolling stats", async () => {
    const detector = new BidAnomalyDetector(redis);
    const baseTimes = [0, 30, 62, 91, 122, 152, 180];
    let score;
    for (const t of baseTimes) {
      score = await detector.scoreBid("LOT-REAL-3", "steady-bidder", 100, t);
    }
    score = await detector.scoreBid("LOT-REAL-3", "fast-bidder", 500, 181);
    expect(score!.flags.some((f) => f.type === "bid_velocity")).toBe(true);
  });

  it("expires cross-lot frequency entries outside the alert window via zremrangebyscore", async () => {
    const detector = new BidAnomalyDetector(redis);
    const longAgo = Date.now() / 1000 - 10_000; // well outside the 300s window
    // Manually seed stale entries the way _checkRepeatedPairs would have
    for (let i = 0; i < 4; i++) {
      await redis.zadd(`bidder:stale-bidder:recent_lots`, longAgo + i, `LOT-STALE-${i}`);
    }
    const score = await detector.scoreBid("LOT-REAL-4", "stale-bidder", 100, Date.now() / 1000);
    // The 4 stale entries should have been pruned, leaving just this new one -
    // nowhere near the 5-lot alert threshold.
    expect(score.flags.find((f) => f.type === "cross_lot_frequency")).toBeUndefined();
    const remaining = await redis.zcard("bidder:stale-bidder:recent_lots");
    expect(remaining).toBe(1);
  });
});
