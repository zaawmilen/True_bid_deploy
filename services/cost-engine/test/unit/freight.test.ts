import { describe, expect, it } from "vitest";
import {
  carrierApiEstimate,
  estimateDistanceMiles,
  regressionEstimate,
} from "../../src/calculators/freight.js";

const DALLAS: [number, number] = [32.7767, -96.7970];
const LOS_ANGELES: [number, number] = [34.0522, -118.2437];

describe("estimateDistanceMiles", () => {
  it("returns zero for identical coordinates", () => {
    expect(estimateDistanceMiles(DALLAS, DALLAS)).toBeCloseTo(0, 5);
  });

  it("computes a known great-circle distance within a reasonable tolerance", () => {
    // Dallas -> LA is ~1230 real-world driving miles / ~1180 great-circle miles.
    const distance = estimateDistanceMiles(DALLAS, LOS_ANGELES);
    expect(distance).toBeGreaterThan(1100);
    expect(distance).toBeLessThan(1300);
  });

  it("is symmetric regardless of direction", () => {
    const forward = estimateDistanceMiles(DALLAS, LOS_ANGELES);
    const backward = estimateDistanceMiles(LOS_ANGELES, DALLAS);
    expect(forward).toBeCloseTo(backward, 6);
  });
});

describe("regressionEstimate", () => {
  it("always includes the base dispatch fee even at zero distance", () => {
    const result = regressionEstimate(DALLAS, DALLAS, "sedan");
    expect(result.estimated_cost).toBe(150);
    expect(result.distance_miles).toBe(0);
    expect(result.method).toBe("regression_fallback");
  });

  it("charges more per mile for heavier vehicle classes", () => {
    const sedan = regressionEstimate(DALLAS, LOS_ANGELES, "sedan");
    const suv = regressionEstimate(DALLAS, LOS_ANGELES, "suv");
    const truck = regressionEstimate(DALLAS, LOS_ANGELES, "truck");
    expect(sedan.estimated_cost).toBeLessThan(suv.estimated_cost);
    expect(suv.estimated_cost).toBeLessThan(truck.estimated_cost);
  });

  it("falls back to the default rate for an unrecognized vehicle class", () => {
    // @ts-expect-error - intentionally passing an invalid class to exercise the fallback
    const result = regressionEstimate(DALLAS, LOS_ANGELES, "minivan");
    const expected = regressionEstimate(DALLAS, LOS_ANGELES, "default");
    expect(result.estimated_cost).toBe(expected.estimated_cost);
  });

  it("applies a surcharge for inoperable vehicles", () => {
    const operable = regressionEstimate(DALLAS, LOS_ANGELES, "sedan", false);
    const inoperable = regressionEstimate(DALLAS, LOS_ANGELES, "sedan", true);
    expect(inoperable.estimated_cost).toBeCloseTo(operable.estimated_cost * 1.25, 2);
  });

  it("rounds distance to one decimal and cost to two decimals", () => {
    const result = regressionEstimate(DALLAS, LOS_ANGELES, "sedan");
    expect(Number.isInteger(result.distance_miles * 10)).toBe(true);
    expect(Number.isInteger(result.estimated_cost * 100)).toBe(true);
  });
});

describe("carrierApiEstimate", () => {
  it("is stubbed to always signal fallback via null", async () => {
    const result = await carrierApiEstimate("75201", "90001", "sedan");
    expect(result).toBeNull();
  });
});
