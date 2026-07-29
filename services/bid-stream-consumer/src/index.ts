/**
 * bid-stream-consumer
 * --------------------
 * In production this service subscribes to the bid-event feed from the
 * existing real-time auction platform (webhook, a Kafka topic it already
 * emits, or a websocket you tap into) and re-publishes normalized events
 * onto the `bids` topic that the rest of TrueBid consumes.
 *
 * For local/demo purposes it *simulates* a live auction on LOT-1001 so the
 * rest of the stack (cost-engine, anomaly-service, gateway) has something
 * real to react to end to end.
 */

import express, { Request, Response } from "express";
import { Kafka } from "kafkajs";
import { config } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { bidsPublishedTotal, register } from "./metrics.js";

const LOT_ID = "LOT-1001";
const BIDDERS = Array.from({ length: 8 }, (_, i) => `bidder-${i + 1}`);

const kafka = new Kafka({
  clientId: "bid-stream-consumer",
  brokers: [config.kafkaBootstrap],
  retry: { retries: 15, initialRetryTime: 500, maxRetryTime: 30000 },
});
export const producer = kafka.producer();

// Tracked via KafkaJS's own lifecycle events rather than a flag set
// manually in a try/catch. Used by /readyz below.
let kafkaProducerConnected = false;
producer.on(producer.events.CONNECT, () => (kafkaProducerConnected = true));
producer.on(producer.events.DISCONNECT, () => (kafkaProducerConnected = false));

// This service has no HTTP API of its own (it's a pure Kafka producer
// simulating a live auction feed), but still exposes /healthz and
// /readyz on a small Express app so it can be monitored/orchestrated the
// same way as the other four services.
export const app = express();

app.get("/healthz", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/readyz", (req: Request, res: Response) => {
  const checks = { kafka_producer: kafkaProducerConnected };
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});

app.get("/metrics", async (req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

export function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export interface BidEvent {
  lot_id: string;
  bidder_id: string;
  amount: number;
  placed_at: number;
}

// Pulled out of the loop so the bid-generation rule (monotonically
// increasing, random bump, random bidder) can be unit tested without
// spinning up the infinite loop or a real Kafka producer.
export function nextBidEvent(previousBid: number): BidEvent {
  const bump = randomChoice([25, 50, 75, 100, 150]);
  return {
    lot_id: LOT_ID,
    bidder_id: randomChoice(BIDDERS),
    amount: previousBid + bump,
    placed_at: Date.now() / 1000,
  };
}

export async function simulateAuction(): Promise<void> {
  let currentBid = 500;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const event = nextBidEvent(currentBid);
    currentBid = event.amount;

    await producer.send({
      topic: "bids",
      messages: [{ value: JSON.stringify(event) }],
    });
    bidsPublishedTotal.inc();
    logger.info("bid placed", { bidder: event.bidder_id, amount: currentBid, lot: LOT_ID });

    // Real auctions burst near the end and slow down early on; a random
    // sleep keeps the demo visually honest to that pattern.
    await new Promise((resolve) => setTimeout(resolve, randomBetween(500, 3000)));
  }
}

async function main(): Promise<void> {
  // The health-check server binds immediately and independently of Kafka
  // being ready - see the same reasoning in anomaly-service's main().
  app.listen(config.port, () => logger.info("listening", { port: config.port }));

  await producer.connect();
  await simulateAuction();
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    logger.fatal("fatal error", errorFields(err));
    process.exit(1);
  });
}
