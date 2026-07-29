/**
 * Bid velocity / bid-integrity detector.
 *
 * Deliberately starts with a statistical baseline (rolling z-score on bid
 * inter-arrival time + a repeated-bidder-pair counter) rather than a
 * trained model. Two reasons worth stating explicitly:
 *
 * 1. Cold-start problem: a new platform has no labeled fraud examples to
 *    train on yet. Statistical baselines work from day one.
 * 2. False-positive cost is asymmetric: flagging a legitimate aggressive
 *    bidder as suspicious is worse for trust than under-flagging early on.
 *    A simple, explainable rule set is easier to tune for that asymmetry
 *    than a black-box model.
 *
 * State (rolling stats per lot, per bidder-pair counts) lives in Redis so
 * the detector can run as multiple stateless replicas.
 */

import { Redis } from "ioredis";
import { redisLatency } from "../metrics.js";

const ZSCORE_ANOMALY_THRESHOLD = 2.5;
const REPEATED_PAIR_WINDOW_SECONDS = 300;
const REPEATED_PAIR_ALERT_COUNT = 5;

export type RiskLevel = "low" | "medium" | "high";

export interface AnomalyFlag {
  type: "bid_velocity" | "cross_lot_frequency";
  z_score?: number;
  lot_count?: number;
}

export interface BidScore {
  lot_id: string;
  bidder_id: string;
  amount: number;
  flags: AnomalyFlag[];
  risk_level: RiskLevel;
}

export class BidAnomalyDetector {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private async timed<T>(command: string, fn: () => Promise<T>): Promise<T> {
    const endTimer = redisLatency.startTimer({ command });
    try {
      return await fn();
    } finally {
      endTimer();
    }
  }

  async scoreBid(lotId: string, bidderId: string, amount: number, placedAt: number): Promise<BidScore> {
    const flags: AnomalyFlag[] = [];

    const velocityFlag = await this._checkVelocity(lotId, placedAt);
    if (velocityFlag) flags.push(velocityFlag);

    const pairFlag = await this._checkRepeatedPairs(lotId, bidderId);
    if (pairFlag) flags.push(pairFlag);

    return {
      lot_id: lotId,
      bidder_id: bidderId,
      amount,
      flags,
      risk_level: flags.length >= 2 ? "high" : flags.length ? "medium" : "low",
    };
  }

  async _checkVelocity(lotId: string, placedAt: number): Promise<AnomalyFlag | null> {
    const key = `lot:${lotId}:bid_times`;
    await this.timed("lpush", () => this.redis.lpush(key, placedAt));
    await this.timed("ltrim", () => this.redis.ltrim(key, 0, 49)); // keep last 50 bids
    await this.timed("expire", () => this.redis.expire(key, 3600));

    const rawTimes = await this.timed("lrange", () => this.redis.lrange(key, 0, -1));
    const times = rawTimes.map(Number).sort((a: number, b: number) => a - b);
    // Need enough history to build a baseline *excluding* the interval
    // we're about to test - otherwise the anomalous gap inflates its own
    // mean/std and partially hides itself from the z-score.
    if (times.length < 7) return null;

    const intervals: number[] = [];
    for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);

    const latestInterval = intervals[intervals.length - 1];
    const historicalIntervals = intervals.slice(0, -1);

    const mean = historicalIntervals.reduce((a, b) => a + b, 0) / historicalIntervals.length;
    const variance =
      historicalIntervals.reduce((a, b) => a + (b - mean) ** 2, 0) / historicalIntervals.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;

    const z = (latestInterval - mean) / std;

    // Unusually FAST bidding relative to the lot's own recent pace is the
    // signal here - not fast in absolute terms, since pace varies a lot by
    // lot popularity.
    if (z < -ZSCORE_ANOMALY_THRESHOLD) {
      return { type: "bid_velocity", z_score: Math.round(z * 100) / 100 };
    }
    return null;
  }

  async _checkRepeatedPairs(lotId: string, bidderId: string): Promise<AnomalyFlag | null> {
    // Flags a bidder who shows up unusually often across lots within a
    // short window - a common shill-bidding signature.
    const key = `bidder:${bidderId}:recent_lots`;
    const now = Date.now() / 1000;
    await this.timed("zadd", () => this.redis.zadd(key, now, lotId));
    await this.timed("zremrangebyscore", () => this.redis.zremrangebyscore(key, 0, now - REPEATED_PAIR_WINDOW_SECONDS));

    const count = await this.timed("zcard", () => this.redis.zcard(key));
    if (count >= REPEATED_PAIR_ALERT_COUNT) {
      return { type: "cross_lot_frequency", lot_count: count };
    }
    return null;
  }
}
