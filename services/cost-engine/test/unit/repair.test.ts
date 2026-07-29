import { describe, expect, it } from "vitest";
import { estimateRepairBand } from "../../src/calculators/repair.js";

describe("estimateRepairBand - severity bands", () => {
  it("uses the matching band for a known damage code (case/whitespace insensitive)", () => {
    const result = estimateRepairBand("  Front End  ", null, true);
    expect(result.repair_low).toBe(1800);
    expect(result.repair_high).toBe(4500);
  });

  it("falls back to the default band for an unrecognized damage code", () => {
    const result = estimateRepairBand("meteor strike", null, true);
    expect(result.repair_low).toBe(1000);
    expect(result.repair_high).toBe(3500);
  });

  it("falls back to the default band when damage_primary is null", () => {
    const result = estimateRepairBand(null, null, true);
    expect(result.repair_low).toBe(1000);
    expect(result.repair_high).toBe(3500);
  });

  it("widens (not adds) the high end when secondary damage is present", () => {
    const result = estimateRepairBand("front end", "undercarriage", true);
    expect(result.repair_low).toBe(1800); // low unaffected by secondary damage
    expect(result.repair_high).toBe(Math.round(4500 * 1.35));
  });
});

describe("estimateRepairBand - run and drive", () => {
  it("increases both ends of the band for non-running vehicles", () => {
    const running = estimateRepairBand("side", null, true);
    const notRunning = estimateRepairBand("side", null, false);
    expect(notRunning.repair_low).toBe(Math.round(1500 * 1.4));
    expect(notRunning.repair_high).toBe(Math.round(4000 * 1.6));
    expect(notRunning.repair_low).toBeGreaterThan(running.repair_low);
    expect(notRunning.repair_high).toBeGreaterThan(running.repair_high);
  });
});

describe("estimateRepairBand - confidence / honesty about uncertainty", () => {
  it("defaults to medium confidence with no photo signals at all", () => {
    const result = estimateRepairBand("side", null, true, {});
    expect(result.confidence).toBe("medium");
  });

  it("defaults to medium confidence when photoSignals is omitted entirely", () => {
    const result = estimateRepairBand("side", null, true);
    expect(result.confidence).toBe("medium");
  });

  it("drops to low confidence and widens the high band when undercarriage photos are missing", () => {
    const withoutMissing = estimateRepairBand("side", null, true, { missing_angles: [] });
    const withMissing = estimateRepairBand("side", null, true, {
      missing_angles: ["undercarriage"],
    });
    expect(withMissing.confidence).toBe("low");
    expect(withMissing.repair_high).toBe(Math.round(withoutMissing.repair_high * 1.2));
  });

  it("drops to low confidence when engine_bay photos are missing", () => {
    const result = estimateRepairBand("side", null, true, { missing_angles: ["engine_bay"] });
    expect(result.confidence).toBe("low");
  });

  it("reaches high confidence only with analyzed evidence, low misalignment, and no missing angles", () => {
    const result = estimateRepairBand("side", null, true, {
      missing_angles: [],
      panel_misalignment_score: 0.02,
    });
    expect(result.confidence).toBe("high");
  });

  it("does not reach high confidence if panel misalignment score is elevated", () => {
    const result = estimateRepairBand("side", null, true, {
      missing_angles: [],
      panel_misalignment_score: 0.5,
    });
    expect(result.confidence).toBe("medium");
  });

  it("does not read an empty-but-present photoSignals object as verified/high confidence", () => {
    // Object has no keys at all -> analyzed=false -> must stay medium, never high
    const result = estimateRepairBand("side", null, true, {});
    expect(result.confidence).not.toBe("high");
  });
});
