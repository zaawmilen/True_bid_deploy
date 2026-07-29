-- TrueBid schema: minimal but real enough to run the demo end to end.

CREATE TABLE lots (
    lot_id              TEXT PRIMARY KEY,
    vin                 TEXT,
    make                TEXT,
    model               TEXT,
    year                INT,
    mileage             INT,
    damage_primary      TEXT,
    damage_secondary    TEXT,
    title_type          TEXT,           -- salvage / rebuilt / clean / non-repairable
    run_and_drive       BOOLEAN,
    yard_location       TEXT,           -- e.g. "Dallas, TX"
    yard_lat            NUMERIC,
    yard_lon            NUMERIC,
    photo_angles_captured TEXT[],       -- which angles were photographed at intake, e.g. {front,rear,side}
    listed_at           TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE bids (
    bid_id              BIGSERIAL PRIMARY KEY,
    lot_id              TEXT REFERENCES lots(lot_id),
    bidder_id           TEXT NOT NULL,
    amount              NUMERIC NOT NULL,
    placed_at           TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE historical_sales (
    sale_id             BIGSERIAL PRIMARY KEY,
    make                TEXT,
    model               TEXT,
    year                INT,
    mileage             INT,
    damage_severity     TEXT,           -- low / medium / high, derived from damage codes
    title_type          TEXT,
    region              TEXT,
    sale_price          NUMERIC,
    sold_at             TIMESTAMPTZ
);

CREATE TABLE fee_schedules (
    membership_tier     TEXT NOT NULL,  -- basic / premier
    min_bid             NUMERIC NOT NULL,
    max_bid             NUMERIC,
    fee_flat            NUMERIC DEFAULT 0,
    fee_pct             NUMERIC DEFAULT 0   -- as a fraction, e.g. 0.08
);

CREATE TABLE cost_estimates (
    estimate_id         BIGSERIAL PRIMARY KEY,
    lot_id              TEXT REFERENCES lots(lot_id),
    bid_amount          NUMERIC,
    buyer_fees          NUMERIC,
    freight_estimate    NUMERIC,
    repair_low          NUMERIC,
    repair_high         NUMERIC,
    repair_confidence   TEXT,          -- low / medium / high
    comp_valuation      NUMERIC,
    total_landed_cost   NUMERIC,
    computed_at         TIMESTAMPTZ DEFAULT now()
);

-- A tiny seed so the demo has something to compute against.
INSERT INTO fee_schedules (membership_tier, min_bid, max_bid, fee_flat, fee_pct) VALUES
    ('basic',   0,     2000,   100, 0.00),
    ('basic',   2000,  10000,  100, 0.08),
    ('basic',   10000, NULL,   100, 0.06),
    ('premier', 0,     2000,   50,  0.00),
    ('premier', 2000,  10000,  50,  0.06),
    ('premier', 10000, NULL,   50,  0.04);

INSERT INTO lots (lot_id, vin, make, model, year, mileage, damage_primary, damage_secondary,
                   title_type, run_and_drive, yard_location, yard_lat, yard_lon, photo_angles_captured) VALUES
    ('LOT-1001', '1FA6P8TH0J5123456', 'Ford', 'Mustang', 2021, 34211,
     'Front End', 'Undercarriage', 'salvage', true, 'Dallas, TX', 32.7767, -96.7970,
     ARRAY['front', 'rear', 'side', 'engine_bay']); -- undercarriage not captured at intake
