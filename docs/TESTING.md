# Testing and Verification

TrueBid's test strategy is layered by how expensive/real the thing under
test is, so a contributor can run the fast layer constantly and the slow
layer before merging:

| Layer | What it covers | Speed | Needs Docker? |
|---|---|---|---|
| **Unit** (`services/*/test/unit`) | Pure calculation/model/detector logic - cost calculation rules, buyer-fee tiers, freight fallback, repair-cost estimation, comparable selection, valuation behavior, anomaly scoring | ms | No |
| **Integration (mocked)** (`services/*/test/integration/http.test.ts`, `kafka.test.ts`, `websocket.test.ts`) | Service wiring - HTTP request/response, Kafka event processing, WebSocket fan-out - against mocked Postgres/Kafka/Redis | ~100-300ms | No |
| **Integration (real infra)** (`services/*/test/integration/postgres.test.ts`, `redis.test.ts`, `kafka.test.ts` in cost-engine) | The same code paths against a real, disposable Postgres/Redis/Kafka container via [testcontainers](https://node.testcontainers.org/) | seconds | **Yes** |
| **End-to-end** (`test/e2e/smoke.mjs`) | The full diagram below, against the actual `docker compose up` stack | seconds | **Yes** (compose) |

Every service exposes the same script names:

```bash
cd services/<service-name>
npm run test              # unit tests only - the tight inner loop
npm run test:integration  # integration tests (mocked + real-infra; real-infra
                           # tests self-skip if no Docker daemon is reachable)
npm run test:all          # everything vitest can find in that service
npm run test:watch        # unit+integration in watch mode
```

Real-infra integration tests check for Docker via `docker info` and use
`describe.runIf(...)` to skip themselves cleanly (not fail) when no daemon
is available - so `npm run test:all` is always safe to run, including in
environments without Docker.

## Continuous Integration

`.github/workflows/ci.yml` runs on every push and pull request against
`main` (and on demand via `workflow_dispatch`), with superseded runs on
the same branch/PR automatically cancelled via `concurrency`:

1. **`test`** - one job per service (matrix over all 5), run in
   parallel: `npm run build` (the same `tsc` compile the Dockerfiles
   use) then `npm run test:all` (unit + mocked-integration +
   real-infra-integration together). GitHub-hosted `ubuntu-latest`
   runners have a Docker daemon available out of the box, so the
   testcontainers-backed real-Postgres/real-Redis/real-Kafka(KRaft)
   tests actually run here rather than self-skipping.
2. **`frontend-test`** - `frontend/`'s `calc.test.js` suite, no Docker
   dependency at all; runs in parallel with the service matrix above.
3. **`e2e`** - depends on both of the above. Runs `docker compose up -d
   --build --wait --wait-timeout 240` (Compose v2's `--wait` honors
   every service's `healthcheck:` block directly, so this doesn't need a
   hand-rolled polling loop), then `test/e2e/smoke.mjs` against the real
   stack. On failure, service logs are dumped to a file and uploaded as
   a build artifact (`actions/upload-artifact`) rather than just printed
   to the job log, so a failed run leaves something actually downloadable
   to debug from. The stack is torn down (`docker compose down -v`)
   unconditionally afterward via `if: always()`.

Each service's dependencies are installed with `npm ci` (not `npm
install`) against the committed `package-lock.json` (including
`frontend/package-lock.json`), and cached via `actions/setup-node`'s
built-in npm cache keyed on each lockfile.

## What's covered where

- **Cost calculation rules** - `cost-engine/test/unit/fees.test.ts`,
  `freight.test.ts`, `repair.test.ts`, `photoSignals.test.ts`
- **Buyer-fee tiers** - `cost-engine/test/unit/fees.test.ts` (boundary
  inclusivity/exclusivity, unbounded top bracket, tier differentiation,
  rounding, missing-bracket errors)
- **Freight fallback behavior** - `cost-engine/test/unit/freight.test.ts`
  (haversine distance, per-vehicle-class rates, inoperable surcharge,
  unrecognized-class fallback, the stubbed `carrierApiEstimate` always
  signaling "fall back to regression")
- **Repair-cost estimation** - `cost-engine/test/unit/repair.test.ts`
  (severity bands, secondary-damage widening, run-and-drive multiplier,
  and the confidence/honesty-about-uncertainty rules: missing angles ->
  low confidence + wider band, empty photo signals never read as "high")
- **Comparable selection & valuation behavior** -
  `valuation-service/test/unit/compValuation.test.ts` (strict-match tier,
  wider-search fallback, distance weighting, 15-comp cap, confidence
  thresholds, numeric-string sale prices from `pg`)
- **Auction state transitions / bid generation** -
  `bid-stream-consumer/test/unit/nextBidEvent.test.ts`
- **Anomaly detection** -
  `anomaly-service/test/unit/bidVelocity.test.ts` +
  `test/integration/redis.test.ts` (z-score velocity flagging, repeated
  cross-lot bidder detection, risk-level aggregation, TTL/cap behavior on
  real Redis)
- **Kafka event processing** -
  `anomaly-service/test/integration/kafka.test.ts` (real `consumeBids()`
  wiring against a mocked broker: JSON parsing, tombstone handling,
  string->number coercion, publish to `anomaly-scores`),
  `gateway/test/integration/websocket.test.ts` (both `cost-updates` and
  `anomaly-scores` topics fanned out correctly), and
  `cost-engine/test/integration/kafka.test.ts` (the same `bids` ->
  `cost-updates` recompute path against a **real** Kafka broker running
  in KRaft mode via testcontainers - matching `docker-compose.yml`'s
  actual topology, not just a mocked client)
- **PostgreSQL integration** -
  `cost-engine/test/integration/postgres.test.ts` and
  `valuation-service/test/integration/postgres.test.ts` (real schema,
  real seed data, real FK constraints, via testcontainers)
- **Redis-backed rolling statistics** -
  `anomaly-service/test/integration/redis.test.ts`
- **Service integration behavior** -
  `cost-engine/test/integration/http.test.ts`,
  `valuation-service/test/integration/http.test.ts`,
  `gateway/test/integration/websocket.test.ts`, and the full
  `test/e2e/smoke.mjs` below
- **Structured logging & config validation** -
  every service has `test/unit/logger.test.ts` (JSON shape, INFO/DEBUG on
  stdout vs. WARN/ERROR/FATAL on stderr, `errorFields()` normalizing both
  `Error` objects and non-Error throwables) and `test/unit/config.test.ts`
  (env var defaults, and for `cost-engine`/`valuation-service` specifically:
  the fail-fast `process.exit(1)` path when a required variable like
  `DATABASE_URL` is missing outside of tests, vs. the placeholder fallback
  used under `NODE_ENV=test`; `gateway`'s also covers the same fail-fast
  treatment for an unset/still-default `JWT_SECRET` in production)
- **Frontend** - `frontend/test/unit/calc.test.js` (23 tests) covers
  every pure function extracted from `index.html`'s inline script: dollar
  formatting, the cost-stack bar's percentage math (including a
  regression test for a NaN-width bug found while extracting it), risk
  label/detail text, demo-mode fallback formulas, and the auth-wiring
  helpers (`buildAuthenticatedWsUrl`, `buildAuthHeader`) that thread a
  JWT into the WebSocket URL and fetch headers
- **Authentication & rate limiting** -
  `gateway/test/unit/auth.test.ts` (14 tests: sign/verify round-trip,
  tampered/expired/wrong-issuer/wrong-secret rejection, the
  `assertAuthConfigSafe` fail-fast check), `authRoutes.test.ts` (7 tests:
  `POST /auth/login`'s validation and response shape),
  `rateLimit.test.ts` (4 tests: token-bucket exhaustion, per-key
  isolation, gradual refill, stale-key sweep), and
  `gateway/test/integration/websocket.test.ts` exercises the real WS
  upgrade path end-to-end: rejects a missing or tampered token with 401,
  rejects a bidder past their connection-rate limit with 429, and accepts
  a valid token - see `docs/PRODUCTION_READINESS.md` for what's real vs.
  intentionally simulated here
- **Distributed tracing** - every service has an identical
  `test/unit/tracing.test.ts` (5 tests) proving `buildResource()`'s
  output actually tags spans with the right `service.name`/
  `service.namespace` when handed to a real `NodeTracerProvider` with an
  in-memory exporter - not just that the function returns the right
  shape - plus `getOtlpEndpoint()`'s default/override behavior;
  `test/e2e/smoke.mjs` additionally confirms Jaeger has received traces
  from all 5 services after a live run

## End-to-end verification against Docker Compose

```
Bid Event
    │
    ▼
Kafka
    │
    ├──► Cost Recalculation
    │
    ├──► Anomaly Detection
    │
    ├──► Valuation Data
    │
    └──► Gateway
             │
             ▼
        Live Browser UI
```

`test/e2e/smoke.mjs` exercises this exact path against a real running
stack - no mocks:

```bash
docker compose up -d --build
cd test/e2e && npm install && npm test
```

This publishes a real bid onto Kafka from the host machine (not from
inside a container), which is why Kafka is configured with two listeners
in `docker-compose.yml`: `kafka:9092` for other containers on the
compose network, and `localhost:9094` specifically for host-based
clients like this script. Connecting to 9092 from the host works for the
initial handshake but then breaks on the first metadata refresh (Kafka
tells the client to reconnect to `kafka:9092`, a hostname the host can't
resolve) - `smoke.mjs` defaults to `9094` for exactly this reason; no
manual `/etc/hosts` edit needed.

**Running this from WSL2:** use WSL2's native filesystem
(`~/projects/truebid`, not `/mnt/c/Users/...`). Docker's I/O across the
Windows↔WSL2 filesystem bridge is meaningfully slower, and Kafka in
particular is disk-write-heavy even for its internal topics - on
`/mnt/c` this can slow Kafka's own startup enough that its consumer-group
machinery isn't ready yet when the smoke test runs, causing `/readyz`
checks and the `cost_update` broadcast check to fail even though nothing
is actually broken - just not finished starting yet.

It checks, in order: `/healthz` and `/readyz` on `gateway`, `cost-engine`,
and `valuation-service`; the on-demand `GET /estimate/:lotId` page-load
path; that freight estimates come back using the regression fallback
(since `carrierApiEstimate` is stubbed to always defer to it);
`valuation-service`'s direct host port (still open by design, see
`docs/PRODUCTION_READINESS.md`) and confirms the gateway's
`/valuation/:lotId` proxy rejects a request with no token; logs in via
`POST /auth/login` to get a real JWT, then uses it for the authenticated
`/valuation/:lotId` proxy call and to open a real WebSocket to
`/ws/:lotId?token=...`; publishes a real bid onto the `bids` Kafka topic
and asserts the resulting `cost_update` is broadcast back to that
authenticated socket - i.e. that a bid placed by another buyer actually
updates *your* screen in real time, which is the core product claim -
and finally confirms Jaeger's `/api/services` lists all 5 services,
proving the tracing wiring actually emitted spans during the run.
i.e. that a bid placed by another buyer actually updates *your* screen in
real time, which is the core product claim.

---

# Health and Readiness Endpoints

Every service exposes two endpoints on its HTTP port (`anomaly-service`
and `bid-stream-consumer` have no other HTTP API at all - these exist
purely so the two can be monitored/orchestrated like the other three):

- **`GET /healthz`** - liveness. Returns `200 {"status":"ok"}` always,
  checking nothing external. A dependency outage should not make an
  orchestrator restart an otherwise-healthy process - that's what
  `/readyz` is for. `docker-compose.yml`'s `healthcheck:` blocks all use
  `/healthz`, specifically for this reason.
- **`GET /readyz`** - readiness. Returns `200 {"status":"ready", checks:
  {...}}` only when the service's actual hard dependencies are reachable,
  `503 {"status":"not_ready", checks: {...}}` otherwise. What gates
  readiness differs deliberately per service, matching each one's real
  dependency graph rather than a one-size-fits-all check:

| Service | `/readyz` checks | Gates 200 vs. 503? |
| --- | --- | --- |
| `cost-engine` | Postgres (`SELECT 1`) | Yes - required for `/estimate` |
| `cost-engine` | Kafka producer/consumer connected | No - informational only; `/estimate` works without Kafka by design (see Core Design Decisions in the README) |
| `valuation-service` | Postgres (`SELECT 1`) | Yes - its only dependency |
| `gateway` | Both Kafka consumer groups (`cost-updates`, `anomaly-scores`) connected | Yes - forwarding Kafka events *is* the gateway's entire job, unlike cost-engine's HTTP path |
| `anomaly-service` | Kafka producer, Kafka consumer, Redis (`ready` event) | Yes, all three |
| `bid-stream-consumer` | Kafka producer connected | Yes - its only job is publishing to Kafka |

Note that `gateway` does **not** check Postgres or Redis - it never talks
to either directly (those are `cost-engine`'s and `anomaly-service`'s
dependencies respectively; `gateway` only ever sees their *derived*
output over Kafka), so there's nothing honest to check there.

Kafka/Redis connection state is tracked via each client library's own
lifecycle events (`producer.events.CONNECT/DISCONNECT`,
`consumer.events.CONNECT/DISCONNECT/CRASH` for KafkaJS; `'ready'`/`'close'`
for ioredis) rather than a flag manually set in a `try`/`catch`, so it
can't drift out of sync with what the client actually did.

Covered by every service's `test/integration/health.test.ts` (or the
relevant section of `http.test.ts`/`websocket.test.ts` for
`cost-engine`/`valuation-service`/`gateway`), including the not-yet-ready
and partial-outage cases.

---

# Metrics

Every service exposes `GET /metrics` in Prometheus text format, via a
private `prom-client` `Registry` per service (not the global default
registry - so re-importing the module in tests never double-registers a
metric and throws). Each registry also runs `collectDefaultMetrics()`,
which gives process CPU/memory/heap/event-loop-lag metrics for free
(e.g. `process_cpu_user_seconds_total`), and `setDefaultLabels({service:
"<name>"})` so every metric self-identifies which service emitted it even
without a Prometheus scrape-job label.

| Service | Custom metrics |
| --- | --- |
| `cost-engine` | `bids_processed_total` (Counter); `cost_calculation_duration_seconds` (Histogram, labeled `tier`); `postgres_query_duration_seconds` (Histogram, labeled `query` - one per distinct query: `select_lot`, `select_fee_schedules`, `insert_cost_estimate`); `kafka_consumer_lag` (Gauge, labeled `topic`/`partition`) |
| `valuation-service` | `valuation_requests_total` (Counter, labeled `confidence`); `postgres_query_duration_seconds` (Histogram, labeled `query`) |
| `anomaly-service` | `bids_processed_total` (Counter); `anomaly_score_total` (Counter, labeled `risk_level`); `redis_latency_seconds` (Histogram, labeled `command` - instruments all six Redis commands the detector issues); `kafka_consumer_lag` (Gauge) |
| `gateway` | `websocket_clients` (Gauge, labeled `lot_id` - set directly from the connection map's size on every connect/disconnect, so it can't drift out of sync the way a separately incremented/decremented counter could); `kafka_consumer_lag` (Gauge, tracked independently for both its `cost-updates` and `anomaly-scores` consumer groups) |
| `bid-stream-consumer` | `bids_published_total` (Counter) - not on the original list, added for symmetry with the other services' `bids_processed_total` |

`kafka_consumer_lag` is real, not estimated: it comes from KafkaJS's own
`consumer.events.END_BATCH_PROCESS` event, whose payload includes
`offsetLag` - the gap between the highest offset in the just-processed
batch and the partition's high watermark at fetch time. This is the
standard signal client libraries expose for "is this consumer falling
behind," rather than something this codebase computes itself.

Covered by a `GET /metrics` test in each service's health/HTTP
integration test file, including one gateway test that opens and closes
a real WebSocket connection and asserts `websocket_clients` reflects
`1` then `0` for that lot.

## Metrics aggregation: Prometheus + Grafana

These endpoints are now actually scraped, not just exposed. `docker
compose up` also starts:

- **`prometheus`** (`monitoring/prometheus.yml`) - scrapes all 5
  services' `/metrics` every 10s, addressing them by compose service
  name/internal port (`cost-engine:8000`, not the host-mapped `8001`) -
  the two aren't the same, and mixing them up is an easy mistake since
  Prometheus lives on the same compose network as the services it's
  scraping. UI at `http://localhost:9090`.
- **`grafana`** (`monitoring/grafana/`) - auto-provisioned on boot from
  `provisioning/datasources/datasource.yml` (the Prometheus datasource -
  named `datasource.yml` and not `prometheus.yml` specifically to avoid
  colliding with the actual scrape config above; both are easy to
  conflate since they're both "the Prometheus config file" in a loose
  sense but serve entirely different purposes) and
  `provisioning/dashboards/dashboards.yml` (the dashboard provider
  config, pointing at `dashboards/truebid-overview.json`). Nothing to
  click through - `http://localhost:3000` (default login `admin`/`admin`)
  shows the TrueBid dashboard immediately: bid throughput, anomaly scores
  by risk level, valuation requests by confidence, active WebSocket
  clients per lot, p95 latency for cost calculation/Postgres
  queries/Redis commands, Kafka consumer lag by topic, and
  memory/CPU per service from `collectDefaultMetrics()`.

---

# Observability and Failure Behavior

Every service logs structured JSON lines to stdout/stderr via a shared
per-service `logger.ts` (`logger.debug/info/warn/error/fatal(message,
fields)`), instead of ad hoc `console.log`/`console.error` strings. Each
line is machine-parseable:

```json
{"timestamp":"2026-07-22T09:28:16.376Z","level":"INFO","service":"cost-engine","message":"cost recalculated","lot":"LOT-1001","bid":5200,"cost":7348,"confidence":"medium"}
```

`INFO`/`DEBUG` go to stdout; `WARN`/`ERROR`/`FATAL` go to stderr, so
`docker compose logs -f <service>` (or any log pipeline that splits
stdout/stderr) can separate problems from routine traffic without parsing
JSON first. `errorFields(err)` normalizes a caught `unknown` into
`{error, stack}` so both real `Error` objects and non-Error throwables
serialize cleanly. Covered by every service's `test/unit/logger.test.ts`.

Configuration is validated once at startup through a per-service
`config.ts` instead of `process.env.X` scattered through the code.
Required variables (`DATABASE_URL` for `cost-engine`/`valuation-service`)
fail loudly via `logger.fatal(...)` + `process.exit(1)` if missing outside
of tests, rather than surfacing later as a confusing runtime error (e.g.
`pg` silently falling back to local-socket defaults). Covered by every
service's `test/unit/config.test.ts`, including the fail-fast exit path.

Specific lifecycle events logged:

- **Kafka consumer startup / crash-retry** - every consumer
  (`cost-engine`, `anomaly-service`, `gateway`) logs a `"bids consumer
  crashed, retrying"` (or per-topic equivalent) WARN/ERROR with
  `retry_in_ms` and the error, before sleeping and reconnecting. This
  loop exists because KafkaJS's `consumer.run()` does not auto-restart
  after a `Crash` event (e.g. `GroupCoordinatorNotFound` during Kafka's
  internal `__consumer_offsets` warm-up on a cold `docker compose up`) -
  the retry loop is what actually recovers.
- **Consumer group membership** - `gateway` logs `"consumer group
  joined"` with `topic` and `group_id` once `consumer.subscribe()`
  succeeds, for each of its two independent consumer groups
  (`gateway-cost-updates`, `gateway-anomaly-scores`).
- **Kafka producer connect / retry** - `cost-engine` logs `"Kafka
  producer connected"` on success and `"Kafka producer connect failed,
  retrying"` with `retry_in_ms` on failure.
- **Cost recalculation** - `cost-engine` logs `"cost recalculated"` with
  `lot`, `bid`, `cost`, and `confidence` fields on every bid it processes
  off the `bids` topic.
- **Valuation requests** - `valuation-service` logs `"valuation request"`
  with `lot`, `comp_count`, and `confidence` on every `/valuation/:lotId`
  call, and a WARN for unknown lots.
- **Anomaly detection** - `anomaly-service` logs a WARN `"anomaly score"`
  (with the full score object spread into the log fields) whenever a
  bid's `risk_level` is not `"low"`, so risk flags are visible in the
  stream without being drowned out by routine low-risk bids.
- **Redis failures** - `anomaly-service` registers an `ioredis` `'error'`
  listener that logs `"Redis connection error"` rather than leaving it
  unhandled. This was a real gap: without a listener, an unhandled
  `'error'` event on an `ioredis` client crashes the whole process the
  next time Redis is unreachable, rather than reconnecting and logging.
- **Database failures** - HTTP handlers in `cost-engine` and
  `valuation-service` now log an ERROR (with the lot id and
  `errorFields()`) before returning the `500`, instead of silently
  swallowing the exception into just an HTTP response.
- **Fallback behavior** is logged explicitly rather than silently
  swallowed - e.g. `photoSignals.ts` logs a WARN `"photo analysis service
  returned non-OK status, falling back to angle-completeness only"` (or
  `"...unreachable, falling back..."`) before returning the
  degraded-but-real result.

## Failures in non-critical dependencies don't take down the bidder experience

Two fallback paths are exercised directly by the test suite
(`freight.test.ts`, `photoSignals.test.ts`, `compValuation.test.ts`) and
by the e2e smoke test's freight-fallback check:

```
Carrier API unavailable
        │
        ▼
Regression freight fallback
        │
        ▼
Lower-confidence estimate
```


`carrierApiEstimate` is stubbed to always return `null`, and
`buildEstimate` always falls through to `regressionEstimate` - a bidder
never sees a blank freight field, only a (correctly labeled) fallback
estimate. Similarly:

```
Insufficient comparable sales
        │
        ▼
Wider search / reduced confidence
```

`estimateCompValue` widens its search (drops the title/damage match) when
the strict comp set is too small, and reports `confidence: "none"` rather
than fabricating a number when even the widened search comes up short -
covered by `compValuation.test.ts`'s tiered-search and
insufficient-comps test groups.

More generally: the on-demand `/estimate` and `/valuation` HTTP endpoints
only depend on Postgres and stay up even if Kafka is down or still
starting; the gateway's WebSocket/HTTP server binds and accepts
connections immediately and treats both Kafka topics as best-effort
background consumers, so a bidder's browser connecting never blocks on
Kafka being ready.
