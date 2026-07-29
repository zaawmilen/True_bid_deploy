import { describe, expect, it } from "vitest";
import { estimateCompValue, HistoricalSaleRow, ValuationQuery } from "../../src/model/compValuation.js";

const BASE_QUERY: ValuationQuery = {
  make: "Ford",
  model: "Mustang",
  year: 2021,
  mileage: 34000,
  damageSeverity: "medium",
  titleType: "salvage",
};

function makeSale(overrides: Partial<HistoricalSaleRow> = {}): HistoricalSaleRow {
  return {
    make: "Ford",
    model: "Mustang",
    year: 2021,
    mileage: 34000,
    damage_severity: "medium",
    title_type: "salvage",
    region: "TX",
    sale_price: 10000,
    ...overrides,
  };
}

describe("estimateCompValue - no data / insufficient comps", () => {
  it("returns none/null when there are no historical sales at all", () => {
    const result = estimateCompValue([], BASE_QUERY);
    expect(result).toEqual({ comp_valuation: null, confidence: "none", comp_count: 0 });
  });

  it("returns none/null when fewer than the minimum comps exist even after widening", () => {
    const sales = [makeSale({ make: "Toyota", model: "Camry" })]; // no make/model match at all
    const result = estimateCompValue(sales, BASE_QUERY);
    expect(result.comp_valuation).toBeNull();
    expect(result.confidence).toBe("none");
  });
});

describe("estimateCompValue - tiered comparable search / wider search fallback", () => {
  it("prefers the strict match (make+model+title+damage) when enough comps exist there", () => {
    const strictMatches = Array.from({ length: 5 }, () => makeSale({ sale_price: 10000 }));
    const looseOnly = Array.from({ length: 5 }, () =>
      makeSale({ title_type: "clean", damage_severity: "low", sale_price: 50000 })
    );
    const result = estimateCompValue([...strictMatches, ...looseOnly], BASE_QUERY);
    // Value should track the strict-match price, not be dragged toward the loose comps
    expect(result.comp_valuation).toBeCloseTo(10000, 0);
    expect(result.comp_count).toBe(5);
  });

  it("widens the search (drops title/damage match) when strict comps are too few", () => {
    // Only 1 strict match (below MIN_COMPS_FOR_ANY_ESTIMATE=2), but several
    // same make/model comps with different title/damage - should widen.
    const sales = [
      makeSale({ sale_price: 9000 }),
      makeSale({ title_type: "clean", damage_severity: "low", sale_price: 15000 }),
      makeSale({ title_type: "rebuilt", damage_severity: "high", sale_price: 7000 }),
    ];
    const result = estimateCompValue(sales, BASE_QUERY);
    expect(result.confidence).not.toBe("none");
    expect(result.comp_count).toBe(3);
  });

  it("still returns none if even the widened make/model search is below the minimum", () => {
    const sales = [makeSale({ sale_price: 9000 })]; // only 1 comp, no other make/model matches
    const result = estimateCompValue(sales, BASE_QUERY);
    expect(result.confidence).toBe("none");
    expect(result.comp_valuation).toBeNull();
  });
});

describe("estimateCompValue - distance weighting", () => {
  it("weights comps with closer year/mileage more heavily than distant ones", () => {
    const close = makeSale({ year: 2021, mileage: 34000, sale_price: 12000 });
    const far = makeSale({ year: 2010, mileage: 150000, sale_price: 3000 });
    // Duplicate the close comp so we have >= MIN_COMPS_FOR_ANY_ESTIMATE (2)
    const result = estimateCompValue([close, close, far], BASE_QUERY);
    // Weighted average should sit much closer to 12000 than a flat average would (9000)
    expect(result.comp_valuation).toBeGreaterThan(9000);
  });

  it("caps the neighbor set at 15 comps", () => {
    const sales = Array.from({ length: 30 }, (_, i) =>
      makeSale({ year: 2021 - (i % 10), mileage: 30000 + i * 1000, sale_price: 10000 })
    );
    const result = estimateCompValue(sales, BASE_QUERY);
    expect(result.comp_count).toBe(15);
  });
});

describe("estimateCompValue - confidence levels", () => {
  it("reports medium confidence with fewer than 8 comps", () => {
    const sales = Array.from({ length: 5 }, () => makeSale());
    const result = estimateCompValue(sales, BASE_QUERY);
    expect(result.confidence).toBe("medium");
  });

  it("reports high confidence with 8 or more comps", () => {
    const sales = Array.from({ length: 8 }, () => makeSale());
    const result = estimateCompValue(sales, BASE_QUERY);
    expect(result.confidence).toBe("high");
  });

  it("handles sale_price arriving as a numeric string (as pg returns NUMERIC columns)", () => {
    const sales = [makeSale({ sale_price: "10000.50" }), makeSale({ sale_price: "9999.50" })];
    const result = estimateCompValue(sales, BASE_QUERY);
    expect(result.comp_valuation).toBeCloseTo(10000, 0);
  });
});
