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

  it("emits INFO on stdout as a single JSON line tagged with this service's name", () => {
    logger.info("valuation request", { lot: "LOT-1001", comp_count: 12, confidence: "high" });

    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "INFO",
      service: "valuation-service",
      message: "valuation request",
      lot: "LOT-1001",
      comp_count: 12,
      confidence: "high",
    });
  });

  it("routes WARN/ERROR/FATAL to stderr, not stdout", () => {
    logger.warn("no comps found");
    logger.error("query failed");
    logger.fatal("startup failed");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });
});

describe("errorFields", () => {
  it("extracts message/stack from an Error", () => {
    const fields = errorFields(new Error("db down"));
    expect(fields.error).toBe("db down");
    expect(typeof fields.stack).toBe("string");
  });

  it("stringifies non-Error throwables", () => {
    expect(errorFields("plain string").error).toBe("plain string");
  });
});
