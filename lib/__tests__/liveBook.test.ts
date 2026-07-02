import { describe, it, expect } from "vitest";
import { hasLiveBook, midIsFictional, MAX_BOOK_SPREAD_C } from "@/lib/kalshi/market";

// The dead-book guard: a mid only means something on a two-sided book. Shared by the board's
// isBuyable filter, the client price pills, and the trade route's default-mode buy guard.

describe("hasLiveBook", () => {
  it("accepts a tight main-line book", () => {
    expect(hasLiveBook({ yes_bid_c: 48, yes_ask_c: 52 })).toBe(true);
  });
  it("accepts a penny longshot (bid 0 is a real quote)", () => {
    expect(hasLiveBook({ yes_bid_c: 0, yes_ask_c: 2 })).toBe(true);
  });
  it("accepts exactly the max spread", () => {
    expect(hasLiveBook({ yes_bid_c: 40, yes_ask_c: 40 + MAX_BOOK_SPREAD_C })).toBe(true);
  });
  it("rejects a dead pre-game book (bid 0 / ask 97, fantasy ~49c mid)", () => {
    expect(hasLiveBook({ yes_bid_c: 0, yes_ask_c: 97 })).toBe(false);
  });
  it("rejects a wide book just past the threshold", () => {
    expect(hasLiveBook({ yes_bid_c: 40, yes_ask_c: 40 + MAX_BOOK_SPREAD_C + 1 })).toBe(false);
  });
  it("rejects one-sided books (missing bid or ask)", () => {
    expect(hasLiveBook({ yes_bid_c: null, yes_ask_c: 50 })).toBe(false);
    expect(hasLiveBook({ yes_bid_c: 50, yes_ask_c: null })).toBe(false);
  });
});

describe("midIsFictional (the narrower exit/mark guard)", () => {
  it("flags a wide two-sided book (its averaged mid means nothing)", () => {
    expect(midIsFictional({ yes_bid_c: 0, yes_ask_c: 97 })).toBe(true);
  });
  it("does NOT flag a one-sided book (mid falls back to the single real quote)", () => {
    expect(midIsFictional({ yes_bid_c: 97, yes_ask_c: null })).toBe(false);
    expect(midIsFictional({ yes_bid_c: null, yes_ask_c: 3 })).toBe(false);
  });
  it("does NOT flag a tight book", () => {
    expect(midIsFictional({ yes_bid_c: 48, yes_ask_c: 52 })).toBe(false);
  });
});
