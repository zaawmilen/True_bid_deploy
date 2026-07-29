# Hosting a live demo

TrueBid is 12 containers (5 app services + Kafka (KRaft mode) + Postgres
+ Redis + Jaeger + Prometheus + Grafana + Caddy), so this needs a
platform that runs multiple long-lived services with private networking
between them — not a single-container/serverless host. As of mid-2026,
the practical options are:

| Platform | Fit for TrueBid | Notes |
|---|---|---|
| **Self-host (Hetzner + Caddy)** (recommended) | Best value | `docker-compose.prod.yml` and `Caddyfile` in this repo are built for exactly this — see below. A ~€6.50/mo Hetzner CX33 (4 vCPU / 8GB) comfortably runs the whole stack. Most setup work upfront, cheapest ongoing cost by a wide margin. |
| **Railway** | Good, less setup | Deploys straight from a Dockerfile per service, private networking between services by name (matches our compose setup almost 1:1). Costs more than self-hosting at this container count, but zero server/OS maintenance. |
| **Render** | OK | More predictable flat per-service pricing than Railway's usage-based model, but each of the 12 services is billed separately, which adds up fast for something this size. |
| **Fly.io** | Overkill | Built for global multi-region edge deployment — TrueBid is a single-region demo, so you'd be paying for capability you don't need. |

## The real cost driver: Kafka

