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

  it("defaults KAFKA_BOOTSTRAP to localhost:9092 when unset", async () => {
    delete process.env.KAFKA_BOOTSTRAP;
    const { config } = await loadConfig();
    expect(config.kafkaBootstrap).toBe("localhost:9092");
  });

  it("uses KAFKA_BOOTSTRAP from the environment when set", async () => {
    process.env.KAFKA_BOOTSTRAP = "kafka:9092";
    const { config } = await loadConfig();
    expect(config.kafkaBootstrap).toBe("kafka:9092");
  });
});
