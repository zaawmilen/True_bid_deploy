/**
 * generate-seed.ts
 * ----------------
 * Generates a synthetic `historical_sales` dataset that mirrors realistic
 * salvage-auction pricing patterns, rather than pure random noise, so the
 * valuation-service's weighted-KNN comps produce sensible-looking numbers
 * in the demo.
 *
 * Pricing model (deliberately simple, deliberately explicit):
 *
 *   price = base_value(make, model)
 *         * age_retention(age_years, make)     // compounding annual depreciation
 *         * mileage_penalty(mileage, age)      // penalize above-expected mileage
 *         * damage_multiplier(severity)        // low / medium / high
 *         * title_multiplier(title_type)       // clean / salvage / rebuilt / non-repairable
 *         * regional_factor(region)
 *         * auction_noise                      // +/- randomness, real auctions aren't deterministic
 *
 * Run: npx tsx generate-seed.ts > 002_historical_sales_seed.sql
 * (already run once; output is committed so `docker compose up` seeds
 * automatically without needing Node/tsx at container-init time)
 */

// ---- seeded RNG so output is reproducible across runs ----
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260713);

function randBetween(min: number, max: number): number {
  return min + rand() * (max - min);
}
function randInt(min: number, max: number): number {
  return Math.floor(randBetween(min, max + 1));
}
function choice<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}
function normal(mean: number, std: number): number {
  // Box-Muller
  const u1 = rand() || 1e-9;
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

interface VehicleModel {
  make: string;
  model: string;
  baseValue: number;
  luxury: boolean;
}

// ---- vehicle catalog: base MSRP-era value used as the depreciation anchor ----
// Mix mirrors what actually shows up in salvage auctions: high-volume
// sedans/SUVs/trucks, a couple of luxury makes for range, and the
// Mustang so the demo lot (LOT-1001) has real comps.
const CATALOG: VehicleModel[] = [
  { make: "Ford", model: "Mustang", baseValue: 32000, luxury: false },
  { make: "Ford", model: "F-150", baseValue: 38000, luxury: false },
  { make: "Toyota", model: "Camry", baseValue: 27000, luxury: false },
  { make: "Toyota", model: "RAV4", baseValue: 29000, luxury: false },
  { make: "Honda", model: "Civic", baseValue: 24000, luxury: false },
  { make: "Honda", model: "CR-V", baseValue: 29500, luxury: false },
  { make: "Chevrolet", model: "Silverado", baseValue: 40000, luxury: false },
  { make: "Nissan", model: "Altima", baseValue: 26000, luxury: false },
  { make: "BMW", model: "3 Series", baseValue: 45000, luxury: true },
  { make: "Mercedes-Benz", model: "C-Class", baseValue: 47000, luxury: true },
];

type Region = "Southeast" | "Southwest" | "Midwest" | "Northeast" | "West Coast";

const REGIONS: Region[] = ["Southeast", "Southwest", "Midwest", "Northeast", "West Coast"];
const REGION_FACTOR: Record<Region, number> = {
  Southeast: 0.98,
  Southwest: 1.0,
  Midwest: 0.95,
  Northeast: 1.04,
  "West Coast": 1.08, // higher demand/resale market
};

type DamageSeverity = "low" | "medium" | "high";
const DAMAGE_SEVERITIES: DamageSeverity[] = ["low", "medium", "high"];
const DAMAGE_MULTIPLIER: Record<DamageSeverity, number> = { low: 0.72, medium: 0.5, high: 0.3 };

type TitleType = "salvage" | "rebuilt" | "non-repairable" | "clean";
// clean titles occasionally show up (fleet/lease lots without damage
// history) but are a minority in a salvage-auction comp set.
const TITLE_WEIGHTS: [TitleType, number][] = [
  ["salvage", 0.55],
  ["rebuilt", 0.3],
  ["non-repairable", 0.1],
  ["clean", 0.05],
];
const TITLE_MULTIPLIER: Record<TitleType, number> = {
  clean: 1.0,
  salvage: 0.45,
  rebuilt: 0.65,
  "non-repairable": 0.15,
};

function weightedChoice<T extends string>(weighted: [T, number][]): T {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let r = rand() * total;
  for (const [value, w] of weighted) {
    r -= w;
    if (r <= 0) return value;
  }
  return weighted[weighted.length - 1][0];
}

function ageRetention(ageYears: number, luxury: boolean): number {
  // Luxury vehicles depreciate faster off the lot but the curve flattens
  // similarly after ~5 years; approximate with a slightly lower annual
  // retention rate for luxury makes.
  const annualRetention = luxury ? 0.8 : 0.84;
  return Math.pow(annualRetention, ageYears);
}

function expectedMileage(ageYears: number): number {
  return ageYears * 12000; // ~12k miles/year is the standard assumption
}

function mileagePenalty(mileage: number, ageYears: number): number {
  const expected = expectedMileage(Math.max(ageYears, 0.5));
  const delta = mileage - expected;
  // Above-expected mileage costs more per mile than being under helps -
  // buyers punish high mileage more than they reward low mileage.
  if (delta > 0) return Math.max(0.6, 1 - delta / 250000);
  return Math.min(1.08, 1 - delta / 400000);
}

interface SaleRow {
  make: string;
  model: string;
  year: number;
  mileage: number;
  damage_severity: DamageSeverity;
  title_type: TitleType;
  region: Region;
  sale_price: number;
  sold_at: string;
}

const CURRENT_YEAR = 2026;
const ROWS_PER_MODEL = 80; // ~800 total rows across 10 models

const rows: SaleRow[] = [];

for (const vehicle of CATALOG) {
  for (let i = 0; i < ROWS_PER_MODEL; i++) {
    const year = randInt(2012, 2024);
    const ageYears = CURRENT_YEAR - year;
    const mileage = Math.max(500, Math.round(expectedMileage(ageYears) + normal(0, 15000)));

    const damageSeverity = choice(DAMAGE_SEVERITIES);
    const titleType = weightedChoice(TITLE_WEIGHTS);
    const region = choice(REGIONS);

    const damageMult = titleType === "clean" ? 1.0 : DAMAGE_MULTIPLIER[damageSeverity];
    const titleMult = TITLE_MULTIPLIER[titleType];
    const regionFactor = REGION_FACTOR[region];
    const auctionNoise = randBetween(0.85, 1.15);

    let price =
      vehicle.baseValue *
      ageRetention(ageYears, vehicle.luxury) *
      mileagePenalty(mileage, ageYears) *
      damageMult *
      titleMult *
      regionFactor *
      auctionNoise;

    price = Math.max(400, Math.round(price / 25) * 25); // floor + round to nearest $25

    // Spread sale dates over the last ~24 months, weighted toward more
    // recent months (auction volume and comp relevance both skew recent).
    const daysAgo = Math.round(Math.pow(rand(), 1.6) * 730);
    const soldAt = new Date(Date.UTC(2026, 6, 13));
    soldAt.setUTCDate(soldAt.getUTCDate() - daysAgo);

    rows.push({
      make: vehicle.make,
      model: vehicle.model,
      year,
      mileage,
      damage_severity: titleType === "clean" ? "low" : damageSeverity,
      title_type: titleType,
      region,
      sale_price: price,
      sold_at: soldAt.toISOString().slice(0, 10),
    });
  }
}

// ---- emit SQL ----
const BATCH_SIZE = 100;
const lines: string[] = [
  "-- Auto-generated synthetic historical sales data.",
  "-- Regenerate with: npx tsx generate-seed.ts > 002_historical_sales_seed.sql",
  `-- ${rows.length} rows across ${CATALOG.length} make/models, seeded RNG (deterministic).`,
  "",
];

for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  const values = batch
    .map(
      (r) =>
        `('${r.make}', '${r.model}', ${r.year}, ${r.mileage}, '${r.damage_severity}', '${r.title_type}', '${r.region}', ${r.sale_price}, '${r.sold_at}')`
    )
    .join(",\n  ");

  lines.push(
    "INSERT INTO historical_sales (make, model, year, mileage, damage_severity, title_type, region, sale_price, sold_at) VALUES",
    `  ${values};`,
    ""
  );
}

process.stdout.write(lines.join("\n"));
