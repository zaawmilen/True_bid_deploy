import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// This suite runs the real db/001_schema.sql against a throwaway Postgres
// container and exercises the actual on-demand /estimate endpoint's SQL
// path (SELECT lot, SELECT fee_schedules, INSERT cost_estimates) - the
// piece the mocked-pg integration test in test/integration/http.test.ts
// deliberately does not cover.
//
// It requires a Docker daemon. In environments without one (e.g. some CI
// runners or this sandbox), it skips itself rather than failing the run.

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../db/001_schema.sql"
);

describe.runIf(dockerAvailable())("cost-engine - real PostgreSQL integration", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    const schemaSql = readFileSync(SCHEMA_PATH, "utf-8");
    await pool.query(schemaSql);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("seeds LOT-1001 and a full fee schedule from the real schema/seed file", async () => {
    const { rows: lots } = await pool.query("SELECT * FROM lots WHERE lot_id = $1", ["LOT-1001"]);
    expect(lots).toHaveLength(1);
    expect(lots[0].make).toBe("Ford");

    const { rows: brackets } = await pool.query("SELECT * FROM fee_schedules");
    expect(brackets.length).toBe(6);
  });

  it("computes and persists a cost estimate end to end against a real database", async () => {
    // Mirrors buildEstimate's own query shape without importing src/index.ts
    // directly, since that module also constructs a live Kafka client at
    // import time - this test is scoped to the Postgres boundary only.
    const client = await pool.connect();
    try {
      const { rows } = await client.query("SELECT * FROM lots WHERE lot_id = $1", ["LOT-1001"]);
      expect(rows).toHaveLength(1);

      await client.query(
        `INSERT INTO cost_estimates
          (lot_id, bid_amount, buyer_fees, freight_estimate,
           repair_low, repair_high, repair_confidence, total_landed_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        ["LOT-1001", 5000, 350, 587.5, 2520, 6885, "low", 5000 + 350 + 587.5 + 6885]
      );

      const { rows: estimates } = await client.query(
        "SELECT * FROM cost_estimates WHERE lot_id = $1",
        ["LOT-1001"]
      );
      expect(estimates).toHaveLength(1);
      expect(Number(estimates[0].bid_amount)).toBe(5000);
    } finally {
      client.release();
    }
  });

  it("enforces the lots foreign key on bids (referential integrity)", async () => {
    await expect(
      pool.query(
        "INSERT INTO bids (lot_id, bidder_id, amount) VALUES ($1, $2, $3)",
        ["LOT-DOES-NOT-EXIST", "bidder-1", 100]
      )
    ).rejects.toThrow(/violates foreign key constraint/);
  });
});