Confluent's Kafka image is a JVM — meaningfully heavier than the Node
services around them. This repo already runs Kafka in **KRaft mode**
(Kafka's built-in metadata/quorum management), which dropped the
Zookeeper container entirely — one fewer JVM, real memory savings versus
the earlier Kafka+Zookeeper setup (see `docs/BUGS_FOUND.md` for context on
why the original setup used Zookeeper in the first place).

If hosting cost still matters more than matching this local dev setup
exactly, the next lever is:

- **Use a managed Kafka-compatible service** (Redpanda Cloud, Upstash
  Kafka) instead of self-hosting Kafka at all — point `KAFKA_BOOTSTRAP`
  at the managed endpoint and delete the `kafka` service from what you
  deploy. Fastest path to a cheaper deploy, at the cost of the demo no
  longer showing "I stood up my own Kafka cluster."

For a portfolio demo specifically, this is optional — the current
single-broker KRaft setup works as-is and is already meaningfully cheaper
to run continuously than the Zookeeper-based version was.

## Deploy steps (self-hosted: Hetzner + Caddy)

This is what `docker-compose.prod.yml` and `Caddyfile` in this repo are
actually built for — a single VPS running the whole stack, with Caddy as
the only public entry point and everything else (Postgres, Redis, Kafka,
the 5 app services, Prometheus, Jaeger's UI) unreachable from the public
internet. See that file's own header comment for exactly what's exposed
and why.

1. **Provision the server.** A Hetzner **CX33** (4 vCPU / 8GB RAM,
   ~€6.50/mo as of mid-2026) is the comfortable choice — Kafka's JVM
   alone wants 512MB-1GB, and 12 containers total add up. A CX23 (2 vCPU
   / 4GB) technically fits but is tight; you'd want to explicitly cap
   `KAFKA_HEAP_OPTS` rather than let the JVM take its default guess.
   Ubuntu 24.04 is a safe OS choice. Install Docker Engine + the Compose
   plugin on it (`curl -fsSL https://get.docker.com | sh` is Docker's own
   quick-install script and works fine on a fresh Hetzner box).
2. **DNS first, before starting anything.** Point two A records at the
   server's IP: one for the app itself (e.g. `truebid.yourdomain.com`)
   and one for Grafana (e.g. `monitoring.yourdomain.com`). Caddy's
   automatic HTTPS (Let's Encrypt) needs these to already resolve
   correctly on first boot, or certificate issuance fails.
3. **Firewall.** Only 22 (SSH), 80, and 443 need to be open publicly —
   nothing else. If using Hetzner's own Cloud Firewall (recommended over
   configuring `ufw` by hand, since it's enforced at the network level
   before traffic even reaches the box): create a firewall in the
   Hetzner Console allowing inbound TCP 22/80/443 only, and attach it to
   the server. `docker-compose.prod.yml` doesn't publish any other ports
   to `0.0.0.0` anyway (Prometheus/Jaeger are bound to `127.0.0.1` only),
   so this is defense in depth, not the only thing standing between the
   internet and Postgres.
4. **Copy the repo onto the server** (`git clone`, or `scp` a tarball —
   either works) and `cd` into it.
5. **Create `.env`** from `.env.example`, filling in every variable in
   the "ONLY used by docker-compose.prod.yml" section: `DOMAIN`,
   `GRAFANA_DOMAIN`, `ACME_EMAIL`, and real values for
   `POSTGRES_PASSWORD`, `JWT_SECRET` (generate with
   `openssl rand -base64 48`), and `GRAFANA_ADMIN_PASSWORD`. Compose will
   refuse to start at all if any of these are missing — there's no
   insecure fallback to accidentally deploy with.
6. **Start it:**
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
   Not `-f docker-compose.yml -f docker-compose.prod.yml` — see
   `docker-compose.prod.yml`'s own header comment for why that
   combination would silently expose things it shouldn't.
7. **Watch it come up:**
   ```bash
   docker compose -f docker-compose.prod.yml ps
   docker compose -f docker-compose.prod.yml logs -f
   ```
   Expect the same Kafka cold-start behavior as locally (see
   `docs/BUGS_FOUND.md`) — the retry logic in this repo handles it the
   same way in any environment.
8. **Host the frontend somewhere static** — GitHub Pages, Netlify, or
   even Caddy itself can serve `frontend/index.html` as a third site
   block. Either way, update `GATEWAY_HTTP`/`GATEWAY_WS` near the bottom
   of its `<script>` block to your real domain, using `wss://` not
   `ws://` (browsers block mixed-content WebSocket connections from an
   `https://` page).
9. **Verify it end-to-end** — see `docs/DEPLOYMENT_CHECKLIST.md` item 1
   and `test/e2e/smoke.mjs`, pointed at your real domain instead of
   `localhost` via its `GATEWAY_URL`/etc. environment variables.

**Checking Prometheus/Jaeger without exposing them publicly:**
```bash
ssh -L 9090:localhost:9090 -L 16686:localhost:16686 you@your-server-ip
```
then open `http://localhost:9090` / `http://localhost:16686` on your own
machine as if they were running locally.

## Deploy steps (Railway)

1. **Push the repo to GitHub** if it isn't already — Railway deploys from
   a connected repo.
2. **Create a new Railway project**, then add each piece:
   - `postgres` and `redis` — Railway's one-click database plugins (skip
     the Dockerfile for these, use Railway's managed versions instead —
     simpler and gives you a dashboard for the data).
   - `kafka` — deploy from the same `confluentinc/cp-kafka` image used in
     `docker-compose.yml` (KRaft mode, no Zookeeper service needed).
   - `jaeger`, `prometheus`, `grafana` — deploy from the same images used
     in `docker-compose.yml`/`monitoring/`.
   - The 5 app services — each deploys from its own
     `services/<name>/Dockerfile` (Railway auto-detects Dockerfiles in
     subdirectories when you point it at the repo).
3. **Set environment variables** per service, matching what
   `docker-compose.yml` sets locally — `KAFKA_BOOTSTRAP`, `DATABASE_URL`,
   `REDIS_URL`, `JWT_SECRET`, etc. Railway's private networking gives
   every service in the project a resolvable internal hostname, the same
   way `kafka`, `postgres`, `redis` resolve inside `docker-compose.yml`
   today — use those same service names. Only expose the `gateway`
   service publicly (and optionally `grafana`); everything else should
   stay on Railway's private network only, same reasoning as the
   self-hosted setup above.
4. **Re-seed Postgres**: run `001_schema.sql` then `002_historical_sales_seed.sql`
   against the deployed database once (Railway's Postgres plugin gives you
   a connection string you can `psql -f` against directly, or use its
   built-in query console).
5. **Update the frontend config**: in `frontend/index.html`, replace the
   `GATEWAY_HTTP` and `GATEWAY_WS` constants near the bottom of the
   `<script>` block with your deployed `gateway` service's public URL.
   Use `wss://` not `ws://` — Railway serves over HTTPS, and browsers
   block mixed-content `ws://` connections from an `https://` page.
6. **Host the frontend somewhere static** — GitHub Pages, Netlify, or
   Railway's own static hosting all work; it's a single HTML file with no
   build step, so any static host is fine.

## After deploying

- Confirm the same things from `docs/DEPLOYMENT_CHECKLIST.md` item 1, but
  against the deployed URLs instead of `localhost`.
- Expect the same Kafka cold-start behavior on first boot as locally — the
  healthchecks and retry logic in this repo handle it the same way in any
  environment, not just Docker Compose.

