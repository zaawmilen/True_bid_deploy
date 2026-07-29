import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

// DO NOT statically import { pool } or { app } here!
// Top-level imports evaluate before beforeAll() sets process.env.DATABASE_URL,
// causing pg.Pool to bind to default host 'base' and throw getaddrinfo EAI_AGAIN.

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

describe.runIf(dockerAvailable())("valuation-service - real PostgreSQL integration", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();

    // 1. Set environment variable FIRST so dynamic imports pick up the real Testcontainer URI
    process.env.DATABASE_URL = container.getConnectionUri();

    // 2. Seed database schema and initial data
    const seedPool = new Pool({ connectionString: container.getConnectionUri() });
    await seedPool.query(readFileSync(SCHEMA_PATH, "utf-8"));

    for (let i = 0; i < 10; i++) {
      await seedPool.query(
        `INSERT INTO historical_sales (make, model, year, mileage, damage_severity, title_type, region, sale_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        ["Ford", "Mustang", 2021, 34000 + i * 500, "medium", "salvage", "TX", 18000 + i * 100]
      );
    }
    await seedPool.end();
  }, 120_000);

 afterAll(async () => {
    // 1. Drain the app pool FIRST so open sockets disconnect gracefully
    try {
      const { pool } = await import("../../src/index.js");
      if (pool) {
        await pool.end();
      }
    } catch {
      // Ignore if pool was already closed or not created
    }

    // 2. Stop the container AFTER pools are closed
    if (container) {
      await container.stop();
    }
  });
  
  it("returns a real comp valuation for LOT-1001 computed against live Postgres data", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/valuation/LOT-1001");

    expect(res.status).toBe(200);
    expect(res.body.lot_id).toBe("LOT-1001");
    expect(res.body.comp_count).toBe(10);
    expect(res.body.confidence).toBe("high");
    expect(res.body.comp_valuation).toBeGreaterThan(17000);
    expect(res.body.comp_valuation).toBeLessThan(19500);
  });

  it("returns none/null confidence for a lot with zero matching historical sales", async () => {
    const seedPool = new Pool({ connectionString: container.getConnectionUri() });
    await seedPool.query(
      `INSERT INTO lots (lot_id, make, model, year, mileage, damage_primary, title_type,
                         run_and_drive, yard_location, yard_lat, yard_lon, photo_angles_captured)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        "LOT-NOCOMPS",
        "Yugo",
        "GV",
        1988,
        200000,
        "front end",
        "salvage",
        true,
        "Nowhere, TX",
        30.0,
        -97.0,
        ["front", "rear", "side", "undercarriage", "engine_bay", "interior"],
      ]
    );
    await seedPool.end();

    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/valuation/LOT-NOCOMPS");

    expect(res.status).toBe(200);
    expect(res.body.confidence).toBe("none");
    expect(res.body.comp_valuation).toBeNull();
  });

  it("returns 404 for a lot id that doesn't exist in the real database", async () => {
    const { app } = await import("../../src/index.js");
    const res = await request(app).get("/valuation/LOT-NEVER-SEEDED");
    expect(res.status).toBe(404);
  });
});