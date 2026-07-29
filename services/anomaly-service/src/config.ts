function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface Config {
  port: number;
  kafkaBootstrap: string;
  redisUrl: string;
}

export const config: Config = {
  // This service has no HTTP API of its own - it's a pure Kafka
  // consumer/producer - but still exposes /healthz and /readyz so it can
  // be monitored/orchestrated the same way as the other four services.
  port: Number(optionalEnv("PORT", "8000")),
  kafkaBootstrap: optionalEnv("KAFKA_BOOTSTRAP", "localhost:9092"),
  redisUrl: optionalEnv("REDIS_URL", "redis://localhost:6379/0"),
};
