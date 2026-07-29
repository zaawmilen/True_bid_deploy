# Production readiness: auth, rate limiting, secrets, tracing

Status of the items from `DEPLOYMENT_CHECKLIST.md` §3 and §6 ("basic
rate limiting", real auth was previously entirely absent) plus
distributed tracing, tackled as a follow-on since the async,
cross-service bid flow is exactly the kind of thing that's hard to debug
from logs alone. This doc is the honest account of what's actually
covered versus simulated versus still open - written the same way
`BUGS_FOUND.md` is, so it holds up under a follow-up question rather
than reading as "done."

## Auth

**What's real:** JWT issuance and verification (`auth.ts`), signature
tampering detection, expiry, issuer checking, a fail-fast check that
refuses to boot in `NODE_ENV=production` with the placeholder secret
still set. 21 unit tests (`auth.test.ts` + `authRoutes.test.ts`), all
passing, covering the failure modes above plus the happy path.

**What's simulated, on purpose:** `/auth/login` takes a `bidder_id` and
hands back a token - no password, no user store, no real identity check.
This mirrors `bid-stream-consumer`'s existing framing (it already
simulates the upstream auction platform's bid feed): in a real
deployment, TrueBid would sit behind the platform's *existing* auth and
just consume the session it's handed. Building a real login system here
would be simulating a problem TrueBid doesn't actually own - the
existing auction platform already solved it. This is a documented
design choice, not a shortcut discovered later.

**What's still open, genuinely:**
- No logout/revocation. JWTs are stateless by design, so a compromised
  token is valid until it expires (`JWT_EXPIRY`, default 2h). A real
  deployment integrating with an actual upstream session would want
  either short-lived tokens with refresh, or a revocation list in Redis
  (which is already in this stack for anomaly-service, so the
  infrastructure exists - just not wired up here, to avoid adding
  complexity a demo doesn't need).
- `valuation-service` and `cost-engine` still have their own host ports
  mapped in `docker-compose.yml` (8002, 8001) for local dev/testing
  convenience per `TESTING.md`. Auth is enforced at the gateway only -
  hitting those ports directly bypasses it entirely. Documented inline
  in `docker-compose.yml`; not removed because doing so would break the
  existing direct-port test flow. If this is ever deployed somewhere
  public, don't publish those two ports.

## Rate limiting

HTTP via `express-rate-limit` (120 req/min default, configurable).
WebSocket connection-attempt limiting via a hand-rolled in-memory token
bucket, keyed by `bidder_id` rather than IP (so it doesn't
false-positive on a shared office/NAT). 4 unit tests covering exhaustion,
per-key isolation, gradual refill, and stale-key cleanup.

**Documented tradeoff:** both limiters are in-memory - correct scope for
a single-instance demo gateway, wrong scope if this ever runs as
multiple replicas (state wouldn't be shared, so the effective limit
would multiply by replica count). The fix at that point is a
Redis-backed store; Redis is already in this stack for
anomaly-service, so the path to fixing this is short, it's just not
worth doing today for a single-instance demo.

## Secrets

Mostly already closed per `DEPLOYMENT_CHECKLIST.md` §2 - `.env`
gitignored, `${VAR:-default}` interpolation throughout. This pass adds:

- `JWT_SECRET` follows the same pattern as `POSTGRES_PASSWORD` etc.
  (safe local-dev default, override via `.env`), but with one addition
  the others don't have: `assertAuthConfigSafe()` makes it impossible to
  boot in production with the default still set, rather than just
  documenting that you should change it.
- `.env.example` includes `openssl rand -base64 48` as the suggested way
  to generate a real value.

**Genuinely still open, if this ever becomes a real deployment rather
than a portfolio demo:** a `.env` file on a host is still a plaintext
secret at rest. A real production setup would use the hosting
platform's own secrets store (Railway/Render's env var UI already
encrypts at rest and audits access) or a dedicated secrets manager
(Vault, Doppler) rather than a file at all. Not building that
integration here - for a single-instance demo, adding a secrets-manager
dependency would be infrastructure for its own sake, not solving a
problem this deployment actually has yet. Worth doing the day this runs
as more than one instance or holds a real credential that matters.

## Distributed tracing

**What's real:** OpenTelemetry auto-instrumentation (HTTP, Express, `pg`,
KafkaJS) across all 5 services, exported via OTLP/HTTP to Jaeger's
all-in-one image. `@opentelemetry/instrumentation-kafkajs` propagates
W3C trace context through Kafka message headers automatically, so a
single bid tick's trace connects across the actual async boundary this
project's whole story runs through -
`bid-stream-consumer` → Kafka → `cost-engine`/`anomaly-service` → Kafka
→ `gateway`. 5 unit tests (the same `tracing.test.ts`, identical across
all 5 services since `buildResource`/`getOtlpEndpoint` are pure and
service-agnostic), using a real `NodeTracerProvider` +
in-memory exporter to prove the resource/service-name wiring actually
tags spans correctly - not just that the code compiles.

**Design call:** Jaeger directly, no separate `otel-collector` container.
A standalone collector's value is sampling policies and multi-backend
fan-out - a single-instance demo with one trace backend needs neither,
and adding one would be a container that exists to look like more
infrastructure rather than to do anything the setup doesn't already do
without it.

**What's NOT covered:** the trace ends at the last server-side hop
before `gateway`'s WebSocket `send()`. Following it into the browser
would need `@opentelemetry/sdk-trace-web` shipped to the frontend - a
real, separate piece of work, not included here. The backend story
(which is where the actual cross-service complexity lives) is complete
without it.

**Genuinely still open:** Jaeger's default storage here is in-memory -
traces don't survive a container restart, same as not needing to since
this is for live debugging/demo purposes, not an audit trail. A real
deployment wanting trace retention would point Jaeger at Elasticsearch
or Cassandra as a storage backend, or export to a hosted tracing backend
instead (Honeycomb, Grafana Tempo, etc.) - not needed for what this
currently is.
