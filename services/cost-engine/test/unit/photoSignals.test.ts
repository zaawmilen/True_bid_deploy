import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadModule() {
  vi.resetModules();
  return import("../../src/calculators/photoSignals.js");
}

describe("getPhotoSignals - angle completeness (no CV dependency)", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PHOTO_ANALYSIS_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports all required angles missing when none were captured", async () => {
    const { getPhotoSignals } = await loadModule();
    const result = await getPhotoSignals({ photo_angles_captured: null });
    expect(result.missing_angles).toEqual(
      expect.arrayContaining(["front", "rear", "side", "undercarriage", "engine_bay", "interior"])
    );
    expect(result.panel_misalignment_score).toBeUndefined();
  });

  it("reports only the angles that were not captured", async () => {
    const { getPhotoSignals } = await loadModule();
    const result = await getPhotoSignals({
      photo_angles_captured: ["front", "rear", "side", "engine_bay"],
    });
    expect(result.missing_angles).toEqual(["undercarriage", "interior"]);
  });

  it("reports no missing angles when all required angles were captured", async () => {
    const { getPhotoSignals } = await loadModule();
    const result = await getPhotoSignals({
      photo_angles_captured: ["front", "rear", "side", "undercarriage", "engine_bay", "interior"],
    });
    expect(result.missing_angles).toEqual([]);
  });
});

describe("getPhotoSignals - CV analysis integration and fallback", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, PHOTO_ANALYSIS_URL: "http://cv-service.local" };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("merges pixel-analysis results when the CV service responds successfully", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ panel_misalignment_score: 0.04 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getPhotoSignals } = await loadModule();
    const result = await getPhotoSignals({ photo_angles_captured: ["front"] });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://cv-service.local/analyze",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.panel_misalignment_score).toBe(0.04);
    expect(result.missing_angles).toContain("undercarriage");
  });

  it("falls back to angle-completeness only when the CV service returns a non-OK status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    const { getPhotoSignals } = await loadModule();
    const result = await getPhotoSignals({ photo_angles_captured: [] });

    expect(result.panel_misalignment_score).toBeUndefined();
    expect(result.missing_angles?.length).toBeGreaterThan(0);
  });

  it("falls back to angle-completeness only when the CV service is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const { getPhotoSignals } = await loadModule();
    const result = await getPhotoSignals({ photo_angles_captured: [] });

    expect(result.panel_misalignment_score).toBeUndefined();
    expect(result.missing_angles?.length).toBeGreaterThan(0);
  });

  it("never fabricates a misalignment score on failure (undefined, not a default number)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const { getPhotoSignals } = await loadModule();
    const result = await getPhotoSignals({ photo_angles_captured: ["front"] });

    expect("panel_misalignment_score" in result ? result.panel_misalignment_score : undefined).toBeUndefined();
  });
});
