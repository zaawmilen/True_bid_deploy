// calc.js
// Pure, framework-free functions extracted from index.html's inline
// <script>, so the arithmetic that used to only run inside a browser
// tab can be unit-tested directly. No behavior change intended - these
// are the same formulas, just named, exported, and given test coverage.
// Loaded as a native ES module, so no build step / bundler needed.

export function fmt(n) {
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Cost-stack bar segment widths, as 0-100 percentages of the total.
// NOTE: the original inline version divided by `total` with no guard, so
// an all-zero cost breakdown (bid/fee/freight/repair all 0) produced
// `NaN%` as a CSS width - invalid, and silently collapses the bar to
// nothing. Guarded here so a degenerate zero-cost update still renders
// a sane (all-zero) bar instead of NaN.
export function computeStackSegments({ bid, fee, freight, repair }) {
  const total = bid + fee + freight + repair;
  if (!(total > 0)) {
    return { bidPct: 0, feePct: 0, freightPct: 0, repairPct: 0 };
  }
  return {
    bidPct: (bid / total) * 100,
    feePct: (fee / total) * 100,
    freightPct: (freight / total) * 100,
    repairPct: (repair / total) * 100,
  };
}

export function confidenceClass(confidence) {
  if (confidence === 'high') return 'conf-high';
  if (confidence === 'medium') return 'conf-medium';
  return 'conf-none';
}

export function riskLabel(level) {
  const lvl = level || 'low';
  return lvl.charAt(0).toUpperCase() + lvl.slice(1) + ' risk';
}

export function riskDetailText(flags) {
  if (flags && flags.length) {
    return flags.map((f) => f.type.replace(/_/g, ' ')).join(' · ');
  }
  return 'No unusual bidding patterns detected on this lot.';
}

// ---- local-simulation fallback (used when no backend is reachable) ----

export const DEMO_BID_INCREMENTS = [25, 50, 75, 100, 150];
export const DEMO_FREIGHT = 420;
export const DEMO_REPAIR_LOW = 1800;
export const DEMO_REPAIR_HIGH = 4500;
export const DEMO_RISK_THRESHOLD = 0.12;
export const DEMO_BIDDERS = ['bidder-3', 'bidder-7', 'bidder-1', 'bidder-5'];

// rand: injectable RNG, defaults to Math.random. Tests pass a fixed
// sequence instead of depending on real randomness.
export function nextBidIncrement(rand = Math.random) {
  return DEMO_BID_INCREMENTS[Math.floor(rand() * DEMO_BID_INCREMENTS.length)];
}

export function calcDemoFee(bid) {
  return Math.round(100 + bid * 0.06);
}

export function isRiskyTick(rand = Math.random) {
  return rand() < DEMO_RISK_THRESHOLD;
}

export function pickDemoBidder(rand = Math.random) {
  return DEMO_BIDDERS[Math.floor(rand() * DEMO_BIDDERS.length)];
}

// ---- auth wiring helpers (pure - the actual fetch/WebSocket calls that
// use these live in index.html, kept out of this module on purpose so
// calc.js stays free of side effects and stays trivially unit-testable) ----

// The bidder identity the demo UI logs in as automatically on load, so
// the ticker works the same way it always did (no login form to fill
// out) while still exercising the real auth path end to end.
export const DEMO_LOGIN_BIDDER_ID = 'demo-viewer';

/** Appends ?token=... (or &token=... if the URL already has a query string). */
export function buildAuthenticatedWsUrl(baseUrl, token) {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
}

export function buildAuthHeader(token) {
  return { Authorization: `Bearer ${token}` };
}
