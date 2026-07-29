import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error - ioredis-mock has no first-party types matching ioredis exactly,
// but its runtime API surface (list/sorted-set commands) is what we exercise here.
import RedisMock from "ioredis-mock";
import { BidAnomalyDetector } from "../../src/detectors/bidVelocity.js";

function makeDetector() {
  const redis = new RedisMock();
  return { redis, detector: new BidAnomalyDetector(redis) };
}

describe("BidAnomalyDetector - cold start / insufficient history", () => {
  it("returns low risk with no flags when there aren't yet 7 bids on the lot", async () => {
    const { detector } = makeDetector();
    let score;
    for (let i = 0; i < 6; i++) {
      score = await detector.scoreBid("LOT-1", "bidder-1", 100, 1000 + i * 10);
    }
    expect(score!.flags).toEqual([]);
    expect(score!.risk_level).toBe("low");
  });
});

describe("BidAnomalyDetector - bid velocity (z-score on inter-arrival time)", () => {
  it("does not flag a steady, evenly paced bidding cadence", async () => {
    const { detector } = makeDetector();
    let score;
    // 10-second intervals throughout - no anomaly, and std==0 short-circuits to null
    for (let i = 0; i < 8; i++) {
      score = await detector.scoreBid("LOT-2", `bidder-${i}`, 100 + i * 10, 1000 + i * 10);
    }
    expect(score!.flags.find((f) => f.type === "bid_velocity")).toBeUndefined();
  });

  it("flags a burst of unusually fast bids relative to the lot's own recent pace", async () => {
    const { detector } = makeDetector();
    let score;
    // Baseline pace: ~30s intervals with a little natural jitter (mean=30, std~1.3)
    const baseTimes = [0, 30, 62, 91, 122, 152, 180];
    for (let i = 0; i < baseTimes.length; i++) {
      score = await detector.scoreBid("LOT-3", `bidder-${i}`, 100, baseTimes[i]);
    }
    // ...then a single, much faster bid right after (1s later vs. the ~30s baseline)
    score = await detector.scoreBid("LOT-3", "bidder-fast", 500, 181);

    const flag = score!.flags.find((f) => f.type === "bid_velocity");
    expect(flag).toBeDefined();
    expect(flag!.z_score).toBeLessThan(-2.5);
  });

  it("keeps only the most recent 50 bid timestamps per lot", async () => {
    const { redis, detector } = makeDetector();
    for (let i = 0; i < 60; i++) {
      await detector.scoreBid("LOT-4", "bidder-x", 100, i);
    }
    const stored = await redis.lrange("lot:LOT-4:bid_times", 0, -1);
    expect(stored.length).toBe(50);
  });
});

describe("BidAnomalyDetector - repeated bidder pairs / cross-lot frequency", () => {
  it("does not flag a bidder active on only a couple of lots", async () => {
    const { detector } = makeDetector();
    await detector.scoreBid("LOT-A", "bidder-9", 100, 1000);
    const score = await detector.scoreBid("LOT-B", "bidder-9", 100, 1001);
    expect(score.flags.find((f) => f.type === "cross_lot_frequency")).toBeUndefined();
  });

  it("flags a bidder appearing across 5+ lots within the alert window", async () => {
    const { detector } = makeDetector();
    let score;
    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      score = await detector.scoreBid(`LOT-${i}`, "shill-bidder", 100, now + i);
    }
    const flag = score!.flags.find((f) => f.type === "cross_lot_frequency");
    expect(flag).toBeDefined();
    expect(flag!.lot_count).toBeGreaterThanOrEqual(5);
  });
});

describe("BidAnomalyDetector - overall risk_level aggregation", () => {
  it("reports high risk when both velocity and cross-lot flags fire together", async () => {
    const { detector } = makeDetector();
    const now = Date.now() / 1000;

    // Build up cross-lot frequency for this bidder
    for (let i = 0; i < 4; i++) {
      await detector.scoreBid(`LOT-X${i}`, "double-trouble", 100, now + i);
    }
    // Build up a velocity baseline on a specific lot, ending in a fast burst
    const baseTimes = [0, 30, 62, 91, 122, 152, 180];
    for (const t of baseTimes) {
      await detector.scoreBid("LOT-FINAL", "other-bidder", 100, t);
    }

    const score = await detector.scoreBid("LOT-FINAL", "double-trouble", 500, 181);
    expect(score.risk_level).toBe("high");
    expect(score.flags.length).toBe(2);
  });
});
