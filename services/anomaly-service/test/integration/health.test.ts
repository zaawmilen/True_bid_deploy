import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Same lifecycle-event pattern as test/integration/kafka.test.ts, kept
// self-contained here since vi.mock factories are file-scoped.
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
          subscribe: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockImplementation(() => new Promise(() => {})),
          disconnect: vi.fn().mockResolvedValue(undefined),
        },
        { CONNECT: "consumer.connect", DISCONNECT: "consumer.disconnect", CRASH: "consumer.crash" },
        async () => undefined
      );
    this.producer = () =>
      withLifecycleEvents(
        { send: vi.fn().mockResolvedValue(undefined) },
        { CONNECT: "producer.connect", DISCONNECT: "producer.disconnect" },
        async () => undefined
      );
  }),
}));

// A fake ioredis client whose `on()` actually stores listeners and can be
// told to emit "ready" - unlike kafka.test.ts's no-op version, this test
// file specifically needs Redis readiness state to be controllable.
let emitRedisReady: () => void = () => undefined;

vi.mock("ioredis", () => {
  class FakeRedis {
    private listeners: Record<string, Array<() => void>> = {};
    on(event: string, cb: () => void) {
      (this.listeners[event] ||= []).push(cb);
      if (event === "ready") {
        emitRedisReady = () => (this.listeners["ready"] || []).forEach((fn) => fn());
      }
      return this;
    }
  }
  return { Redis: FakeRedis };
});

describe("anomaly-service - /healthz and /readyz", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("GET /healthz always returns 200 regardless of dependency state", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 503 not_ready before anything has connected", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "not_ready",
      checks: { kafka_producer: false, kafka_consumer: false, redis: false },
    });
  });

  it("GET /readyz returns 200 ready once Kafka producer/consumer and Redis have all connected", async () => {
    const { app, producer, consumeBids } = await import("../../src/index.js");
    await producer.connect();
    consumeBids().catch(() => {});
    emitRedisReady();

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      checks: { kafka_producer: true, kafka_consumer: true, redis: true },
    });
  });

  it("GET /readyz reflects a partial outage (e.g. Redis down, Kafka fine) as not_ready", async () => {
    const { app, producer, consumeBids } = await import("../../src/index.js");
    await producer.connect();
    consumeBids().catch(() => {});
    // Redis never reaches "ready" in this test.

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ kafka_producer: true, kafka_consumer: true, redis: false });
  });

  it("GET /metrics exposes Prometheus-format metrics including the custom ones this service defines", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("bids_processed_total");
    expect(res.text).toContain("anomaly_score_total");
    expect(res.text).toContain("redis_latency_seconds");
    expect(res.text).toContain("kafka_consumer_lag");
    expect(res.text).toContain("process_cpu_user_seconds_total");
  });
});
