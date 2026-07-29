# Bugs found during development

Full log of every real bug found while building and deploying TrueBid —
compose orchestration, Kafka client behavior, cross-service consumer-group
design, browser CORS, and core business logic. Extracted here to keep the
README scannable; linked from its "Verification status" section.

**The full pipeline is confirmed working end-to-end against a real
`docker compose up` stack** — bid simulator → Kafka → cost/anomaly
recompute → gateway → live browser UI, all four panels (total landed
cost, cost-stack bar, bid integrity, comparable sale value) verified
updating in real time from live traffic. Getting there surfaced six real
bugs, documented below in the order they were found, since each one is a
useful "if you hit X, check Y" reference:

1. **`bid-stream-consumer` was missing from `docker-compose.yml` entirely**
   — present as a service directory with its own Dockerfile, but never
   wired into the compose file's `services:` block, so it silently never
   ran. No error, no crash — it just didn't exist as far as Compose was
   concerned.
2. **`cost-engine` was missing `KAFKA_BOOTSTRAP: kafka:9092`** in its
   compose environment block, so it fell back to the code's default of
   `localhost:9092` — which inside its own container refers to itself,
   not the Kafka container. Manifested as `ECONNREFUSED 127.0.0.1:9092`.
3. **Kafka cold-start race**: `depends_on: kafka` only waits for the
   *container process* to start, not for Kafka to finish leader election
   and actually become queryable. Confluent's image reliably takes longer
   than KafkaJS's default retry budget to settle, causing
   `LEADER_NOT_AVAILABLE` / `group coordinator not available` errors.
   Fixed two ways together: `docker-compose.yml` now uses real
   healthchecks (`cub kafka-ready` / `cub zk-ready`) with `condition:
   service_healthy` gating startup order, and every KafkaJS client uses a
   more patient retry policy (15 retries, 30s max) as defense-in-depth.
4. **Consumer crash doesn't auto-restart**: KafkaJS's `consumer.run()`
   does not recover on its own after a `Crash` event (which the race in
   #3 can still trigger occasionally even with healthchecks) — it just
   logs `[Consumer] Stopped` and gives up. `cost-engine`, `anomaly-service`,
   and `gateway` all now wrap their consumer subscribe/run in an explicit
   reconnect-with-backoff loop.
5. **`gateway`'s two internal consumers shared one `groupId: "gateway"`**
   despite subscribing to different topics (`cost-updates`,
   `anomaly-scores`). Kafka only tracks one partition assignment per
   group, so the group leader assigned all partitions to itself and left
   the other consumer with `memberAssignment: {}` — connected, but
   silently receiving zero messages. Confirmed in practice: the frontend's
   WebSocket showed "Live" and risk updates worked, but the cost-stack bar
   and total landed cost never moved. Fixed by giving each topic its own
   groupId (`gateway-${topic}`).
6. **Missing CORS headers on `valuation-service` and `cost-engine`**: the
   frontend's comparable-sale-value fetch is a plain HTTP `fetch()`
   (unlike the WebSocket path used for streaming updates, which isn't
   subject to CORS), and neither service sent
   `Access-Control-Allow-Origin`. The browser silently blocked the
   response and the frontend's `.catch(() => {})` swallowed the failure,
   leaving "awaiting comps" displayed indefinitely with no visible error.
   Fixed by adding the header to both services.
7. **Kafka's single listener couldn't correctly serve both containers and
   the host machine.** `KAFKA_ADVERTISED_LISTENERS` was set to
   `kafka:9092` — correct for other containers, but a client connecting
   from the host (e.g. `test/e2e/smoke.mjs` run directly, not from inside
   a container) would connect to the published port fine, then get told
   by Kafka's own protocol to reconnect to `kafka:9092` for anything past
   the initial handshake — a hostname the host can't resolve
   (`getaddrinfo ENOTFOUND kafka`). Found running the e2e smoke test
   directly against a live stack from WSL2, where the workaround at the
   time was a manual `/etc/hosts` entry. Fixed properly with a second,
   dedicated listener (`PLAINTEXT_HOST` on `9094`, advertised as
   `localhost:9094`) specifically for host-based clients, so no manual
   `/etc/hosts` edit is needed. The same debugging session also surfaced
   that binding `KAFKA_LISTENERS` to the `kafka` hostname specifically
   (rather than `0.0.0.0`) could fail to start at all on some Docker
   setups — fixed by binding to `0.0.0.0` instead, which is unaffected by
   exactly when the container's own DNS resolves itself during startup.

If you hit `LEADER_NOT_AVAILABLE`, a service missing from `docker compose
ps`, a panel that's stuck/not updating while others work, a silent
fetch failure, or `ENOTFOUND kafka` when running a script against the
stack from your host machine, these seven are the first things to check.

**TypeScript conversion (all 5 services + the seed generator)**: every
service compiles clean under `tsc --strict` with zero errors. Rebuilt and
re-run against the same real Postgres/Redis instances used for the
original testing pass — results were byte-for-byte consistent with the
pre-conversion JS version. The conversion itself caught one more bug:
**`cost-engine`'s HTTP endpoint was fully blocked by Kafka connectivity**
— `main()` awaited the Kafka producer connecting before starting Express,
so `/estimate` would hang indefinitely if Kafka was down or still
starting up, even though that endpoint doesn't touch Kafka at all. Fixed
to start the HTTP server immediately and connect to Kafka in the
background with retry/backoff.

**Before any of the above**, and before Docker was available in the
environment used to build this, Postgres and Redis were stood up directly
and the real service code exercised against them, plus the pure logic
modules unit-tested. Two more real bugs were caught this way:

1. **`cost-engine/src/calculators/repair.ts`** — was returning `"high"`
   repair-cost confidence when given *zero* photo evidence (an empty
   `photoSignals` object defaulted to "nothing missing" → "fully
   verified"). Fixed so high confidence now requires actual analyzed
   evidence; no data defaults to `"medium"` (unknown), not `"high"`.
2. **`anomaly-service/src/detectors/bidVelocity.ts`** — the z-score
   baseline (mean/std of bid intervals) was computed *including* the
   interval being tested, so an anomalous burst inflated its own baseline
   and partially masked itself. Fixed to score the latest interval
   against a baseline built only from prior intervals.

Ten real bugs total across every layer — compose orchestration, Kafka
client behavior, cross-service consumer-group design, browser CORS, and
core business logic — found by actually running the thing rather than
stopping at "it compiles."
