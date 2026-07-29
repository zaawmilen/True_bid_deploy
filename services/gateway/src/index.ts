/**
 * gateway
 * -------
 * The only service bidder UIs talk to directly. Responsibilities:
 *
 * 1. WebSocket endpoint /ws/:lotId - a bidder's browser connects here
 *    during a live auction and receives a merged, real-time feed of cost
 *    updates (from cost-engine, via `cost-updates`) and risk flags (from
 *    anomaly-service, via `anomaly-scores`) as they happen.
 * 2. Consumes both Kafka topics once, fans out to all connected WebSocket
 *    clients for the relevant lot - this keeps Kafka consumer group size
 *    flat regardless of how many bidders are watching a lot.
 *
 * This is the piece that turns "we computed a cost estimate somewhere in
 * the backend" into "the bidder sees their landed cost update the instant
 * someone else bids" - which is the actual product differentiator.
 */

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Kafka } from "kafkajs";
import { config } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { kafkaConsumerLag, register, websocketClients } from "./metrics.js";
import { extractWsToken, requireAuth, verifyToken } from "./auth.js";
import { loginHandler } from "./authRoutes.js";
import { httpRateLimiter, wsConnectionLimiter } from "./rateLimit.js";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// lot_id -> Set of open sockets
export const connections = new Map<string, Set<WebSocket>>();

// Tracked per-topic via KafkaJS's own lifecycle events (see
// consumeAndBroadcast below), not a flag set manually in a try/catch.
// Used by /readyz.
const consumerConnected: Record<string, boolean> = {
  "cost-updates": false,
  "anomaly-scores": false,
};

export function addConnection(lotId: string, ws: WebSocket): void {
  if (!connections.has(lotId)) connections.set(lotId, new Set());
  connections.get(lotId)!.add(ws);
  websocketClients.set({ lot_id: lotId }, connections.get(lotId)!.size);
}

export function removeConnection(lotId: string, ws: WebSocket): void {
  connections.get(lotId)?.delete(ws);
  if (connections.has(lotId)) {
    websocketClients.set({ lot_id: lotId }, connections.get(lotId)!.size);
  }
}

export interface BroadcastEnvelope {
  type: "cost_update" | "anomaly_score";
  data: Record<string, unknown>;
}

export async function broadcast(lotId: string, payload: BroadcastEnvelope): Promise<void> {
  const sockets = connections.get(lotId);
  if (!sockets) return;
  const message = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

server.on("upgrade", (req, socket, head) => {
  const match = (req.url || "").match(/^\/ws\/([^/?]+)(?:\?.*)?$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const lotId = match[1];

  // Browsers can't set custom headers during a WS handshake, so the
  // token travels as a query param instead: /ws/:lotId?token=<jwt>.
  const token = extractWsToken(req.url);
  const auth = verifyToken(token);
  if (!auth.ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Connection-attempt limiting, not message limiting - see rateLimit.ts's
  // header comment for why: this frontend only ever receives server->client
  // pushes after connecting, so the actual abuse surface is opening (and
  // not closing) many connections, not message spam.
  const decision = wsConnectionLimiter.consume(auth.claims.bidder_id);
  if (!decision.allowed) {
    socket.write(
      `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${Math.ceil(decision.retryAfterMs / 1000)}\r\n\r\n`
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    addConnection(lotId, ws);
    ws.on("close", () => removeConnection(lotId, ws));
  });
});

export async function consumeAndBroadcast(topic: string, payloadType: BroadcastEnvelope["type"]): Promise<void> {
  const kafka = new Kafka({
    clientId: `gateway-${topic}`,
    brokers: [config.kafkaBootstrap],
    retry: { retries: 15, initialRetryTime: 500, maxRetryTime: 30000 },
  });
  const consumer = kafka.consumer({ groupId: `gateway-${topic}` });
  consumer.on(consumer.events.CONNECT, () => (consumerConnected[topic] = true));
  consumer.on(consumer.events.DISCONNECT, () => (consumerConnected[topic] = false));
  consumer.on(consumer.events.CRASH, () => (consumerConnected[topic] = false));
  consumer.on(consumer.events.END_BATCH_PROCESS, ({ payload }) => {
    kafkaConsumerLag.set(
      { topic: payload.topic, partition: String(payload.partition) },
      Number(payload.offsetLag)
    );
  });

  // See cost-engine's consumeBids for why this loop exists: consumer.run()
  // does not auto-restart after a Crash event (e.g. GroupCoordinatorNotFound
  // during Kafka's internal __consumer_offsets warm-up).
  const backoffMs = [1000, 2000, 5000, 10000, 15000];
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      logger.info("consumer group joined", { topic, group_id: `gateway-${topic}` });
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          const event = JSON.parse(message.value.toString()) as Record<string, unknown>;
          const lotId = event.lot_id as string | undefined;
          if (lotId) {
            await broadcast(lotId, { type: payloadType, data: event });
          }
        },
      });
      return;
    } catch (err) {
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      logger.error(`${topic} consumer crashed, retrying`, { retry_in_ms: wait, ...errorFields(err) });
      try {
        await consumer.disconnect();
      } catch {
        // ignore - already dead
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
      attempt += 1;
    }
  }
}

