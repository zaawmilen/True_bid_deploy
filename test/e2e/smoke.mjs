#!/usr/bin/env node
/**
 * TrueBid end-to-end smoke test
 * -----------------------------
 * Exercises the full path described in the architecture diagram:
 *
 *   Bid Event -> Kafka -> Cost Recalculation
 *                       -> Anomaly Detection
 *                       -> Valuation Data
 *                       -> Gateway -> Live Browser UI
 *
 * This is NOT a substitute for the per-service unit/integration tests in
 * services/*\/test - it deliberately does not mock anything. It assumes
 * the real stack is already running via `docker compose up` and talks to
 * it exactly the way a browser and the bid-stream-consumer would.
 *
 * Usage:
 *   docker compose up -d --build
 *   node test/e2e/smoke.mjs
 *
 * Exit code 0 = all checks passed, non-zero = a step failed. Prints a
 * step-by-step log so a failure is easy to localize to one hop in the
 * diagram above.
 */

import { Kafka } from "kafkajs";
import WebSocket from "ws";

// Kafka has two listeners (see docker-compose.yml): PLAINTEXT on 9092,
// advertised as `kafka:9092` for other containers, and PLAINTEXT_HOST on
// 9094, advertised as `localhost:9094` specifically for host-based
// clients like this script. Connecting to 9092 from the host would work
// for the initial handshake but then fail on the first metadata refresh
// (Kafka tells the client to reconnect to `kafka:9092`, a hostname the
// host can't resolve) - 9094 is the one to use here.
const KAFKA_BOOTSTRAP = process.env.KAFKA_BOOTSTRAP || "localhost:9094";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:8000";
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || "ws://localhost:8000";
const COST_ENGINE_URL = process.env.COST_ENGINE_URL || "http://localhost:8001";
const VALUATION_SERVICE_URL = process.env.VALUATION_SERVICE_URL || "http://localhost:8002";
const JAEGER_URL = process.env.JAEGER_URL || "http://localhost:16686";

const LOT_ID = "LOT-1001"; // seeded by db/001_schema.sql
const TIMEOUT_MS = 30_000;

let failures = 0;

