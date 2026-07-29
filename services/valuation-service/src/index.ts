/**
 * valuation-service
 * ------------------
 * Standalone inference service for comparable-sale valuation. Kept
 * separate from cost-engine so the valuation model can be
 * retrained/redeployed independently - swapping KNN for a
 * gradient-boosted model later shouldn't require touching the
 * fee/freight/repair logic at all.
 */

import express, { Request, Response } from "express";
import { Pool } from "pg";
import { estimateCompValue, HistoricalSaleRow } from "./model/compValuation.js";
import { config } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { postgresQueryDuration, register, valuationRequestsTotal } from "./metrics.js";

export const pool = new Pool({ connectionString: config.databaseUrl });

// Without this listener, a background error on an idle client (e.g. the
// server dropping the connection when a test container stops) becomes an
// unhandled 'error' event, which is fatal to the Node process.
   pool.on("error", (err) => {
 logger.error("unexpected error on idle pg client", errorFields(err));
});
export const app = express();

// The frontend calls this over a plain HTTP fetch() from a different
// origin (file:// or a different port) - without this header the browser
// blocks the response entirely and the frontend's fetch silently fails,
// leaving "awaiting comps" displayed forever with no visible error.
app.use((req: Request, res: Response, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

interface LotRow {
  lot_id: string;
  make: string;
  model: string;
  year: number;
  mileage: number;
  damage_primary: string | null;
  title_type: string;
}

function severityFromDamage(damagePrimary: string | null): string {
  // Coarse mapping from a damage code to a severity bucket. In production
  // this would use the same damage taxonomy as the repair-band estimator
  // so the two services stay consistent with each other.
  if (!damagePrimary) return "low";
  const key = damagePrimary.trim().toLowerCase();
  if (["water/flood", "burn/fire", "undercarriage"].includes(key)) return "high";
  if (["front end", "side"].includes(key)) return "medium";
  return "low";
}

app.get("/valuation/:lotId", async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const lotQueryEndTimer = postgresQueryDuration.startTimer({ query: "select_lot" });
    const lotResult = await client.query<LotRow>("SELECT * FROM lots WHERE lot_id = $1", [req.params.lotId]);
    lotQueryEndTimer();
    const lot = lotResult.rows[0];
    if (!lot) {
      logger.warn("valuation request for unknown lot", { lot: req.params.lotId });
      res.status(404).json({ detail: `lot ${req.params.lotId} not found` });
      return;
    }

    const salesQueryEndTimer = postgresQueryDuration.startTimer({ query: "select_historical_sales" });
    const salesResult = await client.query<HistoricalSaleRow>("SELECT * FROM historical_sales");
    salesQueryEndTimer();
    const damageSeverity = severityFromDamage(lot.damage_primary);

    const result = estimateCompValue(salesResult.rows, {
      make: lot.make,
      model: lot.model,
      year: lot.year,
      mileage: lot.mileage,
      damageSeverity,
      titleType: lot.title_type,
    });

    valuationRequestsTotal.inc({ confidence: result.confidence });
    logger.info("valuation request", {
      lot: req.params.lotId,
      comp_count: result.comp_count,
      confidence: result.confidence,
    });

    res.json({ lot_id: req.params.lotId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("valuation request failed", { lot: req.params.lotId, ...errorFields(err) });
    res.status(500).json({ detail: message });
  } finally {
    client.release();
  }
});

// Liveness: is the process up at all? Deliberately checks nothing
// external - see cost-engine's /healthz for the same reasoning.
app.get("/healthz", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/metrics", async (req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Readiness: Postgres is this service's only dependency and a hard
// requirement for its one job (GET /valuation/:lotId), so its
// unavailability fails readiness outright.
app.get("/readyz", async (req: Request, res: Response) => {
  let postgresReady = false;
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      postgresReady = true;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.warn("readiness check: Postgres unreachable", errorFields(err));
  }

  const checks = { postgres: postgresReady };
  res.status(postgresReady ? 200 : 503).json({ status: postgresReady ? "ready" : "not_ready", checks });
});

// Guarded so importing this module in tests doesn't also bind a real port.
if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => logger.info("listening", { port: config.port }));
}
