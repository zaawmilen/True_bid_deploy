import { logger } from "./logger.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value) return value;

  if (process.env.NODE_ENV === "test") {
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
}

export const config: Config = {
  port: Number(optionalEnv("PORT", "8000")),
  databaseUrl: requiredEnv("DATABASE_URL"),
};
