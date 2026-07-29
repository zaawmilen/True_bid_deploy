import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the eachMessage handler the service registers so the test can
// drive it directly with fabricated Kafka messages - this exercises the
// real consumeBids() wiring (JSON parsing, detector call, produce to
// anomaly-scores) without a real broker.
let eachMessageHandler: ((payload: { message: { value: Buffer | null } }) => Promise<void>) | undefined;

const consumerConnect = vi.fn().mockResolvedValue(undefined);
const consumerSubscribe = vi.fn().mockResolvedValue(undefined);
const consumerRun = vi.fn().mockImplementation(async ({ eachMessage }) => {
  eachMessageHandler = eachMessage;
  // Never resolves on its own in real kafkajs; mirror that here so
  // consumeBids() doesn't return early during the test.
  return new Promise(() => {});
});

const producerConnect = vi.fn().mockResolvedValue(undefined);
const producerSend = vi.fn().mockResolvedValue(undefined);

// Minimal event-emitter shape so index.ts's readiness-tracking
// `.on(events.CONNECT, ...)` listeners have something real to attach to,
// firing CONNECT once connect() resolves (mirroring real KafkaJS).
function withLifecycleEvents<T extends Record<string, unknown>>(
  base: T,
  events: { CONNECT: string; DISCONNECT: string; CRASH?: string },
  connectFn: (...args: unknown[]) => Promise<unknown>
) {
  const listeners: Record<string, Array<() => void>> = {};
  const emit = (event: string) => (listeners[event] || []).forEach((cb) => cb());
  return {
    ...base,
    events,
    on: (event: string, cb: () => void) => {
      (listeners[event] ||= []).push(cb);
    },
    connect: vi.fn().mockImplementation(async (...args: unknown[]) => {
      const result = await connectFn(...args);
      emit(events.CONNECT);
      return result;
    }),
  };
}

vi.mock("kafkajs", () => ({
  Kafka: vi.fn().mockImplementation(function Kafka(this: any) {
    this.consumer = () =>
      withLifecycleEvents(
        {
          subscribe: consumerSubscribe,
          run: consumerRun,
          disconnect: vi.fn().mockResolvedValue(undefined),
        },
        { CONNECT: "consumer.connect", DISCONNECT: "consumer.disconnect", CRASH: "consumer.crash" },
        consumerConnect
      );
    this.producer = () =>
      withLifecycleEvents(
        { send: producerSend },
        { CONNECT: "producer.connect", DISCONNECT: "producer.disconnect" },
        producerConnect
      );
  }),
}));

// ioredis auto-connects on construction; a lightweight fake avoids any real
// network call and gives BidAnomalyDetector just enough surface to run.
vi.mock("ioredis", () => {
  const store = new Map<string, string[]>();
  class FakeRedis {
    async lpush(key: string, value: string) {
      const list = store.get(key) ?? [];
      list.unshift(String(value));
      store.set(key, list);
      return list.length;
    }
    async ltrim(key: string, start: number, stop: number) {
      const list = store.get(key) ?? [];
      store.set(key, list.slice(start, stop + 1));
      return "OK";
    }
    async expire() {
      return 1;
    }
    async lrange(key: string, start: number, stop: number) {
      const list = store.get(key) ?? [];
      return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
    }
    async zadd() {
      return 1;
    }
    async zremrangebyscore() {
      return 0;
    }
    async zcard() {
      return 1; // stays below the repeated-pair alert count in these tests
    }
    on() {
      // no-op: index.ts registers an error listener on the real client;
      // this fake has no connection-level events to emit.
      return this;
    }
  }
  return { Redis: FakeRedis };
});

describe("anomaly-service - bids -> anomaly-scores Kafka event processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eachMessageHandler = undefined;
  });

  it("subscribes to `bids` and publishes a low-risk score for a first-time bid", async () => {
    const { consumeBids } = await import("../../src/index.js");
    consumeBids(); // fire and forget - it never resolves, mirroring the real run() loop

    await vi.waitFor(() => expect(eachMessageHandler).toBeDefined());
    expect(consumerSubscribe).toHaveBeenCalledWith({ topic: "bids", fromBeginning: false });

    const event = { lot_id: "LOT-1001", bidder_id: "bidder-1", amount: 500, placed_at: 1000 };
    await eachMessageHandler!({ message: { value: Buffer.from(JSON.stringify(event)) } });

    expect(producerSend).toHaveBeenCalledTimes(1);
    const [{ topic, messages }] = producerSend.mock.calls[0];
    expect(topic).toBe("anomaly-scores");
    const published = JSON.parse(messages[0].value);
    expect(published.lot_id).toBe("LOT-1001");
    expect(published.risk_level).toBe("low");
  });

  it("ignores Kafka tombstone messages (null value) without crashing or publishing", async () => {
    const { consumeBids } = await import("../../src/index.js");
    consumeBids();
    await vi.waitFor(() => expect(eachMessageHandler).toBeDefined());

    await eachMessageHandler!({ message: { value: null } });
    expect(producerSend).not.toHaveBeenCalled();
  });

  it("coerces string amounts/timestamps from the wire format to numbers before scoring", async () => {
    const { consumeBids } = await import("../../src/index.js");
    consumeBids();
    await vi.waitFor(() => expect(eachMessageHandler).toBeDefined());

    const event = { lot_id: "LOT-9", bidder_id: "bidder-9", amount: "750", placed_at: "1000" };
    await eachMessageHandler!({ message: { value: Buffer.from(JSON.stringify(event)) } });

    const published = JSON.parse(producerSend.mock.calls[0][0].messages[0].value);
    expect(published.amount).toBe(750);
  });
});
