import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { signBidderToken } from "../../src/auth.js";

// consumeAndBroadcast() constructs its own Kafka client per call; mocking
// kafkajs here lets the test drive the exact eachMessage handler the
// gateway registers for each topic, without a real broker.
const handlers: Record<string, (payload: { message: { value: Buffer | null } }) => Promise<void>> = {};

vi.mock("kafkajs", () => ({
  Kafka: vi.fn().mockImplementation(function Kafka(this: any, opts: { clientId: string }) {
    this.consumer = () => {
      const listeners: Record<string, Array<() => void>> = {};
      const emit = (event: string) => (listeners[event] || []).forEach((cb) => cb());
      return {
        events: { CONNECT: "consumer.connect", DISCONNECT: "consumer.disconnect", CRASH: "consumer.crash" },
        on: (event: string, cb: () => void) => {
          (listeners[event] ||= []).push(cb);
        },
        connect: vi.fn().mockImplementation(async () => emit("consumer.connect")),
        subscribe: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockImplementation(async ({ eachMessage }) => {
          // clientId is `gateway-${topic}` per the source - recover the topic from it
          const topic = opts.clientId.replace(/^gateway-/, "");
          handlers[topic] = eachMessage;
          return new Promise(() => {});
        }),
        disconnect: vi.fn().mockImplementation(async () => emit("consumer.disconnect")),
      };
    };
  }),
}));

