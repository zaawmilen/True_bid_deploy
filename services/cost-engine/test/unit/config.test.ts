import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadConfig() {
  vi.resetModules();
  return import("../../src/config.js");
}

describe("config", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("reads DATABASE_URL when it's set", async () => {
    process.env.DATABASE_URL = "postgres://real-connection-string";
    const { config } = await loadConfig();
    expect(config.databaseUrl).toBe("postgres://real-connection-string");
  });

  it("falls back to a fixed placeholder for DATABASE_URL under NODE_ENV=test instead of exiting", async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "test";
    const { config } = await loadConfig();
    expect(config.databaseUrl).toBe("test-placeholder-database_url");
  });

  it("fails fast (logs fatal + exits) when DATABASE_URL is missing outside of tests", async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "production";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(loadConfig()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaults KAFKA_BOOTSTRAP to localhost:9092 when unset", async () => {
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.KAFKA_BOOTSTRAP;
    const { config } = await loadConfig();
    expect(config.kafkaBootstrap).toBe("localhost:9092");
  });

  it("uses KAFKA_BOOTSTRAP from the environment when set (e.g. docker-compose's kafka:9092)", async () => {
    process.env.DATABASE_URL = "postgres://x";
    process.env.KAFKA_BOOTSTRAP = "kafka:9092";
    const { config } = await loadConfig();
    expect(config.kafkaBootstrap).toBe("kafka:9092");
  });

  it("defaults PORT to 8000 and honors an explicit override", async () => {
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.PORT;
    const defaultResult = await loadConfig();
    expect(defaultResult.config.port).toBe(8000);

    process.env.PORT = "9999";
    const overriddenResult = await loadConfig();
    expect(overriddenResult.config.port).toBe(9999);
  });

  it("leaves photoAnalysisUrl undefined rather than a placeholder string when unset", async () => {
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.PHOTO_ANALYSIS_URL;
    const { config } = await loadConfig();
    expect(config.photoAnalysisUrl).toBeUndefined();
  });

  it("reads photoAnalysisUrl when set", async () => {
    process.env.DATABASE_URL = "postgres://x";
    process.env.PHOTO_ANALYSIS_URL = "http://cv-service.local";
    const { config } = await loadConfig();
    expect(config.photoAnalysisUrl).toBe("http://cv-service.local");
  });
});
