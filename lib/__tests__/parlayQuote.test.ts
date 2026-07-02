import { describe, it, expect } from "vitest";
import { classifyLeg } from "@/lib/parlay/classify";
import { quoteParlay, QuoteError } from "@/lib/parlay/quote";
import type { ClassifiedLeg, CorrelationEntry, CorrelationTable } from "@/lib/parlay/types";

const GAME = "26JUL022210SDLAD";
const OTHER = "26JUL021905STLCHC";

function tableOf(entries: CorrelationEntry[]): CorrelationTable {
  return { version: 1, sport: "mlb", updated: "2026-07-02", entries };
}

const mlSD = classifyLeg(`KXMLBGAME-${GAME}-SD`, "yes");
const spreadSD = classifyLeg(`KXMLBSPREAD-${GAME}-SD2`, "yes");
const totalOver = classifyLeg(`KXMLBTOTAL-${GAME}-6`, "yes");

describe("quoteParlay validation", () => {
  it("rejects <2 and >10 legs", () => {
    expect(() => quoteParlay([mlSD], [0.6])).toThrow(QuoteError);
    const many: ClassifiedLeg[] = Array.from({ length: 11 }, (_, i) =>
      classifyLeg(`KXMLBGAME-26JUL02220${i % 10}AAABBB-AAA`, "yes"),
    );
    expect(() => quoteParlay(many, many.map(() => 0.5))).toThrow(/at most 10/);
  });
  it("rejects a duplicate market and the same market on both sides", () => {
    expect(() => quoteParlay([mlSD, mlSD], [0.6, 0.6])).toThrow(/duplicate/);
    const mlSDno = classifyLeg(`KXMLBGAME-${GAME}-SD`, "no");
    expect(() => quoteParlay([mlSD, mlSDno], [0.6, 0.4])).toThrow(/both sides/);
  });
  it("rejects out-of-range marginals and length mismatch", () => {
    expect(() => quoteParlay([mlSD, totalOver], [0.6])).toThrow(/mismatch/);
    expect(() => quoteParlay([mlSD, totalOver], [0.6, 1.2])).toThrow(/out of range/);
    expect(() => quoteParlay([mlSD, totalOver], [0.6, 0])).toThrow(/out of range/);
  });
});

describe("quoteParlay behaviour", () => {
  const table = tableOf([
    { a: "ml", b: "total", relation: "game", rho: 0.2, source: "structural" },
    { a: "spread", b: "total", relation: "game", rho: 0.25, source: "structural" },
    { a: "ml", b: "spread", relation: "same_team", rho: 0.7, source: "structural" },
  ]);

  it("prices two independent-ish legs near the product, with corr lift", () => {
    const r = quoteParlay([mlSD, totalOver], [0.6, 0.5], { table });
    expect(r.independent_q).toBeCloseTo(0.3, 9);
    expect(r.fair_q).toBeGreaterThan(0.3); // positive rho lifts the joint
    expect(r.price_c).toBe(Math.max(1, Math.min(99, Math.round(r.fair_q * 100))));
    expect(r.corr_version).toBe(1);
    expect(r.model_version).toBe("copula-1");
  });

  it("respects the Frechet upper bound for nested legs", () => {
    // ml + spread same team, rho ~1: the exact n=2 joint approaches but never exceeds the
    // spread marginal. (The clamp+warning path exists for MC noise on n>=3.)
    const nested = tableOf([
      { a: "ml", b: "spread", relation: "same_team", rho: 0.999, source: "structural" },
    ]);
    const r = quoteParlay([mlSD, spreadSD], [0.6, 0.3], { table: nested });
    expect(r.fair_q).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(r.fair_q).toBeGreaterThan(0.29); // nested -> joint ~ min marginal
  });

  it("warns on an unknown leg type and prices it independent", () => {
    const unknown = classifyLeg("KXNFLGAME-26SEP01KCBUF-KC", "yes");
    const r = quoteParlay([mlSD, unknown], [0.6, 0.5], { table });
    expect(r.warnings.some((w) => /unrecognized/.test(w))).toBe(true);
    expect(r.fair_q).toBeCloseTo(0.3, 6); // independent
  });

  it("warns when a leg pair has no correlation entry (priced independent)", () => {
    const r = quoteParlay([mlSD, totalOver], [0.6, 0.5], { table: tableOf([]) });
    expect(r.warnings.some((w) => /no correlation entry/.test(w))).toBe(true);
    expect(r.fair_q).toBeCloseTo(0.3, 9);
  });

  it("warns when 5+ legs share a game", () => {
    const legs = [
      classifyLeg(`KXMLBGAME-${GAME}-SD`, "yes"),
      classifyLeg(`KXMLBSPREAD-${GAME}-SD2`, "yes"),
      classifyLeg(`KXMLBTOTAL-${GAME}-6`, "yes"),
      classifyLeg(`KXMLBTEAMTOTAL-${GAME}-SD2`, "yes"),
      classifyLeg(`KXMLBF5-${GAME}-SD`, "yes"),
    ];
    const r = quoteParlay(legs, [0.6, 0.4, 0.5, 0.55, 0.5], { table, mcPairs: 20000 });
    expect(r.warnings.some((w) => /5\+ legs share a game/.test(w))).toBe(true);
  });

  it("independent across different games equals the product", () => {
    const other = classifyLeg(`KXMLBGAME-${OTHER}-STL`, "yes");
    const r = quoteParlay([mlSD, other], [0.6, 0.55], { table });
    expect(r.fair_q).toBeCloseTo(0.6 * 0.55, 9);
  });
});

