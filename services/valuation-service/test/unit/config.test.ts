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

  it("reads DATABASE_URL when set", async () => {
    process.env.DATABASE_URL = "postgres://real";
    const { config } = await loadConfig();
    expect(config.databaseUrl).toBe("postgres://real");
  });

  it("falls back to a placeholder under NODE_ENV=test instead of exiting", async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "test";
    const { config } = await loadConfig();
    expect(config.databaseUrl).toBe("test-placeholder-database_url");
  });

  it("fails fast when DATABASE_URL is missing outside of tests", async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "production";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    await expect(loadConfig()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaults PORT to 8000 and honors an override", async () => {
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.PORT;
    expect((await loadConfig()).config.port).toBe(8000);

    process.env.PORT = "8002";
    expect((await loadConfig()).config.port).toBe(8002);
  });
});
