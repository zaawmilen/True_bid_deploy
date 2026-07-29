# Pre-deployment checklist

Things to verify before pushing this live or pointing a recruiter at a
demo link. Grouped by what breaks if you skip it.

## 1. The Kafka gap — closed

All nine bugs found while getting `docker compose up` fully working end
to end are documented in the README's ["Verification
status"](../README.md#verification-status) section — no need to duplicate
that writeup here. Confirmed live: all 9 containers up, all 4 frontend
panels (cost, cost-stack bar, risk, comparable value) updating in real
time from actual Kafka traffic.

If you're setting this up fresh on a new machine, the one thing worth
repeating: **on Windows/WSL2, keep the repo on the native Linux
filesystem (`~/truebid`), not under `/mnt/c/...`.** Docker Desktop's
bind-mount reliability over the Windows-mounted path is meaningfully
worse and produced several confusing, code-unrelated failures during
testing.

## 2. Secrets and config — closed

- [x] `docker-compose.yml` no longer hardcodes credentials. All
      Postgres/Redis values now come from `${VAR:-default}` interpolation,
      sourced from a root `.env` file if present (falls back to the same
      local-dev defaults if not, so `docker compose up` still works with
      zero setup). Copy `.env.example` → `.env` and edit if you're
      deploying somewhere with a real database.
- [ ] Confirm `.gitignore` is committed *before* your first `git add .`,
      not after — otherwise `node_modules/` and any `.env` you create
      will already be in history. (`git rm -r --cached node_modules` if
      you already committed it.)
- [ ] Double-check no real API keys, freight-carrier credentials, or
      personal info ended up in any committed file — this repo currently
      has none (freight/CV integrations are stubs), just confirm that
      stays true as you extend it.

## 3. Service resilience (what I actually tested)

- [ ] `gateway` degrades correctly when Kafka is unreachable (verified) —
      but confirm it also recovers once Kafka comes back up, not just
      that it doesn't crash while Kafka is down.
- [ ] `cost-engine` and `valuation-service` both hard-fail if Postgres is
      unreachable at request time (they don't have a fallback — a DB
      outage means real errors, not degraded output). Decide if that's
      acceptable for a demo (it's fine) or needs a retry/circuit-breaker
      if you extend this toward "production-grade."
- [ ] `anomaly-service`'s z-score threshold (`ZSCORE_ANOMALY_THRESHOLD =
      2.5`) and `bid-stream-consumer`'s bid pacing are tuned for a demo
      auction, not real traffic volume — don't present the specific
      threshold numbers as calibrated, just as a reasonable starting
      default (the README already says this).

## 4. Hosting a live demo (not just a GitHub repo)

See [`docs/HOSTING.md`](HOSTING.md) for the full guide — platform
comparison, Kafka cost tradeoffs (now running in KRaft mode, no
Zookeeper), and Railway-specific deploy steps. Quick checklist once
deployed:

- [ ] `frontend/index.html`'s `GATEWAY_WS` / `VALUATION_HTTP` constants
      updated to the deployed URLs (`wss://` not `ws://` if served over
      HTTPS).
- [ ] `historical_sales` re-seeded on the deployed Postgres.
- [ ] Env vars (`KAFKA_BOOTSTRAP`, `DATABASE_URL`, `REDIS_URL`) set per
      service on the host, matching `docker-compose.yml`'s local values.

## 5. Repo hygiene for recruiters

- [ ] `README.md` is the front door — confirm the architecture diagram
      (`docs/architecture.svg`) actually renders on GitHub (it will;
      GitHub renders inline SVG in markdown) before you link the repo
      anywhere.
- [ ] Remove or clearly label anything still a stub (`carrierApiEstimate`
      returning `null`, empty `photoSignals`) — the README already flags
      these explicitly, keep that section up to date as you close gaps.
- [ ] Add a short top-of-README "what this demonstrates" line if you
      haven't already — recruiters skim before they read; the pitch
      paragraph at the top currently does this well, don't bury it under
      the architecture diagram.
- [ ] If you record a demo GIF/video (recommended — this was on the
      original punch list), do it *after* item 1 above is confirmed
      working, not before.

## 6. Nice-to-have, not blocking

- [ ] Basic rate limiting on `gateway`'s HTTP/WS endpoints if this will
      sit on a public URL indefinitely (bots do scan open ports).
- [x] Every service exposes `GET /healthz` (liveness) and `GET /readyz`
      (readiness - checks the actual dependencies each service needs, e.g.
      Postgres for `cost-engine`/`valuation-service`, Kafka+Redis for
      `anomaly-service`). `docker-compose.yml`'s `healthcheck:` blocks use
      `/healthz` specifically, not `/readyz` - a downstream Postgres/Kafka
      outage should surface via `/readyz` to whatever's routing traffic,
      not cause Docker to kill and restart an otherwise-healthy process.
      See `docs/TESTING.md` for what each service's `/readyz` actually
      checks and why.
- [x] Every service exposes `GET /metrics` in Prometheus text format
      (bids processed, cost-calculation duration, valuation requests,
      anomaly scores, WebSocket client counts, Kafka consumer lag,
      Postgres query duration, Redis latency, plus free process-level
      metrics via `collectDefaultMetrics()`). Nothing scrapes these yet
      in this repo - a Prometheus server + Grafana dashboards is still a
      real gap before this is production-observable end to end, not just
      instrumented. See `docs/TESTING.md#metrics` for the full list.
