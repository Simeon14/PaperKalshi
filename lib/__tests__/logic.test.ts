import { describe, it, expect } from "vitest";
import { takerFeeCents } from "@/lib/fees";
import { fillPriceC, computeFill } from "@/lib/broker";
import { yesMidC, noMidC, type LiveMarket } from "@/lib/kalshi/market";

// Same fixture as tests/test_paper.py: yes 84/86, no 14/16, last 85.
function mkt(over: Partial<LiveMarket> = {}): LiveMarket {
  return {
    ticker: "KXMLBGAME-T-WSH",
    event_ticker: "KXMLBGAME-T",
    matchup: "Washington vs Baltimore",
    team: "Washington",
    yes_bid_c: 84,
    yes_ask_c: 86,
    no_bid_c: 14,
    no_ask_c: 16,
    last_c: 85,
    volume: 1000,
    status: "active",
    result: "",
    close_time: "",
    ...over,
  };
}

describe("taker fee (port of fees.py)", () => {
  it("1 contract @ 50c rounds up to 2c", () => expect(takerFeeCents(1, 50)).toBe(2));
  it("is zero at the certain prices", () => {
    expect(takerFeeCents(10, 0)).toBe(0);
    expect(takerFeeCents(10, 100)).toBe(0);
  });
  it("is positive for a normal order", () => expect(takerFeeCents(10, 86)).toBeGreaterThan(0));
});

describe("mids", () => {
  it("yes mid is the midpoint of bid/ask", () => expect(yesMidC(mkt())).toBe(85));
  it("no mid", () => expect(noMidC(mkt())).toBe(15));
});

describe("fill pricing (port of PaperBroker)", () => {
  it("realistic buy lifts the ask, sell hits the bid", () => {
    expect(fillPriceC(mkt(), "yes", "buy", true)).toBe(86);
    expect(fillPriceC(mkt(), "yes", "sell", true)).toBe(84);
  });
  it("perfect liquidity fills both sides at the mid", () => {
    expect(fillPriceC(mkt(), "yes", "buy", false)).toBe(85);
    expect(fillPriceC(mkt(), "yes", "sell", false)).toBe(85);
  });
  it("realistic charges a fee; perfect liquidity charges none", () => {
    const r = computeFill(mkt(), "yes", "buy", 10, true);
    expect(r).toEqual({ priceC: 86, feeC: takerFeeCents(10, 86) });
    expect(r!.feeC).toBeGreaterThan(0);
    expect(computeFill(mkt(), "yes", "buy", 10, false)).toEqual({ priceC: 85, feeC: 0 });
  });
});
