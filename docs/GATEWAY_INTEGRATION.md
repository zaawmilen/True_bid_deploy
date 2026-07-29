# Wiring auth + rate limiting into `services/gateway`

**Status: integrated.** This guide was written before the actual
`services/gateway/src/index.ts` was available, as a precise plan rather
than a diff. The integration has since been completed for real - see
`services/gateway/src/index.ts` for the final wiring (CORS was added
there too, per this guide's own note in step 4). This document is kept
as a reference for the reasoning behind each piece, not as an
outstanding to-do list.

I don't have your actual `services/gateway/src/index.ts`, so this is a
precise integration guide rather than a diff. Assumes the standard
Express + `ws` (WebSocketServer with `noServer: true`, handled off
Node's raw `http.Server` `'upgrade'` event) pattern implied by the
gateway's healthcheck (`GET /healthz` on the same port the WS server
listens on). Adjust names to match your actual file if it differs.

## 1. Install dependencies

```bash
cd services/gateway
npm install jsonwebtoken express-rate-limit
npm install --save-dev @types/jsonwebtoken
```

## 2. Copy in the new files

Copy `auth.ts`, `authRoutes.ts`, and `rateLimit.ts` into
`services/gateway/src/`.

## 3. Config validation (fail-fast, matching your existing pattern)

Wherever `config.ts` currently validates `DATABASE_URL` /
`KAFKA_BOOTSTRAP` and calls `logger.fatal(...) + process.exit(1)` on a
missing required var, add the same treatment for auth:

```ts
import { assertAuthConfigSafe } from './auth.js';

try {
  assertAuthConfigSafe(process.env.NODE_ENV);
} catch (err) {
  logger.fatal({ err }, 'Refusing to start: unsafe auth configuration');
  process.exit(1);
}
```

## 4. HTTP routes

**CORS note before you add these:** `BUGS_FOUND.md` bug #6 was a missing
`Access-Control-Allow-Origin` header on `valuation-service`, which
silently broke the frontend's fetch with no visible error. `/auth/login`
and `/valuation` below are new cross-origin-fetchable routes on the
gateway with the exact same exposure if the frontend is ever served from
a different origin (e.g. static hosting + a separately-hosted gateway,
per HOSTING.md). If gateway doesn't already send CORS headers, add
whatever equivalent you used to fix bug #6 here too - `cors` npm package
or a manual header, doesn't matter which, just don't let the same gap
back in on the new routes.

```ts
import express from 'express';
import { requireAuth } from './auth.js';
import { loginHandler } from './authRoutes.js';
import { httpRateLimiter } from './rateLimit.js';

const app = express();
app.use(express.json());
app.use(httpRateLimiter); // apply globally, or scope to specific routes below

// Public - no auth required, this IS the auth.
app.post('/auth/login', loginHandler);

// Existing liveness/readiness/metrics stay public - a load balancer or
// Prometheus needs to reach these without a bidder token.
app.get('/healthz', healthzHandler);
app.get('/readyz', readyzHandler);
app.get('/metrics', metricsHandler);

// NEW: proxy valuation through the gateway instead of the frontend
// calling valuation-service directly. This is the fix for the
// direct-port-bypass gap - see PRODUCTION_READINESS.md. Gateway already
// has VALUATION_SERVICE_URL configured; if you don't already have this
// route, add it:
app.get('/valuation/:lotId', requireAuth, async (req, res) => {
  const upstream = await fetch(
    `${process.env.VALUATION_SERVICE_URL}/valuation/${req.params.lotId}`
  );
  const body = await upstream.json();
  res.status(upstream.status).json(body);
});

// Note: unlike /valuation, the gateway has no existing /estimate proxy
// to retrofit - cost estimates reach the frontend via the WebSocket
// `cost_update` feed instead (see gateway's consumeAndBroadcast), not a
// REST call. If you later add an on-demand /estimate proxy route here
// too (mirroring /valuation above), give it the same requireAuth
// treatment - but as of this integration, it doesn't exist and wasn't
// added, since nothing currently calls it.
```

## 5. WebSocket upgrade handler

```ts
import { extractWsToken, verifyToken } from './auth.js';
import { wsConnectionLimiter } from './rateLimit.js';

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const token = extractWsToken(req.url);
  const auth = verifyToken(token);

  if (!auth.ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const decision = wsConnectionLimiter.consume(auth.claims.bidder_id);
  if (!decision.allowed) {
    socket.write(
      `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${Math.ceil(decision.retryAfterMs / 1000)}\r\n\r\n`
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Stash the bidder identity on the socket for use in message
    // handlers / logging / metrics labeling.
    (ws as any).bidderId = auth.claims.bidder_id;
    wss.emit('connection', ws, req);
  });
});
```

## 6. Periodic sweep (optional but recommended)

The rate limiter's in-memory Map grows one entry per distinct bidder_id
seen. Sweep it periodically so it doesn't grow unbounded over a
long-running process:

```ts
setInterval(() => wsConnectionLimiter.sweep(10 * 60_000), 5 * 60_000);
```

## 7. Env vars

See the updated `docker-compose.yml` / `.env.example` - `JWT_SECRET`,
`JWT_EXPIRY`, `RATE_LIMIT_HTTP_WINDOW_MS`, `RATE_LIMIT_HTTP_MAX`,
`RATE_LIMIT_WS_MAX_CONNECTIONS`, `RATE_LIMIT_WS_WINDOW_MS` all have safe
local-dev defaults baked into the modules themselves, so nothing here is
required to run `docker compose up` - only `JWT_SECRET` matters, and
only once you actually deploy (see step 3's fail-fast check).
