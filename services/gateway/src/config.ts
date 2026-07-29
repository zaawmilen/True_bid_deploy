import { logger } from "./logger.js";
import { assertAuthConfigSafe } from "./auth.js";

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface Config {
  port: number;
  kafkaBootstrap: string;
  valuationServiceUrl: string;
}

export const config: Config = {
  port: Number(optionalEnv("PORT", "8000")),
  kafkaBootstrap: optionalEnv("KAFKA_BOOTSTRAP", "localhost:9092"),
  // Used by the /valuation/:lotId proxy route (see auth.ts / authRoutes.ts) -
  // routing valuation requests through the gateway instead of letting the
  // frontend call valuation-service's own host port directly, which would
  // bypass JWT auth entirely (see docs/PRODUCTION_READINESS.md).
  valuationServiceUrl: optionalEnv("VALUATION_SERVICE_URL", "http://localhost:8002"),
};

// Same fail-fast treatment as DATABASE_URL/KAFKA_BOOTSTRAP elsewhere in
// this project: refuse to start in production with the insecure default
// JWT secret still in place, rather than silently signing forgeable
// tokens. Skipped under NODE_ENV=test so importing this module in tests
// never exits the process.
if (process.env.NODE_ENV !== "test") {
  try {
    assertAuthConfigSafe(process.env.NODE_ENV);
  } catch (err) {
    logger.fatal("refusing to start: unsafe auth configuration", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
