import { describe, expect, it } from "vitest";
import { calculateBuyerFee, estimateGateAndStorage, FeeBracket } from "../../src/calculators/fees.js";

const BRACKETS: FeeBracket[] = [
  { membership_tier: "basic", min_bid: 0, max_bid: 2000, fee_flat: 100, fee_pct: 0.0 },
  { membership_tier: "basic", min_bid: 2000, max_bid: 10000, fee_flat: 100, fee_pct: 0.08 },
  { membership_tier: "basic", min_bid: 10000, max_bid: null, fee_flat: 100, fee_pct: 0.06 },
  { membership_tier: "premier", min_bid: 0, max_bid: 2000, fee_flat: 50, fee_pct: 0.0 },
  { membership_tier: "premier", min_bid: 2000, max_bid: 10000, fee_flat: 50, fee_pct: 0.06 },
  { membership_tier: "premier", min_bid: 10000, max_bid: null, fee_flat: 50, fee_pct: 0.04 },
];

describe("calculateBuyerFee", () => {
  it("applies the flat-only bracket for a low bid", () => {
    expect(calculateBuyerFee(1500, "basic", BRACKETS)).toBe(100);
  });

  it("applies flat + percentage for a mid-range bid", () => {
    // 100 + 5000 * 0.08 = 500
    expect(calculateBuyerFee(5000, "basic", BRACKETS)).toBe(500);
  });

  it("is inclusive of min_bid at the lower boundary", () => {
    // bracket 2 starts at 2000 inclusive -> 100 + 2000*0.08 = 260
    expect(calculateBuyerFee(2000, "basic", BRACKETS)).toBe(260);
  });

  it("is exclusive of max_bid at the upper boundary (rolls into next bracket)", () => {
    // exactly 10000 should NOT match the [2000,10000) bracket, but the
    // 10000+ unbounded bracket instead
    expect(calculateBuyerFee(10000, "basic", BRACKETS)).toBe(100 + 10000 * 0.06);
  });

  it("handles the unbounded top bracket (max_bid null)", () => {
    expect(calculateBuyerFee(50000, "premier", BRACKETS)).toBe(50 + 50000 * 0.04);
  });

  it("differentiates membership tiers for the same bid amount", () => {
    const basicFee = calculateBuyerFee(5000, "basic", BRACKETS);
    const premierFee = calculateBuyerFee(5000, "premier", BRACKETS);
    expect(premierFee).toBeLessThan(basicFee);
  });

  it("rounds to the nearest cent", () => {
    const brackets: FeeBracket[] = [
      { membership_tier: "basic", min_bid: 0, max_bid: null, fee_flat: 0, fee_pct: 1 / 3 },
    ];
    expect(calculateBuyerFee(100, "basic", brackets)).toBe(33.33);
  });

  it("throws when no bracket matches the tier", () => {
    expect(() => calculateBuyerFee(500, "nonexistent-tier", BRACKETS)).toThrow(
      /No fee bracket found/
    );
  });

  it("throws when bid amount falls outside all brackets for a tier", () => {
    const brackets: FeeBracket[] = [
      { membership_tier: "basic", min_bid: 100, max_bid: 200, fee_flat: 10, fee_pct: 0 },
    ];
    expect(() => calculateBuyerFee(5, "basic", brackets)).toThrow(/No fee bracket found/);
  });
});

describe("estimateGateAndStorage", () => {
  it("charges nothing within the free window", () => {
    expect(estimateGateAndStorage(3)).toBe(0);
    expect(estimateGateAndStorage(4)).toBe(0);
  });

  it("charges only for days beyond the free window", () => {
    // 6 days pickup, 4 free -> 2 overdue days * $30 = $60
    expect(estimateGateAndStorage(6)).toBe(60);
  });

  it("never charges a negative amount for early pickup", () => {
    expect(estimateGateAndStorage(0)).toBe(0);
  });

  it("respects custom free-day and daily-fee overrides", () => {
    expect(estimateGateAndStorage(10, 2, 15)).toBe((10 - 2) * 15);
  });
});
