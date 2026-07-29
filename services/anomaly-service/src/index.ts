/**
 * anomaly-service
 * ----------------
 * Consumes `bids`, scores each bid for integrity risk via
 * BidAnomalyDetector, and publishes results to `anomaly-scores`. The
 * gateway merges this into the live feed alongside cost updates so a
 * bidder (or an ops dashboard) sees risk flags in real time, not in a
 * nightly batch report.
 */

import express, { Request, Response } from "express";
import { Kafka } from "kafkajs";
import { Redis } from "ioredis";
import { BidAnomalyDetector } from "./detectors/bidVelocity.js";
import { config } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { anomalyScoreTotal, bidsProcessedTotal, kafkaConsumerLag, register } from "./metrics.js";

const kafka = new Kafka({
  clientId: "anomaly-service",
  brokers: [config.kafkaBootstrap],
  // Confluent's Kafka image genuinely takes longer to finish leader
  // election / become queryable than KafkaJS's default retry budget
  // (5 retries, ~15-20s total) allows for on a cold docker-compose start.
  // This is defense-in-depth alongside the compose healthcheck gating.
  retry: { retries: 15, initialRetryTime: 500, maxRetryTime: 30000 },
});
const consumer = kafka.consumer({ groupId: "anomaly-service" });
export const producer = kafka.producer();
const redis = new Redis(config.redisUrl);
// ioredis emits 'error' on connection-level failures (e.g. Redis down or
// unreachable) separately from command-level rejections - without a
// listener here, an unhandled 'error' event crashes the whole process.
// ioredis reconnects automatically by default, so logging and continuing
// is the right response rather than treating this as fatal.
redis.on("error", (err) => logger.error("Redis connection error", errorFields(err)));
const detector = new BidAnomalyDetector(redis);

// Tracked via each client's own lifecycle events (KafkaJS, ioredis) rather
// than a flag set manually in a try/catch, so it can't drift out of sync
// with what the client actually did. Used by /readyz below.
let kafkaProducerConnected = false;
let kafkaConsumerConnected = false;
let redisConnected = false;
producer.on(producer.events.CONNECT, () => (kafkaProducerConnected = true));
producer.on(producer.events.DISCONNECT, () => (kafkaProducerConnected = false));
consumer.on(consumer.events.CONNECT, () => (kafkaConsumerConnected = true));
consumer.on(consumer.events.DISCONNECT, () => (kafkaConsumerConnected = false));
consumer.on(consumer.events.CRASH, () => (kafkaConsumerConnected = false));
redis.on("ready", () => (redisConnected = true));
redis.on("close", () => (redisConnected = false));

// This service has no HTTP API of its own (it's a pure Kafka
// consumer/producer), but still exposes /healthz and /readyz on a small
// Express app so it can be monitored/orchestrated the same way as the
// other four services.
export const app = express();

app.get("/healthz", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/readyz", (req: Request, res: Response) => {
  const checks = {
    kafka_producer: kafkaProducerConnected,
    kafka_consumer: kafkaConsumerConnected,
    redis: redisConnected,
  };
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});

app.get("/metrics", async (req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

interface BidEvent {
  lot_id: string;
  bidder_id: string;
  amount: number;
  placed_at: number;
}

export async function consumeBids(): Promise<void> {
  consumer.on(consumer.events.END_BATCH_PROCESS, ({ payload }) => {
    kafkaConsumerLag.set({ topic: payload.topic, partition: String(payload.partition) }, Number(payload.offsetLag));
  });

  // See cost-engine's consumeBids for why this loop exists: consumer.run()
  // does not auto-restart after a Crash event (e.g. GroupCoordinatorNotFound
  // during Kafka's internal __consumer_offsets warm-up).
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
          const score = await detector.scoreBid(
            event.lot_id,
            event.bidder_id,
            Number(event.amount),
            Number(event.placed_at)
          );
          anomalyScoreTotal.inc({ risk_level: score.risk_level });

          if (score.risk_level !== "low") {
            logger.warn("anomaly score", { ...score });
          }

          await producer.send({
            topic: "anomaly-scores",
            messages: [{ value: JSON.stringify(score) }],
          });
        },
      });
      return;
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

async function main(): Promise<void> {
  // The health-check server binds immediately and independently of Kafka
  // being ready - an orchestrator should be able to see this process as
  // "alive" (though not yet "ready") from the moment it starts.
  app.listen(config.port, () => logger.info("listening", { port: config.port }));

  await producer.connect();
  await consumeBids();
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    logger.fatal("fatal error", errorFields(err));
    process.exit(1);
  });
}
