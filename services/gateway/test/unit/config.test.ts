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

  it("defaults PORT to 8000 and KAFKA_BOOTSTRAP to localhost:9092 when unset", async () => {
    delete process.env.PORT;
    delete process.env.KAFKA_BOOTSTRAP;
    const { config } = await loadConfig();
    expect(config.port).toBe(8000);
    expect(config.kafkaBootstrap).toBe("localhost:9092");
  });

  it("honors PORT and KAFKA_BOOTSTRAP overrides from the environment", async () => {
    process.env.PORT = "9000";
    process.env.KAFKA_BOOTSTRAP = "kafka:9092";
    const { config } = await loadConfig();
    expect(config.port).toBe(9000);
    expect(config.kafkaBootstrap).toBe("kafka:9092");
  });

  it("defaults valuationServiceUrl to localhost:8002 when unset", async () => {
    delete process.env.VALUATION_SERVICE_URL;
    const { config } = await loadConfig();
    expect(config.valuationServiceUrl).toBe("http://localhost:8002");
  });

  it("honors VALUATION_SERVICE_URL from the environment", async () => {
    process.env.VALUATION_SERVICE_URL = "http://valuation-service:8000";
    const { config } = await loadConfig();
    expect(config.valuationServiceUrl).toBe("http://valuation-service:8000");
  });

  it("does not fail fast on the insecure default JWT secret under NODE_ENV=test", async () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = "test";
    await expect(loadConfig()).resolves.toBeDefined();
  });

  it("fails fast (logs fatal + exits) in production with the insecure default JWT secret still set", async () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = "production";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(loadConfig()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not fail fast in production once a real JWT_SECRET is set", async () => {
    process.env.JWT_SECRET = "a-real-production-secret";
    process.env.NODE_ENV = "production";
    await expect(loadConfig()).resolves.toBeDefined();
  });
});
