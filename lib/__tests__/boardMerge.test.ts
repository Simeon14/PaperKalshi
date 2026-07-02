import { describe, it, expect } from "vitest";
import type { Outcome } from "@/lib/kalshi/market";
import {
  mergeBoards,
  patchOutcomes,
  sortCards,
  type BoardCard,
  type BoardOutcome,
} from "@/lib/boardMerge";

function mkOutcome(ticker: string, over: Partial<BoardOutcome> = {}): BoardOutcome {
  return {
    ticker,
    team: "Team " + ticker,
    matchup: "A vs B",
    close_time: "2026-07-08T00:00:00Z",
    yes_bid_c: 40,
    yes_ask_c: 42,
    no_bid_c: 58,
    no_ask_c: 60,
    last_c: 41,
    yes_mid_c: 41,
    no_mid_c: 59,
    tradeable: true,
    ...over,
  };
}

function mkCard(id: string, outcomes: BoardOutcome[], over: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    title: "Card " + id,
    vol: 100,
    market_count: outcomes.length,
    close_time: "2026-07-08T00:00:00Z",
    outcomes,
    ...over,
  };
}

const quote = (ticker: string, over: Partial<Outcome> = {}): Record<string, Outcome> => ({
  [ticker]: mkOutcome(ticker, over),
});

describe("patchOutcomes", () => {
  it("returns the same array when no quoted value changed", () => {
    const cards = [mkCard("A", [mkOutcome("T1")])];
    expect(patchOutcomes(cards, quote("T1"), 1000)).toBe(cards);
  });
  it("clones only the touched card and stamps _at", () => {
    const a = mkCard("A", [mkOutcome("T1")]);
    const b = mkCard("B", [mkOutcome("T2")]);
    const next = patchOutcomes([a, b], quote("T1", { yes_mid_c: 55 }), 1000);
    expect(next).not.toBe([a, b] as unknown);
    expect(next[0]).not.toBe(a);
    expect(next[0].outcomes[0].yes_mid_c).toBe(55);
    expect(next[0].outcomes[0]._at).toBe(1000);
    expect(next[1]).toBe(b); // untouched card keeps its identity
  });
  it("preserves the group label through a patch", () => {
    const cards = [mkCard("A", [mkOutcome("T1", { group: "Moneyline" })])];
    const next = patchOutcomes(cards, quote("T1", { yes_mid_c: 77 }), 5);
    expect(next[0].outcomes[0].group).toBe("Moneyline");
  });
});

describe("mergeBoards", () => {
  it("adopts fresh card data while keeping board position", () => {
    const prev = [mkCard("A", [mkOutcome("T1")], { vol: 10 }), mkCard("B", [mkOutcome("T2")], { vol: 99 })];
    const api = [mkCard("B", [mkOutcome("T2")], { vol: 500 }), mkCard("A", [mkOutcome("T1")], { vol: 20 })];
    const next = mergeBoards(prev, api, 0, "vol");
    expect(next.map((c) => c.id)).toEqual(["A", "B"]); // frozen order, not re-sorted
    expect(next[0].vol).toBe(20); // fresh volume adopted
    expect(next[1].vol).toBe(500);
  });
  it("drops closed cards and appends new ones sorted among themselves", () => {
    const prev = [mkCard("A", [mkOutcome("T1")])];
    const api = [
      mkCard("NEW2", [mkOutcome("T3")], { vol: 5 }),
      mkCard("NEW1", [mkOutcome("T2")], { vol: 50 }),
    ];
    const next = mergeBoards(prev, api, 0, "vol");
    expect(next.map((c) => c.id)).toEqual(["NEW1", "NEW2"]);
  });
  it("keeps a recently patched outcome over stale board data", () => {
    const patched = mkOutcome("T1", { yes_mid_c: 70, _at: 2000 });
    const prev = [mkCard("A", [patched])];
    const api = [mkCard("A", [mkOutcome("T1", { yes_mid_c: 30 })])];
    const next = mergeBoards(prev, api, 1500, "vol"); // board assembled BEFORE the patch
    expect(next[0].outcomes[0]).toBe(patched);
  });
  it("takes fresh outcome data when the patch predates the board", () => {
    const patched = mkOutcome("T1", { yes_mid_c: 70, _at: 1000 });
    const prev = [mkCard("A", [patched])];
    const api = [mkCard("A", [mkOutcome("T1", { yes_mid_c: 30 })])];
    const next = mergeBoards(prev, api, 1500, "vol"); // board assembled AFTER the patch
    expect(next[0].outcomes[0].yes_mid_c).toBe(30);
  });
  it("surfaces newly listed outcomes on a surviving card", () => {
    const prev = [mkCard("A", [mkOutcome("T1")])];
    const api = [mkCard("A", [mkOutcome("T1"), mkOutcome("T2")], { market_count: 2 })];
    const next = mergeBoards(prev, api, 0, "vol");
    expect(next[0].outcomes.map((o) => o.ticker)).toEqual(["T1", "T2"]);
    expect(next[0].market_count).toBe(2);
  });
  it("keeps full card identity when nothing changed", () => {
    const card = mkCard("A", [mkOutcome("T1")]);
    const api = [mkCard("A", [mkOutcome("T1")])];
    const next = mergeBoards([card], api, 0, "vol");
    expect(next[0]).toBe(card);
  });
});

describe("sortCards", () => {
  it("sorts by volume descending with id tiebreak", () => {
    const cards = [
      mkCard("B", [mkOutcome("T1")], { vol: 10 }),
      mkCard("A", [mkOutcome("T2")], { vol: 10 }),
      mkCard("C", [mkOutcome("T3")], { vol: 90 }),
    ];
    expect(sortCards(cards, "vol").map((c) => c.id)).toEqual(["C", "A", "B"]);
  });
});
