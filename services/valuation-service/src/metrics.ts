import client from "prom-client";

export const register = new client.Registry();
register.setDefaultLabels({ service: "valuation-service" });
client.collectDefaultMetrics({ register });

export const valuationRequestsTotal = new client.Counter({
  name: "valuation_requests_total",
  help: "Number of GET /valuation/:lotId requests, labeled by resulting confidence",
  labelNames: ["confidence"],
  registers: [register],
});

export const postgresQueryDuration = new client.Histogram({
  name: "postgres_query_duration_seconds",
  help: "Time spent on individual Postgres queries",
  labelNames: ["query"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});
