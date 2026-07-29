/**
 * Tiered buyer-fee calculator.
 *
 * Fee schedules are read from the `fee_schedules` table (see db/001_schema.sql).
 * This mirrors how Copart/IAAI structure buyer fees: a flat component plus
 * a percentage that changes by bid-amount bracket, further split by
 * membership tier (basic vs premier).
 */

export type MembershipTier = "basic" | "premier";

export interface FeeBracket {
  membership_tier: MembershipTier | string;
  min_bid: number;
  max_bid: number | null;
  fee_flat: number;
  fee_pct: number;
}

export function calculateBuyerFee(bidAmount: number, tier: string, brackets: FeeBracket[]): number {
  const applicable = brackets.filter(
    (b) =>
      b.membership_tier === tier &&
      bidAmount >= b.min_bid &&
      (b.max_bid === null || bidAmount < b.max_bid)
  );

  if (applicable.length === 0) {
    throw new Error(`No fee bracket found for tier=${tier}, bid=${bidAmount}`);
  }

  const bracket = applicable[0];
  return Math.round((bracket.fee_flat + bidAmount * bracket.fee_pct) * 100) / 100;
}

/**
 * Rough gate + storage estimate. Real numbers vary by yard; this gives
 * bidders a directional number instead of the "surprise fee" pattern that
 * shows up repeatedly in buyer complaints.
 */
export function estimateGateAndStorage(
  daysUntilPickup: number,
  freeDays = 4,
  dailyStorageFee = 30.0
): number {
  const overdueDays = Math.max(0, daysUntilPickup - freeDays);
  return Math.round(overdueDays * dailyStorageFee * 100) / 100;
}
