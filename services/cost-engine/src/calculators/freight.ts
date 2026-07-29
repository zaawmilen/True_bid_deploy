/**
 * Freight estimator.
 *
 * Two modes, chosen deliberately to show the tradeoff explicitly:
 *
 * 1. carrierApiEstimate - the "real" path: call a live freight-quote API
 *    (e.g. Central Dispatch, uShip, or a broker's rate API) keyed by
 *    origin/destination and vehicle class. Stubbed here since it needs
 *    real credentials.
 *
 * 2. regressionEstimate - a fallback distance/vehicle-class model trained
 *    on historical shipment data. This is what actually runs in the demo,
 *    and it's the more interesting engineering artifact: it means the
 *    platform degrades gracefully instead of hard-failing when a carrier
 *    API is unavailable or rate-limited.
 */

export type LatLng = [number, number];
export type VehicleClass = "sedan" | "suv" | "truck" | "default";

export interface FreightEstimate {
  distance_miles: number;
  estimated_cost: number;
  method: "regression_fallback" | "carrier_api";
}

// Coarse $/mile bands by vehicle class, fit offline against historical
// open-transport quotes. In a real system this would be a small trained
// model (gradient boosting on distance, weight, operability, region)
// rather than hardcoded bands - the hardcoding here just keeps the demo
// self-contained.
const RATE_PER_MILE_BY_CLASS: Record<VehicleClass, number> = {
  sedan: 0.55,
  suv: 0.65,
  truck: 0.75,
  default: 0.6,
};

const BASE_FEE = 150.0; // covers loading/dispatch regardless of distance
const EARTH_RADIUS_MILES = 3958.8;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function estimateDistanceMiles([lat1, lon1]: LatLng, [lat2, lon2]: LatLng): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

export function regressionEstimate(
  origin: LatLng,
  destination: LatLng,
  vehicleClass: VehicleClass = "default",
  inoperable = false
): FreightEstimate {
  const distance = estimateDistanceMiles(origin, destination);
  const rate = RATE_PER_MILE_BY_CLASS[vehicleClass] ?? RATE_PER_MILE_BY_CLASS.default;

  let cost = BASE_FEE + distance * rate;
  if (inoperable) {
    // Inoperable vehicles need a winch/flatbed, historically ~20-30% more.
    cost *= 1.25;
  }

  return {
    distance_miles: Math.round(distance * 10) / 10,
    estimated_cost: Math.round(cost * 100) / 100,
    method: "regression_fallback",
  };
}

/**
 * Placeholder for a real integration. Returns null to signal "fall back to
 * regressionEstimate" - the caller always has a path to a number, which is
 * the actual product requirement (never show a bidder a blank cost field
 * mid-auction).
 */
export async function carrierApiEstimate(
  originZip: string,
  destinationZip: string,
  vehicleClass: VehicleClass
): Promise<FreightEstimate | null> {
  return null;
}
