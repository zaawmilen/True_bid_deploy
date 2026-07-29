import { logger } from "./logger.js";

// One validated config object read at startup, instead of `process.env.X`
// scattered through the file: a missing required variable now fails loudly
// and immediately rather than surfacing later as a confusing runtime error
// (e.g. `pg` silently falling back to local-socket defaults if
// DATABASE_URL is undefined).
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value) return value;

  if (process.env.NODE_ENV === "test") {
    // Tests mock whatever this variable configures (pg's Pool, in this
    // case), so a fixed placeholder here means importing this module
    // under test never crashes just because the real infra's env vars
    // aren't set in the test environment.
    return `test-placeholder-${name.toLowerCase()}`;
  }

  logger.fatal(`missing required environment variable: ${name}`);
  process.exit(1);
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface Config {
  port: number;
  databaseUrl: string;
  kafkaBootstrap: string;
  photoAnalysisUrl: string | undefined;
}

export const config: Config = {
  port: Number(optionalEnv("PORT", "8000")),
  databaseUrl: requiredEnv("DATABASE_URL"),
  kafkaBootstrap: optionalEnv("KAFKA_BOOTSTRAP", "localhost:9092"),
  photoAnalysisUrl: process.env.PHOTO_ANALYSIS_URL,
};
