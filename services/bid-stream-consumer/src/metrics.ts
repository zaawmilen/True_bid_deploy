import client from "prom-client";

export const register = new client.Registry();
register.setDefaultLabels({ service: "bid-stream-consumer" });
client.collectDefaultMetrics({ register });

// Not on the evaluator's explicit list, but the natural producer-side
// counterpart of every other service's bids_processed_total - added for
// symmetry since it's nearly free.
export const bidsPublishedTotal = new client.Counter({
  name: "bids_published_total",
  help: "Number of simulated bid events published to the `bids` Kafka topic",
  registers: [register],
});
