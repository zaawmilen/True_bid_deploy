import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorFields, logger } from "../../src/logger.js";

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("emits INFO on stdout tagged with this service's name", () => {
    logger.info("consumer started");
    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ level: "INFO", service: "anomaly-service", message: "consumer started" });
  });

  it("routes WARN (e.g. a risk flag) and ERROR/FATAL to stderr, not stdout", () => {
    logger.warn("anomaly score", { risk_level: "high" });
    logger.error("Redis connection error");
    logger.fatal("fatal error");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });
});

describe("errorFields", () => {
  it("extracts message/stack from an Error", () => {
    const fields = errorFields(new Error("ECONNREFUSED"));
    expect(fields.error).toBe("ECONNREFUSED");
    expect(typeof fields.stack).toBe("string");
  });

  it("stringifies non-Error throwables", () => {
    expect(errorFields("plain string").error).toBe("plain string");
  });
});
