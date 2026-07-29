/**
 * Comparable-sale valuation model.
 *
 * Approach: k-nearest-neighbors over historical_sales, filtered first by
 * categorical match (make/model/title_type/damage_severity) then ranked by
 * numeric distance (year, mileage). This is deliberately simple - a
 * gradient-boosted model is the natural v2, but KNN-on-comps is honest,
 * explainable, and mirrors how a human appraiser actually reasons about
 * "comps," which matters when you're presenting a valuation to a bidder
 * who wants to trust the number.
 *
 * Falls back to a wider search radius (drop title_type/damage match) if
 * too few comps are found, and always reports how many comps backed the
 * estimate - so, like the repair estimator, this never hides its own
 * uncertainty.
 */

export type ValuationConfidence = "none" | "medium" | "high";

export interface HistoricalSaleRow {
  make: string;
  model: string;
  year: number;
  mileage: number;
  damage_severity: string;
  title_type: string;
  region: string;
  sale_price: number | string; // numeric columns come back as strings from `pg`
  sold_at?: string;
}

export interface ValuationQuery {
  make: string;
  model: string;
  year: number;
  mileage: number;
  damageSeverity: string;
  titleType: string;
}

export interface ValuationResult {
  comp_valuation: number | null;
  confidence: ValuationConfidence;
  comp_count: number;
}

const MIN_COMPS_FOR_HIGH_CONFIDENCE = 8;
const MIN_COMPS_FOR_ANY_ESTIMATE = 2;

function numericDistance(row: HistoricalSaleRow, year: number, mileage: number): number {
  const yearDiff = Math.abs(row.year - year) / 5.0; // normalize: 5 yrs ~ 1 unit
  const mileageDiff = Math.abs(row.mileage - mileage) / 30000.0; // 30k mi ~ 1 unit
  return yearDiff + mileageDiff;
}

export function estimateCompValue(
  historicalSales: HistoricalSaleRow[],
  { make, model, year, mileage, damageSeverity, titleType }: ValuationQuery
): ValuationResult {
  if (!historicalSales || historicalSales.length === 0) {
    return { comp_valuation: null, confidence: "none", comp_count: 0 };
  }

  // Tier 1: strict match
  let comps = historicalSales.filter(
    (r) =>
      r.make === make && r.model === model && r.title_type === titleType && r.damage_severity === damageSeverity
  );

  // Tier 2: relax title/damage match if too few comps
  if (comps.length < MIN_COMPS_FOR_ANY_ESTIMATE) {
    comps = historicalSales.filter((r) => r.make === make && r.model === model);
  }

  if (comps.length < MIN_COMPS_FOR_ANY_ESTIMATE) {
    return { comp_valuation: null, confidence: "none", comp_count: comps.length };
  }

  const withDistance = comps
    .map((r) => ({ row: r, distance: numericDistance(r, year, mileage) }))
    .sort((a, b) => a.distance - b.distance);

  const nearest = withDistance.slice(0, 15);

  // Weight closer comps more heavily rather than a flat average.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const comp of nearest) {
    const weight = 1.0 / (comp.distance + 0.5);
    weightedSum += Number(comp.row.sale_price) * weight;
    weightTotal += weight;
  }
  const weightedValue = weightedSum / weightTotal;

  const confidence: ValuationConfidence = nearest.length >= MIN_COMPS_FOR_HIGH_CONFIDENCE ? "high" : "medium";

  return {
    comp_valuation: Math.round(weightedValue * 100) / 100,
    confidence,
    comp_count: nearest.length,
  };
}
