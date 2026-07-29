import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadConfig() {
  vi.resetModules();
  return import("../../src/config.js");
}

describe("config", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("defaults KAFKA_BOOTSTRAP and REDIS_URL to local-dev values when unset", async () => {
    delete process.env.KAFKA_BOOTSTRAP;
    delete process.env.REDIS_URL;
    const { config } = await loadConfig();
    expect(config.kafkaBootstrap).toBe("localhost:9092");
    expect(config.redisUrl).toBe("redis://localhost:6379/0");
  });

  it("uses the environment's values when set (e.g. docker-compose's kafka:9092 / redis:6379)", async () => {
    process.env.KAFKA_BOOTSTRAP = "kafka:9092";
    process.env.REDIS_URL = "redis://redis:6379/0";
    const { config } = await loadConfig();
    expect(config.kafkaBootstrap).toBe("kafka:9092");
    expect(config.redisUrl).toBe("redis://redis:6379/0");
  });
});
