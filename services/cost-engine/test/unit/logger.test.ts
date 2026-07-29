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

  it("emits INFO/DEBUG as a single JSON line on stdout (console.log)", () => {
    logger.info("estimate built", { lot: "LOT-1001", cost: 5200 });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "INFO",
      service: "cost-engine",
      message: "estimate built",
      lot: "LOT-1001",
      cost: 5200,
    });
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("emits WARN/ERROR/FATAL on stderr (console.error), not stdout", () => {
    logger.warn("low confidence estimate");
    logger.error("db query failed");
    logger.fatal("unrecoverable startup error");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it("always includes service name and an ISO timestamp", () => {
    logger.info("no extra fields");
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.service).toBe("cost-engine");
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow();
  });

  it("produces valid, parseable JSON even with nested/complex field values", () => {
    logger.info("complex fields", { flags: [{ type: "bid_velocity", z_score: -3.2 }], nested: { a: 1 } });
    expect(() => JSON.parse(logSpy.mock.calls[0][0] as string)).not.toThrow();
  });
});

describe("errorFields", () => {
  it("extracts message and stack from a real Error", () => {
    const err = new Error("boom");
    const fields = errorFields(err);
    expect(fields.error).toBe("boom");
    expect(typeof fields.stack).toBe("string");
  });

  it("stringifies non-Error throwables instead of losing the information", () => {
    expect(errorFields("a plain string throw").error).toBe("a plain string throw");
    expect(errorFields(404).error).toBe("404");
    expect(errorFields(null).error).toBe("null");
  });

  it("never includes a stack field for non-Error values", () => {
    expect(errorFields("oops")).not.toHaveProperty("stack");
  });
});
