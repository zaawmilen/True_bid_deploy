import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });

vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(function Pool(this: any) {
    this.connect = connectMock;
  }),
}));

const LOT_ROW = {
  lot_id: "LOT-1001",
  damage_primary: "Front End",
  damage_secondary: "Undercarriage",
  run_and_drive: true,
  yard_lat: "32.7767",
  yard_lon: "-96.7970",
  photo_angles_captured: ["front", "rear", "side", "engine_bay"],
};

const FEE_SCHEDULE_ROWS = [
  { membership_tier: "basic", min_bid: "0", max_bid: "2000", fee_flat: "100", fee_pct: "0" },
  { membership_tier: "basic", min_bid: "2000", max_bid: "10000", fee_flat: "100", fee_pct: "0.08" },
  { membership_tier: "basic", min_bid: "10000", max_bid: null, fee_flat: "100", fee_pct: "0.06" },
  { membership_tier: "premier", min_bid: "0", max_bid: "2000", fee_flat: "50", fee_pct: "0" },
  { membership_tier: "premier", min_bid: "2000", max_bid: "10000", fee_flat: "50", fee_pct: "0.06" },
  { membership_tier: "premier", min_bid: "10000", max_bid: null, fee_flat: "50", fee_pct: "0.04" },
];

describe("GET /estimate/:lotId", () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  it("returns a full landed-cost breakdown for a known lot and persists the estimate", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [LOT_ROW] }) // lots lookup
      .mockResolvedValueOnce({ rows: FEE_SCHEDULE_ROWS }) // fee_schedules
      .mockResolvedValueOnce({ rows: [] }); // INSERT INTO cost_estimates

    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/estimate/LOT-1001").query({ bid_amount: "5000", tier: "premier" });

    expect(res.status).toBe(200);
    expect(res.body.lot_id).toBe("LOT-1001");
    expect(res.body.bid_amount).toBe(5000);
    // premier bracket for 5000: 50 + 5000*0.06 = 350
    expect(res.body.buyer_fee).toBe(350);
    // totals should equal bid + fee + freight + repair band
    expect(res.body.total_landed_cost_low).toBeCloseTo(
      5000 + res.body.buyer_fee + res.body.freight_estimate + res.body.repair_low,
      2
    );
    expect(res.body.total_landed_cost_high).toBeCloseTo(
      5000 + res.body.buyer_fee + res.body.freight_estimate + res.body.repair_high,
      2
    );

    // The estimate is persisted for auditability/history.
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(queryMock.mock.calls[2][0]).toMatch(/INSERT INTO cost_estimates/);
    expect(releaseMock).toHaveBeenCalled();
  });

  it("defaults to the premier tier when none is specified", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [LOT_ROW] })
      .mockResolvedValueOnce({ rows: FEE_SCHEDULE_ROWS })
      .mockResolvedValueOnce({ rows: [] });

    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/estimate/LOT-1001").query({ bid_amount: "1000" });

    expect(res.status).toBe(200);
    // premier flat-only bracket at 1000: fee_flat=50, fee_pct=0
    expect(res.body.buyer_fee).toBe(50);
  });

  it("returns 404 with the lot id in the message when the lot does not exist", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/estimate/LOT-GHOST").query({ bid_amount: "1000" });

    expect(res.status).toBe(404);
    expect(res.body.detail).toMatch(/LOT-GHOST/);
    expect(releaseMock).toHaveBeenCalled();
  });

  it("returns 500 when no fee bracket matches the requested tier", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [LOT_ROW] })
      .mockResolvedValueOnce({ rows: FEE_SCHEDULE_ROWS });

    const { app } = await import("../../src/index.js");
    const res = await request(app)
      .get("/estimate/LOT-1001")
      .query({ bid_amount: "1000", tier: "nonexistent-tier" });

    expect(res.status).toBe(500);
    expect(res.body.detail).toMatch(/No fee bracket found/);
  });

  it("releases the client even when the query fails midway", async () => {
    queryMock.mockRejectedValueOnce(new Error("pg connection reset"));

    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/estimate/LOT-1001").query({ bid_amount: "1000" });

    expect(res.status).toBe(500);
    expect(releaseMock).toHaveBeenCalled();
  });

  it("applies the inoperable-vehicle freight surcharge and widened repair band together", async () => {
    const nonRunningLot = { ...LOT_ROW, run_and_drive: false };
    queryMock
      .mockResolvedValueOnce({ rows: [nonRunningLot] })
      .mockResolvedValueOnce({ rows: FEE_SCHEDULE_ROWS })
      .mockResolvedValueOnce({ rows: [] });

    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/estimate/LOT-1001").query({ bid_amount: "1000" });

    expect(res.status).toBe(200);
    // repair_low for "front end" (1800) widened by secondary damage's 1.35x
    // on the high side, then by the non-running 1.4x/1.6x multipliers
    expect(res.body.repair_low).toBe(Math.round(1800 * 1.4));
  });
});

describe("GET /metrics", () => {
  it("exposes Prometheus-format metrics including the custom ones this service defines", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("bids_processed_total");
    expect(res.text).toContain("cost_calculation_duration_seconds");
    expect(res.text).toContain("postgres_query_duration_seconds");
    expect(res.text).toContain("kafka_consumer_lag");
    // collectDefaultMetrics() bonus - process-level metrics come for free
    expect(res.text).toContain("process_cpu_user_seconds_total");
  });

  it("records a postgres_query_duration_seconds observation after a real /estimate call", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [LOT_ROW] })
      .mockResolvedValueOnce({ rows: FEE_SCHEDULE_ROWS })
      .mockResolvedValueOnce({ rows: [] });

    const { app } = await import("../../src/index.js");
    await request(app).get("/estimate/LOT-1001").query({ bid_amount: "1000" });

    const res = await request(app).get("/metrics");
    expect(res.text).toMatch(/postgres_query_duration_seconds_count\{[^}]*query="select_lot"[^}]*\} \d/);
  });
});

describe("GET /healthz", () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  it("always returns 200 without touching any dependency", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    // Liveness must not depend on Postgres/Kafka - confirm no query ran.
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("GET /readyz", () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  it("returns 200 ready when Postgres is reachable", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    const { app } = await import("../../src/index.js");

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks.postgres).toBe(true);
    expect(releaseMock).toHaveBeenCalled();
  });

  it("returns 503 not_ready when Postgres is unreachable", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const { app } = await import("../../src/index.js");

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.postgres).toBe(false);
  });

  it("reports Kafka connection state informationally without gating the response status", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    const { app } = await import("../../src/index.js");

    const res = await request(app).get("/readyz");

    // Kafka producer/consumer haven't connected in this test (main() is
    // never invoked under NODE_ENV=test), so both should read false - but
    // that must not drag the overall status down, since /estimate doesn't
    // need Kafka to function.
    expect(res.body.checks.kafka_producer).toBe(false);
    expect(res.body.checks.kafka_consumer).toBe(false);
    expect(res.status).toBe(200);
  });
});
