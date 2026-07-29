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
    logger.info("bid placed", { bidder: "bidder-1", amount: 550, lot: "LOT-1001" });
    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "INFO",
      service: "bid-stream-consumer",
      message: "bid placed",
      bidder: "bidder-1",
      amount: 550,
    });
  });

  it("routes FATAL to stderr, not stdout", () => {
    logger.fatal("fatal error");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("errorFields", () => {
  it("extracts message/stack from an Error", () => {
    const fields = errorFields(new Error("producer connect failed"));
    expect(fields.error).toBe("producer connect failed");
    expect(typeof fields.stack).toBe("string");
  });
});
