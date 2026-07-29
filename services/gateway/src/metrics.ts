import client from "prom-client";

export const register = new client.Registry();
register.setDefaultLabels({ service: "gateway" });
client.collectDefaultMetrics({ register });

// Set (not incremented) directly from the size of the connections map, so
// it always reflects reality rather than drifting from separate
// increment/decrement calls scattered across connect/disconnect handlers.
export const websocketClients = new client.Gauge({
  name: "websocket_clients",
  help: "Number of currently connected WebSocket clients, labeled by lot",
  labelNames: ["lot_id"],
  registers: [register],
});

export const kafkaConsumerLag = new client.Gauge({
  name: "kafka_consumer_lag",
  help: "Estimated consumer lag (messages behind the partition's high watermark) per topic/partition",
  labelNames: ["topic", "partition"],
  registers: [register],
});
