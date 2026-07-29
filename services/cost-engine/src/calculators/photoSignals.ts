/**
 * Photo signal source for the repair-cost estimator.
 *
 * Two tiers, deliberately kept separate:
 *
 * 1. Angle-completeness - real today, no external dependency. Uses the
 *    lot's own `photo_angles_captured` intake metadata to compute which
 *    required angles are missing. This alone is enough to drive the
 *    repair estimator's honesty-about-uncertainty behavior (missing
 *    undercarriage/engine_bay photos -> low confidence).
 * 2. Pixel-level analysis (panel misalignment, fluid leaks, etc.) - the
 *    real payoff, but requires an actual CV model over the photo pixels.
 *    Wired the same way freight's carrierApiEstimate is: if
 *    PHOTO_ANALYSIS_URL is set (pointing at the existing AI-powered
 *    search & analysis pipeline), call it; on any failure or if it's
 *    unset, fall back to tier 1 alone rather than fabricate a score.
 */

import type { PhotoSignals } from "./repair.js";
import { config } from "../config.js";
import { errorFields, logger } from "../logger.js";

const REQUIRED_ANGLES = ["front", "rear", "side", "undercarriage", "engine_bay", "interior"];

export interface LotPhotoMetadata {
  photo_angles_captured: string[] | null;
}

interface PixelAnalysisResponse {
  panel_misalignment_score?: number;
}

export async function getPhotoSignals(lot: LotPhotoMetadata): Promise<PhotoSignals> {
  const captured = new Set(lot.photo_angles_captured ?? []);
  const missingAngles = REQUIRED_ANGLES.filter((angle) => !captured.has(angle));

  if (config.photoAnalysisUrl) {
    try {
      const res = await fetch(`${config.photoAnalysisUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_angles_captured: Array.from(captured) }),
      });
      if (res.ok) {
        const data = (await res.json()) as PixelAnalysisResponse;
        return { missing_angles: missingAngles, panel_misalignment_score: data.panel_misalignment_score };
      }
      logger.warn("photo analysis service returned non-OK status, falling back to angle-completeness only", {
        status: res.status,
      });
    } catch (err) {
      logger.warn("photo analysis service unreachable, falling back to angle-completeness only", errorFields(err));
    }
  }

  return { missing_angles: missingAngles };
}
