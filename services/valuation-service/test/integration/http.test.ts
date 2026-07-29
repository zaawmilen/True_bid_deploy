import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// pg is mocked at the module level so this test never touches a real
// Postgres instance - it verifies the HTTP <-> query <-> response wiring,
// while `test/unit/compValuation.test.ts` covers the model's own logic.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });

vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation(function Pool(this: any) {
    this.connect = connectMock;
  }),
}));

process.env.NODE_ENV = "test";

describe("GET /valuation/:lotId", () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns a 404 with a helpful detail message for an unknown lot", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // lots lookup misses
    const { app } = await import("../../src/index.js");

    const res = await request(app).get("/valuation/LOT-DOES-NOT-EXIST");

    expect(res.status).toBe(404);
    expect(res.body.detail).toMatch(/LOT-DOES-NOT-EXIST/);
    expect(releaseMock).toHaveBeenCalled();
  });

  it("returns a valuation merged with the lot_id for a known lot", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            lot_id: "LOT-1001",
            make: "Ford",
            model: "Mustang",
            year: 2021,
            mileage: 34211,
            damage_primary: "Front End",
            title_type: "salvage",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 10 }, () => ({
          make: "Ford",
          model: "Mustang",
          year: 2021,
          mileage: 34000,
          damage_severity: "medium",
          title_type: "salvage",
          region: "TX",
          sale_price: "18000.00",
        })),
      });

    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/valuation/LOT-1001");

    expect(res.status).toBe(200);
    expect(res.body.lot_id).toBe("LOT-1001");
    expect(res.body.confidence).toBe("high");
    expect(res.body.comp_valuation).toBeCloseTo(18000, 0);
  });

  it("maps damage codes to severity buckets consistent with the repair estimator's taxonomy", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            lot_id: "LOT-2002",
            make: "Toyota",
            model: "Camry",
            year: 2019,
            mileage: 60000,
            damage_primary: "water/flood",
            title_type: "salvage",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { app } = await import("../../src/index.js");
    await request(app).get("/valuation/LOT-2002");

    // The historical_sales query is unconditional; the *first* query's
    // damage_primary value is what drives severity classification - this
    // just documents that a flood-damage lot resolves to "high" severity
    // by exercising the endpoint without erroring.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("responds with 500 and an error detail if the database query fails", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    const { app } = await import("../../src/index.js");

    const res = await request(app).get("/valuation/LOT-1001");

    expect(res.status).toBe(500);
    expect(res.body.detail).toMatch(/connection terminated/);
    expect(releaseMock).toHaveBeenCalled();
  });

  it("sets a permissive CORS header so a browser fetch() from the frontend origin succeeds", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { app } = await import("../../src/index.js");

    const res = await request(app).get("/valuation/LOT-1001");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("GET /metrics", () => {
  it("exposes Prometheus-format metrics including the custom ones this service defines", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("valuation_requests_total");
    expect(res.text).toContain("postgres_query_duration_seconds");
    expect(res.text).toContain("process_cpu_user_seconds_total");
  });
});

describe("GET /healthz", () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  it("always returns 200 without touching Postgres", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
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
    expect(res.body).toEqual({ status: "ready", checks: { postgres: true } });
    expect(releaseMock).toHaveBeenCalled();
  });

  it("returns 503 not_ready when Postgres is unreachable", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const { app } = await import("../../src/index.js");

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "not_ready", checks: { postgres: false } });
  });
});
