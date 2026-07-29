/**
 * cost-engine
 * -----------
 * Two jobs:
 *
 * 1. HTTP endpoint (GET /estimate/:lotId) for on-demand cost estimates
 *    (used before a bidder ever places a bid).
 * 2. Kafka consumer on the `bids` topic - every time a new bid lands on a
 *    lot, recompute the full landed-cost breakdown and publish it to
 *    `cost-updates`, which the gateway fans out to connected bidders over
 *    WebSocket.
 *
 * This split is intentional: the request/response path and the streaming
 * path share the same calculation logic (buildEstimate) but serve two
 * different consumers (a page load vs. a live auction).
 */

import express, { Request, Response } from "express";
import { Pool, PoolClient } from "pg";
import { Kafka } from "kafkajs";
import { calculateBuyerFee, FeeBracket } from "./calculators/fees.js";
import { regressionEstimate, LatLng, VehicleClass } from "./calculators/freight.js";
import { estimateRepairBand } from "./calculators/repair.js";
import { getPhotoSignals } from "./calculators/photoSignals.js";
import { config } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { bidsProcessedTotal, costCalculationDuration, kafkaConsumerLag, postgresQueryDuration, register } from "./metrics.js";

const pool = new Pool({ connectionString: config.databaseUrl });
const kafka = new Kafka({
  clientId: "cost-engine",
  brokers: [config.kafkaBootstrap],
  retry: { retries: 15, initialRetryTime: 500, maxRetryTime: 30000 },
});
export const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "cost-engine" });

// Tracked via KafkaJS's own lifecycle events rather than a flag we set
// manually in each try/catch, so it can't drift out of sync with what the
// client actually did. Used by /readyz below - informational only, since
// the on-demand /estimate endpoint works fine without Kafka (see main()).
let kafkaProducerConnected = false;
let kafkaConsumerConnected = false;
producer.on(producer.events.CONNECT, () => (kafkaProducerConnected = true));
producer.on(producer.events.DISCONNECT, () => (kafkaProducerConnected = false));
consumer.on(consumer.events.CONNECT, () => (kafkaConsumerConnected = true));
consumer.on(consumer.events.DISCONNECT, () => (kafkaConsumerConnected = false));
consumer.on(consumer.events.CRASH, () => (kafkaConsumerConnected = false));

// A default delivery point for freight estimates in the demo; in
// production this comes from the authenticated buyer's saved delivery
// address.
const DEFAULT_BUYER_LOCATION: LatLng = [34.0522, -118.2437]; // Los Angeles, CA

interface LotRow {
  lot_id: string;
  damage_primary: string | null;
  damage_secondary: string | null;
  run_and_drive: boolean;
  yard_lat: string; // numeric columns come back as strings from `pg`
  yard_lon: string;
  photo_angles_captured: string[] | null;
}

interface FeeScheduleRow {
  membership_tier: string;
  min_bid: string;
  max_bid: string | null;
  fee_flat: string;
  fee_pct: string;
}

export interface CostEstimate {
  lot_id: string;
  bid_amount: number;
  buyer_fee: number;
  freight_estimate: number;
  freight_distance_miles: number;
  repair_low: number;
  repair_high: number;
  repair_confidence: string;
  total_landed_cost_low: number;
  total_landed_cost_high: number;
}

class NotFoundError extends Error {
  status = 404;
}

async function getFeeBrackets(client: PoolClient): Promise<FeeBracket[]> {
  const endTimer = postgresQueryDuration.startTimer({ query: "select_fee_schedules" });
  const { rows } = await client.query<FeeScheduleRow>("SELECT * FROM fee_schedules");
  endTimer();
  return rows.map((r) => ({
    membership_tier: r.membership_tier,
    min_bid: Number(r.min_bid),
    max_bid: r.max_bid === null ? null : Number(r.max_bid),
    fee_flat: Number(r.fee_flat),
    fee_pct: Number(r.fee_pct),
  }));
}