describe("quoteParlay golden (stable across refactors)", () => {
  const table = tableOf([
    { a: "ml", b: "spread", relation: "same_team", rho: 0.7, source: "structural" },
    { a: "ml", b: "total", relation: "game", rho: 0.2, source: "structural" },
    { a: "spread", b: "total", relation: "game", rho: 0.25, source: "structural" },
  ]);
  const legs = [mlSD, spreadSD, totalOver];
  const marginals = [0.6, 0.35, 0.5];

  it("is deterministic and matches the pinned price", () => {
    const a = quoteParlay(legs, marginals, { table, mcPairs: 100000 });
    const b = quoteParlay(legs, marginals, { table, mcPairs: 100000 });
    expect(a.fair_q).toBe(b.fair_q); // exact determinism
    expect(a.seed).toBe(b.seed);
    // Pinned deterministic output. Changing this means the pricing math moved; re-pin only
    // intentionally. (ml+spread collapse to the spread marginal via the logic layer, then the
    // total prices against it through the exact n=2 copula.)
    expect(a.price_c).toBe(GOLDEN_PRICE);
    expect(a.fair_q).toBeCloseTo(GOLDEN_Q, 4);
  });
});

describe("quoteParlay is permutation-invariant", () => {
  const table = tableOf([
    { a: "ml", b: "spread", relation: "same_team", rho: 0.7, source: "structural" },
    { a: "ml", b: "total", relation: "game", rho: 0.2, source: "structural" },
    { a: "spread", b: "total", relation: "game", rho: 0.25, source: "structural" },
  ]);
  // Leg + its marginal travel together under each permutation.
  const items: Array<[ClassifiedLeg, number]> = [
    [mlSD, 0.6],
    [spreadSD, 0.35],
    [totalOver, 0.5],
  ];
  const perms = [
    [0, 1, 2],
    [2, 0, 1],
    [1, 2, 0],
    [2, 1, 0],
  ];

  it("gives EXACTLY the same fair_q for every leg order (n=3, MC path)", () => {
    const results = perms.map((p) => {
      const legs = p.map((i) => items[i][0]);
      const marg = p.map((i) => items[i][1]);
      return quoteParlay(legs, marg, { table, mcPairs: 50000 });
    });
    for (const r of results) {
      expect(r.fair_q).toBe(results[0].fair_q); // exact, not close
      expect(r.price_c).toBe(results[0].price_c);
      expect(r.seed).toBe(results[0].seed);
    }
  });

  it("returns rho in the caller's leg order (remapped from canonical)", () => {
    // Order A: [ml, spread, total]; Order B: [total, ml, spread].
    const a = quoteParlay([mlSD, spreadSD, totalOver], [0.6, 0.35, 0.5], { table, mcPairs: 20000 });
    const b = quoteParlay([totalOver, mlSD, spreadSD], [0.5, 0.6, 0.35], { table, mcPairs: 20000 });
    // ml-spread correlation sits at [0][1] in A and at [1][2] in B.
    expect(a.rho[0][1]).toBeCloseTo(b.rho[1][2], 12);
    // ml-total correlation: [0][2] in A, [1][0] in B.
    expect(a.rho[0][2]).toBeCloseTo(b.rho[1][0], 12);
    expect(a.rho[0][0]).toBeCloseTo(1, 12);
  });
});

// Pinned golden values (deterministic; ml+spread collapse to the spread marginal, then the
// exact n=2 copula prices the total against it).
const GOLDEN_PRICE = 21;
const GOLDEN_Q = 0.21228;
