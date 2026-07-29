import client from "prom-client";

// One private registry per service (rather than the global default
// registry) so importing this module twice in tests never double-registers
// a metric and throws.
export const register = new client.Registry();
register.setDefaultLabels({ service: "cost-engine" });
client.collectDefaultMetrics({ register });

export const bidsProcessedTotal = new client.Counter({
  name: "bids_processed_total",
  help: "Number of bid events consumed from the `bids` Kafka topic",
  registers: [register],
});

export const costCalculationDuration = new client.Histogram({
  name: "cost_calculation_duration_seconds",
  help: "Time to compute a full landed-cost estimate (fees + freight + repair band)",
  labelNames: ["tier"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const postgresQueryDuration = new client.Histogram({
  name: "postgres_query_duration_seconds",
  help: "Time spent on individual Postgres queries",
  labelNames: ["query"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// KafkaJS's consumer.events.END_BATCH_PROCESS payload includes offsetLag
// (the consumer's distance behind the partition's high watermark at fetch
// time) - the standard signal for "is this consumer falling behind?".
export const kafkaConsumerLag = new client.Gauge({
  name: "kafka_consumer_lag",
  help: "Estimated consumer lag (messages behind the partition's high watermark) per topic/partition",
  labelNames: ["topic", "partition"],
  registers: [register],
});