// Matches the CORS fix already applied to cost-engine/valuation-service
// (see docs/BUGS_FOUND.md bug #6 - a missing Access-Control-Allow-Origin
// header silently broke the frontend's fetch with no visible error).
// /auth/login and /valuation are new cross-origin-fetchable routes on
// the gateway with the same exposure if the frontend is ever served
// from a different origin than the gateway.
app.use(cors());
app.use(express.json());

// Liveness: is the process up and accepting connections at all?
// Deliberately checks nothing external - see cost-engine's /healthz for
// the same reasoning.
app.get("/healthz", (req, res) => {
  res.json({ status: "ok" });
});

// Readiness: unlike cost-engine (where Kafka is optional for its primary
// HTTP path), the gateway's *entire* job is forwarding Kafka events to
// WebSocket clients - with no Kafka consumer connected, it's live but
// functionally useless, so readiness is gated on both consumer groups.
//
// Note: the gateway never talks to Postgres or Redis directly (those are
// cost-engine's and anomaly-service's dependencies respectively) - it
// consumes their *derived* output over Kafka - so there is nothing
// meaningful to check for either here.
app.get("/readyz", (req, res) => {
  const checks = { ...consumerConnected };
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Deprecated alias, kept for anything still pointing at the old path.
app.get("/health", (req, res) => {
  res.json({ status: "ok", connected_lots: Array.from(connections.keys()) });
});

// Liveness/readiness/metrics are declared above this line, so they're
// never subject to the limiter below - a load balancer or Prometheus
// needs to be able to reach these without a bidder token or worrying
// about rate limits, same reasoning as keeping them unauthenticated.
app.use(httpRateLimiter);

// Public - no auth required, this IS the auth. Simulates the hand-off
// TrueBid would get from the real auction platform's existing session
// layer (see auth.ts's header comment) - not a real login system.
app.post("/auth/login", loginHandler);

// Proxies valuation-service through the gateway instead of letting the
// frontend call its host port directly, which would bypass JWT auth
// entirely (see docker-compose.yml's comment on that port and
// docs/PRODUCTION_READINESS.md).
app.get("/valuation/:lotId", requireAuth, async (req, res) => {
  try {
    const upstream = await fetch(`${config.valuationServiceUrl}/valuation/${req.params.lotId}`);
    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (err) {
    logger.error("valuation proxy request failed", { lot: req.params.lotId, ...errorFields(err) });
    res.status(502).json({ detail: "valuation-service unreachable" });
  }
});

export { app, server, wss };

// Guarded so importing this module in tests doesn't also bind a real port
// or kick off the Kafka connect/retry loops.
if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, () => logger.info("listening", { port: config.port }));

  // Kafka connectivity is best-effort here on purpose: the WebSocket/HTTP
  // server above must stay up and accepting connections even if Kafka is
  // unreachable or still starting up - a bidder's browser connecting
  // shouldn't depend on Kafka being ready first.
  consumeAndBroadcast("cost-updates", "cost_update").catch((err) =>
    logger.fatal("cost-updates consumer crashed", errorFields(err))
  );
  consumeAndBroadcast("anomaly-scores", "anomaly_score").catch((err) =>
    logger.fatal("anomaly-scores consumer crashed", errorFields(err))
  );

  // The rate limiter's in-memory Map grows one entry per distinct
  // bidder_id seen - sweep periodically so it doesn't grow unbounded
  // over a long-running process.
  setInterval(() => wsConnectionLimiter.sweep(10 * 60_000), 5 * 60_000);
}
