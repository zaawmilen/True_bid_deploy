import { describe, expect, it } from "vitest";
import { nextBidEvent, randomBetween, randomChoice } from "../../src/index.js";

describe("randomChoice", () => {
  it("always returns an element that is a member of the input array", () => {
    const arr = ["a", "b", "c"];
    for (let i = 0; i < 50; i++) {
      expect(arr).toContain(randomChoice(arr));
    }
  });
});

describe("randomBetween", () => {
  it("always returns a value within the [min, max) range", () => {
    for (let i = 0; i < 50; i++) {
      const value = randomBetween(500, 3000);
      expect(value).toBeGreaterThanOrEqual(500);
      expect(value).toBeLessThan(3000);
    }
  });
});

describe("nextBidEvent", () => {
  it("always produces a bid amount strictly greater than the previous bid", () => {
    for (let i = 0; i < 50; i++) {
      const event = nextBidEvent(500);
      expect(event.amount).toBeGreaterThan(500);
    }
  });

  it("only bumps the price by one of the defined increments", () => {
    const allowedBumps = new Set([25, 50, 75, 100, 150]);
    for (let i = 0; i < 50; i++) {
      const event = nextBidEvent(1000);
      expect(allowedBumps.has(event.amount - 1000)).toBe(true);
    }
  });

  it("always targets the simulated demo lot", () => {
    const event = nextBidEvent(500);
    expect(event.lot_id).toBe("LOT-1001");
  });

  it("picks a bidder from the fixed roster of 8 simulated bidders", () => {
    const validBidders = new Set(Array.from({ length: 8 }, (_, i) => `bidder-${i + 1}`));
    for (let i = 0; i < 50; i++) {
      const event = nextBidEvent(500);
      expect(validBidders.has(event.bidder_id)).toBe(true);
    }
  });

  it("stamps each event with a numeric placed_at timestamp", () => {
    const event = nextBidEvent(500);
    expect(typeof event.placed_at).toBe("number");
    expect(event.placed_at).toBeGreaterThan(0);
  });
});
