import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Same lifecycle-event pattern used in the other services' health tests:
// give the mocked producer a real .on()/.events surface so index.ts's
// readiness-tracking listeners fire CONNECT once connect() resolves.
vi.mock("kafkajs", () => ({
  Kafka: vi.fn().mockImplementation(function Kafka(this: any) {
    this.producer = () => {
      const listeners: Record<string, Array<() => void>> = {};
      const emit = (event: string) => (listeners[event] || []).forEach((cb) => cb());
      return {
        events: { CONNECT: "producer.connect", DISCONNECT: "producer.disconnect" },
        on: (event: string, cb: () => void) => {
          (listeners[event] ||= []).push(cb);
        },
        connect: vi.fn().mockImplementation(async () => emit("producer.connect")),
        send: vi.fn().mockResolvedValue(undefined),
      };
    };
  }),
}));

describe("bid-stream-consumer - /healthz and /readyz", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("GET /healthz always returns 200 regardless of Kafka connection state", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 503 not_ready before the producer has connected", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "not_ready", checks: { kafka_producer: false } });
  });

  it("GET /readyz returns 200 ready once the Kafka producer has connected", async () => {
    const { app, producer } = await import("../../src/index.js");
    await producer.connect();

    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { kafka_producer: true } });
  });

  it("GET /metrics exposes Prometheus-format metrics including process defaults", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("bids_published_total");
    expect(res.text).toContain("process_cpu_user_seconds_total");
  });
});