export async function buildEstimate(lotId: string, bidAmount: number, tier = "premier"): Promise<CostEstimate> {
  const endCalculationTimer = costCalculationDuration.startTimer({ tier });
  const client = await pool.connect();
  try {
    const lotQueryEndTimer = postgresQueryDuration.startTimer({ query: "select_lot" });
    const lotResult = await client.query<LotRow>("SELECT * FROM lots WHERE lot_id = $1", [lotId]);
    lotQueryEndTimer();
    const lot = lotResult.rows[0];
    if (!lot) {
      throw new NotFoundError(`lot ${lotId} not found`);
    }

    const brackets = await getFeeBrackets(client);
    const buyerFee = calculateBuyerFee(bidAmount, tier, brackets);

    const freight = regressionEstimate(
      [Number(lot.yard_lat), Number(lot.yard_lon)],
      DEFAULT_BUYER_LOCATION,
      "sedan" as VehicleClass,
      !lot.run_and_drive
    );

    const photoSignals = await getPhotoSignals(lot);
    const repair = estimateRepairBand(lot.damage_primary, lot.damage_secondary, lot.run_and_drive, photoSignals);

    const totalLow = bidAmount + buyerFee + freight.estimated_cost + repair.repair_low;
    const totalHigh = bidAmount + buyerFee + freight.estimated_cost + repair.repair_high;

    const estimate: CostEstimate = {
      lot_id: lotId,
      bid_amount: bidAmount,
      buyer_fee: buyerFee,
      freight_estimate: freight.estimated_cost,
      freight_distance_miles: freight.distance_miles,
      repair_low: repair.repair_low,
      repair_high: repair.repair_high,
      repair_confidence: repair.confidence,
      total_landed_cost_low: Math.round(totalLow * 100) / 100,
      total_landed_cost_high: Math.round(totalHigh * 100) / 100,
    };

    const insertQueryEndTimer = postgresQueryDuration.startTimer({ query: "insert_cost_estimate" });
    await client.query(
      `INSERT INTO cost_estimates
        (lot_id, bid_amount, buyer_fees, freight_estimate,
         repair_low, repair_high, repair_confidence, total_landed_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        lotId,
        bidAmount,
        buyerFee,
        freight.estimated_cost,
        repair.repair_low,
        repair.repair_high,
        repair.confidence,
        totalHigh,
      ]
    );
    insertQueryEndTimer();

    return estimate;
  } finally {
    client.release();
    endCalculationTimer();
  }
}

interface BidEvent {
  lot_id: string;
  bidder_id: string;
  amount: number;
  placed_at: number;
}

export async function consumeBids(): Promise<void> {
  // Standard KafkaJS signal for "is this consumer falling behind?" - the
  // lag between the highest offset in each fetched batch and the
  // partition's high watermark at fetch time.
  consumer.on(consumer.events.END_BATCH_PROCESS, ({ payload }) => {
    kafkaConsumerLag.set({ topic: payload.topic, partition: String(payload.partition) }, Number(payload.offsetLag));
  });

  // KafkaJS's connection-level retry (set on the client) does not cover
  // this: once consumer.run() crashes (e.g. GroupCoordinatorNotFound
  // during Kafka's internal __consumer_offsets topic warm-up), it just
  // stops - it does not reconnect on its own. This loop is what actually
  // recovers from that.
  const backoffMs = [1000, 2000, 5000, 10000, 15000];
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: "bids", fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          bidsProcessedTotal.inc();
          const event = JSON.parse(message.value.toString()) as BidEvent;
          const estimate = await buildEstimate(event.lot_id, Number(event.amount));
          logger.info("cost recalculated", {
            lot: estimate.lot_id,
            bid: estimate.bid_amount,
            cost: estimate.total_landed_cost_high,
            confidence: estimate.repair_confidence,
          });
          await producer.send({
            topic: "cost-updates",
            messages: [{ value: JSON.stringify(estimate) }],
          });
        },
      });
      return; // run() only resolves on graceful stop; crash throws instead
    } catch (err) {
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      logger.error("bids consumer crashed, retrying", { retry_in_ms: wait, ...errorFields(err) });
      try {
        await consumer.disconnect();
      } catch {
        // ignore - already dead
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
      attempt += 1;
    }
  }
}

export const app = express();

// Same reasoning as valuation-service: this endpoint is reachable directly
// from a browser fetch(), which is subject to CORS unlike the WebSocket
// path used for the streaming updates.
app.use((req: Request, res: Response, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/estimate/:lotId", async (req: Request, res: Response) => {
  try {
    const bidAmount = Number(req.query.bid_amount);
    const tier = (req.query.tier as string) || "premier";
    const estimate = await buildEstimate(req.params.lotId, bidAmount, tier);
    res.json(estimate);
  } catch (err) {
    const status = err instanceof NotFoundError ? err.status : 500;
    const message = err instanceof Error ? err.message : "unknown error";
    if (status >= 500) {
      logger.error("estimate request failed", { lot: req.params.lotId, ...errorFields(err) });
    } else {
      logger.warn("estimate request rejected", { lot: req.params.lotId, status, message });
    }
    res.status(status).json({ detail: message });
  }
});

// Liveness: is the process up and able to handle an HTTP request at all?
// Deliberately checks nothing external - a dependency outage should not
// make an orchestrator restart a perfectly healthy process, that's what
// /readyz is for.
app.get("/healthz", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/metrics", async (req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Readiness: can this instance actually do its job right now? Postgres is
// a hard requirement for /estimate (the primary HTTP path), so its
// unavailability fails readiness. Kafka is reported for visibility but
// does NOT gate readiness - by design (see the module comment above and
// docs/TESTING.md's Observability section), the on-demand /estimate
// endpoint stays usable even when Kafka is down or still starting up.
app.get("/readyz", async (req: Request, res: Response) => {
  let postgresReady = false;
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      postgresReady = true;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.warn("readiness check: Postgres unreachable", errorFields(err));
  }

  const checks = {
    postgres: postgresReady,
    kafka_producer: kafkaProducerConnected,
    kafka_consumer: kafkaConsumerConnected,
  };
  res.status(postgresReady ? 200 : 503).json({ status: postgresReady ? "ready" : "not_ready", checks });
});

async function connectProducerWithRetry(): Promise<void> {
  const backoffMs = [1000, 2000, 5000, 10000, 30000];
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await producer.connect();
      logger.info("Kafka producer connected");
      return;
    } catch (err) {
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      logger.error("Kafka producer connect failed, retrying", { retry_in_ms: wait, ...errorFields(err) });
      await new Promise((resolve) => setTimeout(resolve, wait));
      attempt += 1;
    }
  }
}

async function main(): Promise<void> {
  // The on-demand /estimate endpoint only needs Postgres, not Kafka - it
  // should stay available even if Kafka is down or still starting up.
  // Only the streaming recompute-on-every-bid path needs the producer.
  app.listen(config.port, () => logger.info("listening", { port: config.port }));

  await connectProducerWithRetry();
  consumeBids().catch((err) => logger.fatal("consumeBids crashed", errorFields(err)));
}

// Guarded so importing this module in tests (e.g. `import { app, buildEstimate }
// from "./index.js"` driven via supertest) doesn't also bind a real port or
// kick off the Kafka connect/retry loops.
if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    logger.fatal("fatal error", errorFields(err));
    process.exit(1);
  });
}
