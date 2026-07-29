import { execSync } from "node:child_process";
import { KafkaContainer, StartedKafkaContainer } from "@testcontainers/kafka";
import { Kafka } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// This suite runs cost-engine's *real* consumeBids() against a real,
// disposable Kafka broker in KRaft mode - matching the production
// docker-compose topology (see docker-compose.yml). It complements
// test/integration/http.test.ts (mocked pg, no Kafka involved) by
// covering the other half of cost-engine's job: the bids -> cost-updates
// streaming recompute path, with real topics, real consumer-group
// behavior, and real message serialization - none of which a mocked
// kafkajs client can catch.
//
// Postgres is still mocked here (see the `vi.mock("pg", ...)` below) so
// this suite is scoped to the Kafka boundary specifically; the real-DB
// path is covered separately by test/integration/postgres.test.ts.
//
// consumeBids() (and its underlying Kafka client/consumer group) is
// started exactly once for the whole suite rather than per-test, since
// tearing it down and re-importing the module between tests would spin
// up a second "cost-engine" consumer group instance and trigger a real
// rebalance mid-suite - unnecessary noise for what this is trying to
// verify.
//
// Requires a Docker daemon. Skips itself (not fails) when none is
// reachable, same as the other real-infra suites in this repo.

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const LOT_ROW = {
  lot_id: "LOT-1001",
  damage_primary: "Front End",
  damage_secondary: null,
  run_and_drive: true,
  yard_lat: "32.7767",
  yard_lon: "-96.7970",
  photo_angles_captured: ["front", "rear", "side", "undercarriage", "engine_bay", "interior"],
};

const FEE_SCHEDULE_ROWS = [
  { membership_tier: "premier", min_bid: "0", max_bid: "2000", fee_flat: "50", fee_pct: "0" },
  { membership_tier: "premier", min_bid: "2000", max_bid: "10000", fee_flat: "50", fee_pct: "0.06" },
  { membership_tier: "premier", min_bid: "10000", max_bid: null, fee_flat: "50", fee_pct: "0.04" },
];

const queryMock = vi.fn().mockImplementation((sql: string) => {
  if (sql.includes("FROM lots")) return Promise.resolve({ rows: [LOT_ROW] });
  if (sql.includes("FROM fee_schedules")) return Promise.resolve({ rows: FEE_SCHEDULE_ROWS });
  if (sql.includes("INSERT INTO cost_estimates")) return Promise.resolve({ rows: [] });
  return Promise.resolve({ rows: [] });
});
const releaseMock = vi.fn();
const connectMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });

vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(function Pool(this: any) {
    this.connect = connectMock;
  }),
}));

describe.runIf(dockerAvailable())("cost-engine - real Kafka (KRaft) integration", () => {
  let container: StartedKafkaContainer;
  let testProducer: ReturnType<Kafka["producer"]>;
  let resultsConsumer: ReturnType<Kafka["consumer"]>;
  const received: Array<{ lot_id: string; bid_amount: number; buyer_fee: number }> = [];

  beforeAll(async () => {
    container = await new KafkaContainer("confluentinc/cp-kafka:7.6.0").withKraft().start();
    const bootstrapServers = `${container.getHost()}:${container.getMappedPort(9093)}`;
    process.env.KAFKA_BOOTSTRAP = bootstrapServers;

    // A separate client stands in for "the rest of the world" - publishing
    // bids the way bid-stream-consumer does, and reading cost-updates the
    // way the gateway does - kept independent of the module under test.
    const testKafka = new Kafka({ clientId: "test-harness", brokers: [bootstrapServers] });
    testProducer = testKafka.producer();
    resultsConsumer = testKafka.consumer({ groupId: "test-harness-results" });
    await testProducer.connect();
    await resultsConsumer.connect();
    await resultsConsumer.subscribe({ topic: "cost-updates", fromBeginning: true });
    resultsConsumer
      .run({
        eachMessage: async ({ message }) => {
          if (message.value) received.push(JSON.parse(message.value.toString()));
        },
      })
      .catch(() => {});

    // Start cost-engine's real consumer/producer against the real broker.
    const { producer, consumeBids } = await import("../../src/index.js");
    await producer.connect();
    consumeBids().catch(() => {}); // never resolves in the success path, same as production
  }, 120_000);

  afterAll(async () => {
    await testProducer?.disconnect();
    await resultsConsumer?.disconnect();
    await container?.stop();
  });

  // Kafka consumer group startup (join group, partition assignment) has
  // real, variable latency - the app's `bids` consumer may not have
  // finished joining by the time the first message is produced. Rather
  // than sleep-and-hope, keep re-publishing the same event until it shows
  // up on the other side of the pipeline.
  async function produceUntilConsumed(
    event: Record<string, unknown>,
    matches: (msg: { bid_amount: number }) => boolean,
    { retries = 10, intervalMs = 1500 } = {}
  ): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      await testProducer.send({ topic: "bids", messages: [{ value: JSON.stringify(event) }] });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (received.some(matches)) return;
    }
  }

  it(
    "consumes a real bid off `bids` and publishes the recomputed estimate to `cost-updates`",
    async () => {
      const amount = 4200;
      await produceUntilConsumed(
        { lot_id: "LOT-1001", bidder_id: "bidder-real-kafka-test", amount, placed_at: Date.now() / 1000 },
        (msg) => msg.bid_amount === amount
      );

      const estimate = received.find((r) => r.bid_amount === amount);
      expect(estimate).toBeDefined();
      expect(estimate!.lot_id).toBe("LOT-1001");
      // premier bracket at 4200: 50 + 4200*0.06 = 302
      expect(estimate!.buyer_fee).toBe(302);
      expect(releaseMock).toHaveBeenCalled();
    },
    45_000
  );

  it(
    "keeps consuming subsequent bids on the same lot after the first message",
    async () => {
      const amounts = [5100, 5300];
      for (const amount of amounts) {
        await produceUntilConsumed(
          { lot_id: "LOT-1001", bidder_id: "bidder-sequence-test", amount, placed_at: Date.now() / 1000 },
          (msg) => msg.bid_amount === amount
        );
      }
      for (const amount of amounts) {
        expect(received.some((r) => r.bid_amount === amount)).toBe(true);
      }
    },
    45_000
  );
});
