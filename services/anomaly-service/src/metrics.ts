import client from "prom-client";

export const register = new client.Registry();
register.setDefaultLabels({ service: "anomaly-service" });
client.collectDefaultMetrics({ register });

export const bidsProcessedTotal = new client.Counter({
  name: "bids_processed_total",
  help: "Number of bid events consumed from the `bids` Kafka topic",
  registers: [register],
});

export const anomalyScoreTotal = new client.Counter({
  name: "anomaly_score_total",
  help: "Number of anomaly scores produced, labeled by resulting risk level",
  labelNames: ["risk_level"],
  registers: [register],
});

export const redisLatency = new client.Histogram({
  name: "redis_latency_seconds",
  help: "Time spent on individual Redis commands issued by the anomaly detector",
  labelNames: ["command"],
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [register],
});

export const kafkaConsumerLag = new client.Gauge({
  name: "kafka_consumer_lag",
  help: "Estimated consumer lag (messages behind the partition's high watermark) per topic/partition",
  labelNames: ["topic", "partition"],
  registers: [register],
});