function log(step, ok, detail = "") {
  const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${mark} ${step}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealthAndReadiness() {
  const services = [
    { name: "gateway", url: GATEWAY_URL },
    { name: "cost-engine", url: COST_ENGINE_URL },
    { name: "valuation-service", url: VALUATION_SERVICE_URL },
  ];
  for (const svc of services) {
    const health = await fetch(`${svc.url}/healthz`);
    const healthBody = await health.json();
    log(`${svc.name} /healthz responds`, health.ok && healthBody.status === "ok", JSON.stringify(healthBody));

    const ready = await fetch(`${svc.url}/readyz`);
    const readyBody = await ready.json();
    log(`${svc.name} /readyz reports ready`, ready.ok && readyBody.status === "ready", JSON.stringify(readyBody));
  }
}

async function checkOnDemandEstimate() {
  // The on-demand cost endpoint should work even before any bid is placed -
  // this is the "page load" path described in cost-engine's index.ts.
  const res = await fetch(`${COST_ENGINE_URL}/estimate/${LOT_ID}?bid_amount=5000&tier=premier`);
  const body = await res.json();
  const ok =
    res.ok &&
    body.lot_id === LOT_ID &&
    typeof body.total_landed_cost_low === "number" &&
    typeof body.total_landed_cost_high === "number";
  log("cost-engine GET /estimate/:lotId (pre-bid page load)", ok, JSON.stringify(body));
}

async function login() {
  // Simulates the hand-off from the real auction platform's existing
  // session (see services/gateway/src/auth.ts) - not a real login system.
  const res = await fetch(`${GATEWAY_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bidder_id: "e2e-smoke-bidder" }),
  });
  const body = await res.json();
  log("gateway POST /auth/login issues a token", res.ok && typeof body.token === "string");
  return body.token;
}

async function checkValuationThroughGateway(token) {
  // The real path a bidder's browser takes as of the auth work - through
  // the gateway's proxy, not valuation-service's own host port directly
  // (see docs/PRODUCTION_READINESS.md on why that port bypasses auth).
  const res = await fetch(`${GATEWAY_URL}/valuation/${LOT_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  const ok = res.ok && body.lot_id === LOT_ID && "confidence" in body;
  log(
    "gateway GET /valuation/:lotId (authenticated proxy)",
    ok,
    `confidence=${body.confidence}, comp_count=${body.comp_count}`
  );
}

async function checkValuationRejectsMissingAuth() {
  const res = await fetch(`${GATEWAY_URL}/valuation/${LOT_ID}`);
  log("gateway GET /valuation/:lotId rejects a request with no token", res.status === 401, `status=${res.status}`);
}

async function checkValuationDirectPort() {
  // Documented local-dev/test convenience (see docker-compose.yml's
  // comment on valuation-service's 8002 mapping) - bypasses gateway auth
  // entirely, intentionally, for direct testing. Not the path a real
  // bidder's browser takes; checkValuationThroughGateway above is.
  const res = await fetch(`${VALUATION_SERVICE_URL}/valuation/${LOT_ID}`);
  const body = await res.json();
  const ok = res.ok && body.lot_id === LOT_ID && "confidence" in body;
  log(
    "valuation-service GET /valuation/:lotId (direct port, bypasses auth by design)",
    ok,
    `confidence=${body.confidence}, comp_count=${body.comp_count}`
  );
}

async function checkLiveBidPropagation(token) {
  // 1. Connect a "browser" to the gateway for this lot, the way the
  //    frontend does over /ws/:lotId - now requires a valid JWT, since
  //    browsers can't set custom headers during a WS handshake, so it
  //    travels as a query param instead.
  const ws = new WebSocket(`${GATEWAY_WS_URL}/ws/${LOT_ID}?token=${token}`);
  await withTimeout(new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  }), "authenticated WebSocket connection to gateway");
  log("browser connects to gateway /ws/:lotId with a valid token", true);

  const costUpdate = withTimeout(
    new Promise((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "cost_update" && msg.data.lot_id === LOT_ID) resolve(msg);
      });
    }),
    "cost_update broadcast for the placed bid"
  );

  // 2. Publish a bid directly onto `bids`, exactly like bid-stream-consumer
  //    (or the real upstream auction platform) would.
  const kafka = new Kafka({ clientId: "e2e-smoke", brokers: [KAFKA_BOOTSTRAP] });
  const producer = kafka.producer();
  await producer.connect();

  const bidEvent = {
    lot_id: LOT_ID,
    bidder_id: "e2e-smoke-bidder",
    amount: 9999 + Math.floor(Math.random() * 1000), // avoid colliding with the demo simulator
    placed_at: Date.now() / 1000,
  };
  await producer.send({ topic: "bids", messages: [{ value: JSON.stringify(bidEvent) }] });
  await producer.disconnect();
  log("published bid event onto `bids` topic", true, JSON.stringify(bidEvent));

  // 3. Confirm it came back out the other end, merged and broadcast to the
  //    connected browser - the actual product differentiator.
  try {
    const msg = await costUpdate;
    const ok =
      typeof msg.data.total_landed_cost_low === "number" &&
      typeof msg.data.total_landed_cost_high === "number";
    log("gateway broadcasts cost_update to connected browser after a bid", ok, JSON.stringify(msg.data));
  } catch (err) {
    log("gateway broadcasts cost_update to connected browser after a bid", false, err.message);
  }

  ws.close();
}

async function checkFreightFallbackBehavior() {
  // carrierApiEstimate is stubbed to always return null in this codebase,
  // so every estimate necessarily used the regression fallback - this
  // just confirms the estimate still comes back with a sane, non-zero
  // freight number rather than a blank/failed field.
  const res = await fetch(`${COST_ENGINE_URL}/estimate/${LOT_ID}?bid_amount=1000`);
  const body = await res.json();
  const ok = res.ok && body.freight_estimate > 0 && body.freight_distance_miles >= 0;
  log(
    "cost-engine degrades gracefully to freight regression fallback",
    ok,
    `freight_estimate=${body.freight_estimate}`
  );
}

async function checkJaegerReceivedTraces() {
  // Any HTTP request or Kafka message triggers a span - the /healthz
  // polling from Docker's own healthchecks is enough on its own, so this
  // should already be populated by the time this check runs.
  try {
    const res = await fetch(`${JAEGER_URL}/api/services`);
    const body = await res.json();
    const services = body?.data ?? [];
    const expected = ["gateway", "cost-engine", "valuation-service", "anomaly-service", "bid-stream-consumer"];
    const missing = expected.filter((s) => !services.includes(s));
    log(
      "Jaeger has received traces from all 5 services",
      res.ok && missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : `services=${services.join(", ")}`
    );
  } catch (err) {
    log("Jaeger has received traces from all 5 services", false, err.message);
  }
}

async function main() {
  console.log(`TrueBid e2e smoke test against the live docker-compose stack (lot=${LOT_ID})\n`);

  await checkHealthAndReadiness();
  await checkOnDemandEstimate();
  await checkFreightFallbackBehavior();
  await checkValuationDirectPort();
  await checkValuationRejectsMissingAuth();

  const token = await login();
  await checkValuationThroughGateway(token);
  await checkLiveBidPropagation(token);
  await checkJaegerReceivedTraces();

  console.log();
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("All checks passed.");
  }
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