describe("gateway - end-to-end Kafka -> WebSocket fan-out", () => {
  let baseUrl: string;
  let wsUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { server, consumeAndBroadcast, connections } = await import("../../src/index.js");
    connections.clear();

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}`;

    // Kick off both consumers the same way main() does, but against the mock.
    consumeAndBroadcast("cost-updates", "cost_update").catch(() => {});
    consumeAndBroadcast("anomaly-scores", "anomaly_score").catch(() => {});
    await vi.waitFor(() => {
      expect(handlers["cost-updates"]).toBeDefined();
      expect(handlers["anomaly-scores"]).toBeDefined();
    });
  });

  afterEach(async () => {
    const { server } = await import("../../src/index.js");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports connected lots on GET /health (deprecated alias)", async () => {
    const { server } = await import("../../src/index.js");
    const res = await request(server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.connected_lots).toEqual([]);
  });

  it("GET /healthz always returns 200 regardless of Kafka connection state", async () => {
    const { server } = await import("../../src/index.js");
    const res = await request(server).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 200 ready once both Kafka consumer groups have connected", async () => {
    // beforeEach already started both consumers and waited for them to
    // reach consumer.run() - their mocked connect() having resolved means
    // the CONNECT listener already fired.
    const { server } = await import("../../src/index.js");
    const res = await request(server).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      checks: { "cost-updates": true, "anomaly-scores": true },
    });
  });

  it("GET /metrics exposes Prometheus-format metrics including the custom ones this service defines", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("websocket_clients");
    expect(res.text).toContain("kafka_consumer_lag");
    expect(res.text).toContain("process_cpu_user_seconds_total");
  });

  it("websocket_clients gauge tracks a connection opening and closing", async () => {
    const { app } = await import("../../src/index.js");
    const token = signBidderToken("bidder-metrics-test");
    const client = new WebSocket(`${wsUrl}/ws/LOT-9999?token=${token}`);
    await new Promise((resolve) => client.on("open", resolve));

    let res = await request(app).get("/metrics");
    expect(res.text).toMatch(/websocket_clients\{[^}]*lot_id="LOT-9999"[^}]*\} 1/);

    client.close();
    await new Promise((resolve) => client.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    res = await request(app).get("/metrics");
    expect(res.text).toMatch(/websocket_clients\{[^}]*lot_id="LOT-9999"[^}]*\} 0/);
  });

  it("delivers a cost-updates Kafka event to a bidder connected over /ws/:lotId", async () => {
    const token = signBidderToken("bidder-cost-updates-test");
    const client = new WebSocket(`${wsUrl}/ws/LOT-1001?token=${token}`);
    await new Promise((resolve) => client.on("open", resolve));

    const received: unknown[] = [];
    client.on("message", (data) => received.push(JSON.parse(data.toString())));

    const event = { lot_id: "LOT-1001", total_landed_cost_low: 5000, total_landed_cost_high: 5200 };
    await handlers["cost-updates"]({ message: { value: Buffer.from(JSON.stringify(event)) } });

    await vi.waitFor(() => expect(received.length).toBe(1));
    expect(received[0]).toEqual({ type: "cost_update", data: event });

    client.close();
  });

  it("delivers an anomaly-scores Kafka event to the right lot only", async () => {
    const tokenA = signBidderToken("bidder-anomaly-test-a");
    const tokenB = signBidderToken("bidder-anomaly-test-b");
    const watchingLot1001 = new WebSocket(`${wsUrl}/ws/LOT-1001?token=${tokenA}`);
    const watchingLot9999 = new WebSocket(`${wsUrl}/ws/LOT-9999?token=${tokenB}`);
    await Promise.all([
      new Promise((resolve) => watchingLot1001.on("open", resolve)),
      new Promise((resolve) => watchingLot9999.on("open", resolve)),
    ]);

    const received1001: unknown[] = [];
    const received9999: unknown[] = [];
    watchingLot1001.on("message", (data) => received1001.push(JSON.parse(data.toString())));
    watchingLot9999.on("message", (data) => received9999.push(JSON.parse(data.toString())));

    const event = { lot_id: "LOT-1001", risk_level: "high", flags: [{ type: "bid_velocity" }] };
    await handlers["anomaly-scores"]({ message: { value: Buffer.from(JSON.stringify(event)) } });

    await vi.waitFor(() => expect(received1001.length).toBe(1));
    expect(received1001[0]).toEqual({ type: "anomaly_score", data: event });
    expect(received9999.length).toBe(0);

    watchingLot1001.close();
    watchingLot9999.close();
  });

  it("rejects upgrade requests to paths that don't match /ws/:lotId", async () => {
    const client = new WebSocket(`${wsUrl}/not-a-websocket-path`);
    const closeOrError = await new Promise((resolve) => {
      client.on("error", () => resolve("error"));
      client.on("close", () => resolve("close"));
    });
    expect(["error", "close"]).toContain(closeOrError);
  });

  it("rejects a WS upgrade with no token", async () => {
    const client = new WebSocket(`${wsUrl}/ws/LOT-1001`);
    const err: unknown = await new Promise((resolve) => client.on("error", resolve));
    expect(String(err)).toMatch(/401/);
  });

  it("rejects a WS upgrade with an invalid/tampered token", async () => {
    const token = signBidderToken("bidder-tampered-test");
    const tampered = token.slice(0, -3) + "xxx";
    const client = new WebSocket(`${wsUrl}/ws/LOT-1001?token=${tampered}`);
    const err: unknown = await new Promise((resolve) => client.on("error", resolve));
    expect(String(err)).toMatch(/401/);
  });

  it("rejects further WS upgrade attempts once a bidder's connection rate limit is exhausted", async () => {
    const token = signBidderToken("bidder-rate-limit-test");
    // Default RATE_LIMIT_WS_MAX_CONNECTIONS is 10 - open 10 to exhaust it,
    // then confirm the 11th is rejected.
    const clients: WebSocket[] = [];
    for (let i = 0; i < 10; i++) {
      const c = new WebSocket(`${wsUrl}/ws/LOT-1001?token=${token}`);
      await new Promise((resolve) => c.on("open", resolve));
      clients.push(c);
    }

    const eleventh = new WebSocket(`${wsUrl}/ws/LOT-1001?token=${token}`);
    const err: unknown = await new Promise((resolve) => eleventh.on("error", resolve));
    expect(String(err)).toMatch(/429/);

    clients.forEach((c) => c.close());
  });

  it("stops delivering to a socket after it disconnects", async () => {
    const token = signBidderToken("bidder-disconnect-test");
    const client = new WebSocket(`${wsUrl}/ws/LOT-1001?token=${token}`);
    await new Promise((resolve) => client.on("open", resolve));
    client.close();
    await new Promise((resolve) => client.on("close", resolve));

    // Give the server a tick to process the close event and clean up.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { connections } = await import("../../src/index.js");
    expect(connections.get("LOT-1001")?.size ?? 0).toBe(0);
  });
});

describe("gateway - /readyz before Kafka consumers have connected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 not_ready when neither consumer group has connected yet", async () => {
    vi.resetModules();
    // Deliberately does NOT call consumeAndBroadcast - simulating the
    // window right after process start, before Kafka has connected.
    const { server } = await import("../../src/index.js");
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const res = await request(server).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "not_ready",
      checks: { "cost-updates": false, "anomaly-scores": false },
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
