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
    logger.info("consumer group joined", { topic: "cost-updates", group_id: "gateway-cost-updates" });
    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "INFO",
      service: "gateway",
      message: "consumer group joined",
      topic: "cost-updates",
    });
  });

  it("routes ERROR/FATAL to stderr, not stdout", () => {
    logger.error("cost-updates consumer crashed, retrying");
    logger.fatal("cost-updates consumer crashed");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe("errorFields", () => {
  it("extracts message/stack from an Error", () => {
    const fields = errorFields(new Error("connection refused"));
    expect(fields.error).toBe("connection refused");
    expect(typeof fields.stack).toBe("string");
  });
});
