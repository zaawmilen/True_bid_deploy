/**
 * Repair cost band estimator.
 *
 * Deliberately returns a *range* with a confidence label rather than a
 * single number - a single number implies false precision, and the
 * "run and drive doesn't mean reliable" trust gap is exactly the problem
 * this service exists to push back against.
 *
 * `photoSignals` is meant to come from the existing AI-powered search &
 * analysis pipeline (computer vision over the lot's photo set): things
 * like undercarriage visibility, panel misalignment score, fluid leak
 * detection. It's passed in here as a plain object so this service stays
 * decoupled from whatever CV model produces it.
 */

export type RepairConfidence = "low" | "medium" | "high";

export interface PhotoSignals {
  missing_angles?: string[];
  panel_misalignment_score?: number;
  [key: string]: unknown;
}

export interface RepairEstimate {
  repair_low: number;
  repair_high: number;
  confidence: RepairConfidence;
}

const DAMAGE_SEVERITY_BASE_COST: Record<string, [number, number]> = {
  "front end": [1800, 4500],
  "rear end": [1200, 3200],
  side: [1500, 4000],
  undercarriage: [2500, 6500],
  "water/flood": [3000, 9000],
  "burn/fire": [4000, 12000],
};

const DEFAULT_BAND: [number, number] = [1000, 3500];

export function estimateRepairBand(
  damagePrimary: string | null,
  damageSecondary: string | null,
  runAndDrive: boolean,
  photoSignals: PhotoSignals = {}
): RepairEstimate {
  const key = (damagePrimary || "").trim().toLowerCase();
  let [low, high] = DAMAGE_SEVERITY_BASE_COST[key] || DEFAULT_BAND;

  if (damageSecondary) {
    // A second damage area widens the band rather than just adding a flat
    // amount - compounding damage is harder to price precisely.
    high = Math.round(high * 1.35);
  }

  if (!runAndDrive) {
    low = Math.round(low * 1.4);
    high = Math.round(high * 1.6);
  }

  let confidence: RepairConfidence = "medium";
  const missingAngles = photoSignals.missing_angles || [];
  // High confidence requires actual analyzed evidence - an empty
  // photoSignals object (no CV data at all) must never read as "verified,"
  // it should read as "unknown," which stays at the medium default.
  const analyzed = photoSignals && Object.keys(photoSignals).length > 0;

  // Confidence tightens with more/better photo evidence, and widens when
  // key angles are missing - this is the honesty-about-uncertainty behavior
  // called out in the design doc.
  if (missingAngles.includes("undercarriage") || missingAngles.includes("engine_bay")) {
    confidence = "low";
    high = Math.round(high * 1.2);
  } else if (analyzed && (photoSignals.panel_misalignment_score ?? 1) < 0.1 && missingAngles.length === 0) {
    confidence = "high";
  }

  return { repair_low: low, repair_high: high, confidence };
}
