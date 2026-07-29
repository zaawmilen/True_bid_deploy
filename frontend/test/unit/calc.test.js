import { describe, it, expect } from 'vitest';
import {
  fmt,
  computeStackSegments,
  confidenceClass,
  riskLabel,
  riskDetailText,
  DEMO_BID_INCREMENTS,
  DEMO_BIDDERS,
  DEMO_RISK_THRESHOLD,
  nextBidIncrement,
  calcDemoFee,
  isRiskyTick,
  pickDemoBidder,
  buildAuthenticatedWsUrl,
  buildAuthHeader,
} from '../../calc.js';

describe('fmt', () => {
  it('formats whole dollars with a leading $', () => {
    expect(fmt(500)).toBe('$500');
  });

  it('adds thousands separators', () => {
    expect(fmt(12345)).toBe('$12,345');
  });

  it('rounds to zero decimal places', () => {
    expect(fmt(12345.6)).toBe('$12,346');
  });

  it('handles zero', () => {
    expect(fmt(0)).toBe('$0');
  });
});

describe('computeStackSegments', () => {
  it('splits proportionally across bid/fee/freight/repair', () => {
    const { bidPct, feePct, freightPct, repairPct } = computeStackSegments({
      bid: 100, fee: 0, freight: 0, repair: 0,
    });
    expect(bidPct).toBe(100);
    expect(feePct).toBe(0);
    expect(freightPct).toBe(0);
    expect(repairPct).toBe(0);
  });

  it('percentages sum to 100 for a realistic mixed breakdown', () => {
    const segs = computeStackSegments({ bid: 5200, fee: 412, freight: 420, repair: 2400 });
    const sum = segs.bidPct + segs.feePct + segs.freightPct + segs.repairPct;
    expect(sum).toBeCloseTo(100, 6);
  });

  it('splits evenly when all four components are equal', () => {
    const segs = computeStackSegments({ bid: 100, fee: 100, freight: 100, repair: 100 });
    expect(segs.bidPct).toBeCloseTo(25, 6);
    expect(segs.feePct).toBeCloseTo(25, 6);
    expect(segs.freightPct).toBeCloseTo(25, 6);
    expect(segs.repairPct).toBeCloseTo(25, 6);
  });

  // Regression test for the NaN-width bug found while extracting this
  // function: the original inline version divided by `total` with no
  // guard, so an all-zero breakdown produced `NaN%` as a CSS width.
  it('returns all-zero segments instead of NaN when every component is zero', () => {
    const segs = computeStackSegments({ bid: 0, fee: 0, freight: 0, repair: 0 });
    expect(segs).toEqual({ bidPct: 0, feePct: 0, freightPct: 0, repairPct: 0 });
    Object.values(segs).forEach((v) => expect(Number.isNaN(v)).toBe(false));
  });
});

describe('confidenceClass', () => {
  it('maps high confidence', () => {
    expect(confidenceClass('high')).toBe('conf-high');
  });

  it('maps medium confidence', () => {
    expect(confidenceClass('medium')).toBe('conf-medium');
  });

  it('falls back to conf-none for anything else, including undefined', () => {
    expect(confidenceClass('none')).toBe('conf-none');
    expect(confidenceClass(undefined)).toBe('conf-none');
    expect(confidenceClass('garbage')).toBe('conf-none');
  });
});

describe('riskLabel', () => {
  it('capitalizes and appends "risk"', () => {
    expect(riskLabel('medium')).toBe('Medium risk');
    expect(riskLabel('high')).toBe('High risk');
  });

  it('defaults to "Low risk" when level is missing', () => {
    expect(riskLabel(undefined)).toBe('Low risk');
    expect(riskLabel(null)).toBe('Low risk');
    expect(riskLabel('')).toBe('Low risk');
  });
});

describe('riskDetailText', () => {
  it('joins flag types with a middle dot, underscores replaced by spaces', () => {
    const text = riskDetailText([{ type: 'bid_velocity' }, { type: 'cross_lot' }]);
    expect(text).toBe('bid velocity · cross lot');
  });

  it('falls back to the default message when there are no flags', () => {
    expect(riskDetailText([])).toBe('No unusual bidding patterns detected on this lot.');
    expect(riskDetailText(undefined)).toBe('No unusual bidding patterns detected on this lot.');
  });
});

describe('demo-mode fallback formulas', () => {
  it('nextBidIncrement picks from the fixed increment set based on rand()', () => {
    expect(nextBidIncrement(() => 0)).toBe(DEMO_BID_INCREMENTS[0]); // 25
    expect(nextBidIncrement(() => 0.999999)).toBe(
      DEMO_BID_INCREMENTS[DEMO_BID_INCREMENTS.length - 1]
    ); // 150
  });

  it('calcDemoFee applies the 6% + $100 formula, rounded', () => {
    expect(calcDemoFee(500)).toBe(130); // 100 + 30 = 130
    expect(calcDemoFee(1000)).toBe(160); // 100 + 60 = 160
    expect(calcDemoFee(333)).toBe(120); // 100 + 19.98 -> rounds to 120
  });

  it('isRiskyTick is true strictly below the threshold, false at/above it', () => {
    expect(isRiskyTick(() => 0)).toBe(true);
    expect(isRiskyTick(() => DEMO_RISK_THRESHOLD - 0.001)).toBe(true);
    expect(isRiskyTick(() => DEMO_RISK_THRESHOLD)).toBe(false); // boundary: strict <
    expect(isRiskyTick(() => 0.5)).toBe(false);
  });

  it('pickDemoBidder selects from the fixed bidder list based on rand()', () => {
    expect(pickDemoBidder(() => 0)).toBe(DEMO_BIDDERS[0]);
    expect(pickDemoBidder(() => 0.999999)).toBe(DEMO_BIDDERS[DEMO_BIDDERS.length - 1]);
  });
});

describe('auth wiring helpers', () => {
  it('buildAuthenticatedWsUrl appends ?token= when the URL has no query string', () => {
    expect(buildAuthenticatedWsUrl('ws://localhost:8000/ws/LOT-1001', 'abc.def')).toBe(
      'ws://localhost:8000/ws/LOT-1001?token=abc.def'
    );
  });

  it('buildAuthenticatedWsUrl appends &token= when the URL already has a query string', () => {
    expect(buildAuthenticatedWsUrl('ws://localhost:8000/ws/LOT-1001?debug=1', 'abc.def')).toBe(
      'ws://localhost:8000/ws/LOT-1001?debug=1&token=abc.def'
    );
  });

  it('buildAuthenticatedWsUrl URL-encodes the token', () => {
    // JWTs use base64url so this shouldn't normally trigger, but the dots
    // are worth confirming pass through a URL correctly either way.
    const url = buildAuthenticatedWsUrl('ws://localhost:8000/ws/LOT-1001', 'a.b.c');
    expect(url).toContain('token=a.b.c');
  });

  it('buildAuthHeader produces a standard Bearer header', () => {
    expect(buildAuthHeader('abc.def.ghi')).toEqual({ Authorization: 'Bearer abc.def.ghi' });
  });
});
