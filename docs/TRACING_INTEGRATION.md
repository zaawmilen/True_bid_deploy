# Wiring distributed tracing into the 5 services

**Status: integrated.** `tracing.ts`/`bootstrap.ts` are now in every
service's `src/`, the OTel dependencies are installed, each service's
`Dockerfile` `CMD` bakes in `--require ./dist/bootstrap.js` (so tracing
starts correctly regardless of how the image is run, not just under
`docker compose`), and `docker-compose.yml` sets `SERVICE_NAME` /
`OTEL_EXPORTER_OTLP_ENDPOINT` per service. This document is kept as a
reference for the reasoning behind the setup, not as an outstanding
to-do list.

Same caveat as `GATEWAY_INTEGRATION.md`: I don't have your actual
service source, so this is a precise guide rather than a diff. Unlike
the auth work (gateway-only), tracing touches all 5 services
identically - copy the same two files into each one.

## 1. Install dependencies (in each of the 5 services)

```bash
cd services/<service-name>
npm install \
  @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/instrumentation-kafkajs \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

`bid-stream-consumer`, `cost-engine`, `anomaly-service`, and `gateway`
all touch Kafka, so the KafkaJS instrumentation matters for all four -
install it everywhere anyway rather than tracking which services need
which subset; the cost of one unused instrumentation package is lower
than the cost of forgetting it on the one service that needed it.

## 2. Copy in the files

Copy `tracing.ts` and `bootstrap.ts` into every `services/<name>/src/`.
Both are identical across all 5 services - nothing to customize, the
per-service identity comes entirely from the `SERVICE_NAME` env var
already set in `docker-compose.yml`.

## 3. Confirm tsc picks them up

If your `tsconfig.json` uses `"include": ["src/**/*.ts"]` (or similar),
nothing else is needed - `npm run build` will compile `bootstrap.ts` and
`tracing.ts` to `dist/` alongside everything else, which is where
`docker-compose.yml`'s `command: ["node", "--require",
"./dist/bootstrap.js", "dist/index.js"]` expects to find them.

## 4. Why `--require`, not a normal `import`

This is the one detail that will silently produce zero spans if
skipped: OpenTelemetry's auto-instrumentation works by patching modules
(`kafkajs`, `pg`, `express`, `http`) the moment they're first
`require()`'d/imported. If `tracing.ts` starts *after*
`index.ts` has already imported `kafkajs`, that specific KafkaJS
instance was never patched, and you'll see no error, no crash, no
spans - the SDK reports `sdk.start()` succeeded because it did, it just
started too late to catch anything. Each service's `Dockerfile` `CMD`
now bakes in `--require ./dist/bootstrap.js` directly (not just a
`docker-compose.yml`-level `command:` override), so this is correct
regardless of how the image is run - a plain `docker run`, a different
orchestrator, anything - not only under `docker compose up`. The
failure mode to watch for is if `dist/index.js` itself has an
`import './tracing.js'` line added redundantly somewhere in application
code - remove it if so, the `--require` flag is the only place this
should be invoked from.

## 5. What you'll actually see

Once wired: `http://localhost:16686` (Jaeger UI) has a service dropdown
listing all 5 services (grouped under the `truebid` namespace - see
`tracing.ts`'s `buildResource`). A single bid tick should show up as one
connected trace: `bid-stream-consumer`'s Kafka producer span, into
`cost-engine`'s Kafka consumer span (and `anomaly-service`'s, in
parallel), into whatever HTTP calls those services make (Postgres
queries show up too, via the auto-instrumentation's `pg` support). The
WebSocket push from `gateway` to the browser is NOT captured - OTel's
browser-side instrumentation is a separate, heavier lift (a
`@opentelemetry/sdk-trace-web` bundle shipped to the frontend) that
isn't included in this pass; the trace currently ends at the last
server-side hop before the WS `send()`. Worth doing later if you want
the full loop, not blocking for the backend story this already tells.

## 6. Sanity check without opening the UI

```bash
curl -s http://localhost:16686/api/services | jq
```
Should list all 5 service names once each service has emitted at least
one span (any HTTP request or Kafka message triggers one - the
`/healthz` polling from Docker's own healthchecks is enough on its own).
