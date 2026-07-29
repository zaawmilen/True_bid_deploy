function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface Config {
  port: number;
  kafkaBootstrap: string;
}

export const config: Config = {
  // This service has no HTTP API of its own - it's a pure Kafka producer
  // (the simulated auction feed) - but still exposes /healthz and /readyz
  // so it can be monitored/orchestrated the same way as the other four.
  port: Number(optionalEnv("PORT", "8000")),
  kafkaBootstrap: optionalEnv("KAFKA_BOOTSTRAP", "localhost:9092"),
};
