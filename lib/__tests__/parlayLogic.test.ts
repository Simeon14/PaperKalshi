import { describe, it, expect } from "vitest";
import { classifyLeg } from "@/lib/parlay/classify";
import { quoteParlay, QuoteError } from "@/lib/parlay/quote";
import { reduceParlay, legImplies, contradicts } from "@/lib/parlay/logic";
import type { CorrelationEntry, CorrelationTable } from "@/lib/parlay/types";

// STL @ ATL, the audit game. All legs share this game so the logic layer engages.
const G = "26JUL021915STLATL";
const leg = (ticker: string, side: "yes" | "no" = "yes") => classifyLeg(ticker, side);
const OLSON = `ATLMOLSON21`;

function tableOf(entries: CorrelationEntry[]): CorrelationTable {
  return { version: 1, sport: "mlb", updated: "2026-07-02", entries };
}
function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof QuoteError ? e.code : "not-a-quote-error";
  }
  return "no-throw";
}

// Ladders/bands reduce to a single family (n=1), so the price is the exact interval probability
// with no table dependence.
const EMPTY = tableOf([]);

describe("Fix 1+2: spread ladder same team collapses to the tightest leg exactly", () => {
  it("2-leg STL -1.5 + -2.5 = P(win by 3+) exactly (the tightest leg's marginal)", () => {
    const r = quoteParlay(
      [leg(`KXMLBSPREAD-${G}-STL2`), leg(`KXMLBSPREAD-${G}-STL3`)],
      [0.3, 0.2],
      { table: EMPTY },
    );
    expect(r.fair_q).toBe(0.2); // NOT 0.3*0.2 = 0.06
    expect(r.price_c).toBe(20);
  });
  it("5-leg ladder collapses to the deepest line", () => {
    const r = quoteParlay(
      [`STL2`, `STL3`, `STL4`, `STL5`, `STL6`].map((s) => leg(`KXMLBSPREAD-${G}-${s}`)),
      [0.3, 0.2, 0.12, 0.07, 0.04],
      { table: EMPTY },
    );
    expect(r.fair_q).toBe(0.04);
    expect(r.price_c).toBe(4);
  });
});

describe("Fix 2: spread + ML same team collapses to the spread marginal", () => {
  it("ML STL + STL -1.5 = P(win by 2+)", () => {
    const r = quoteParlay(
      [leg(`KXMLBGAME-${G}-STL`), leg(`KXMLBSPREAD-${G}-STL2`)],
      [0.4, 0.2],
      { table: EMPTY },
    );
    expect(r.fair_q).toBe(0.2); // the spread leg, not 0.4*0.2
    expect(r.price_c).toBe(20);
  });
});

describe("Fix 2: total band and inverted (impossible) band", () => {
  it("over 8.5 AND not over 9.5 = P(o8.5) - P(o9.5)", () => {
    // total-9 = over 8.5 (mid 0.50); total-10 no = not over 9.5, marginal = 1 - P(o9.5) = 0.60.
    const r = quoteParlay(
      [leg(`KXMLBTOTAL-${G}-9`, "yes"), leg(`KXMLBTOTAL-${G}-10`, "no")],
      [0.5, 0.6],
      { table: EMPTY },
    );
    expect(r.fair_q).toBeCloseTo(0.1, 10); // 0.50 - (1 - 0.60) = 0.10
    expect(r.price_c).toBe(10);
  });
  it("over 9.5 AND not over 8.5 is impossible", () => {
    expect(
      code(() =>
        quoteParlay(
          [leg(`KXMLBTOTAL-${G}-10`, "yes"), leg(`KXMLBTOTAL-${G}-9`, "no")],
          [0.4, 0.5],
          { table: EMPTY },
        ),
      ),
    ).toBe("impossible_combo");
  });
});

describe("Fix 2: same-player deterministic implications", () => {
  it("HR 1+ AND TB 4+ = P(HR) (a HR is 4 total bases)", () => {
    const r = quoteParlay(
      [leg(`KXMLBHR-${G}-${OLSON}-1`), leg(`KXMLBTB-${G}-${OLSON}-4`)],
      [0.2, 0.35],
      { table: EMPTY },
    );
    expect(r.fair_q).toBe(0.2);
  });
  it("HR 1+ AND TB 2+ (weaker, still implied) = P(HR)", () => {
    const r = quoteParlay(
      [leg(`KXMLBHR-${G}-${OLSON}-1`), leg(`KXMLBTB-${G}-${OLSON}-2`)],
      [0.2, 0.5],
      { table: EMPTY },
    );
    expect(r.fair_q).toBe(0.2);
  });
  it("HR 1+ AND Hits 2+ (NOT implied) prices through the bucket", () => {
    // Uses the real same_player p_hr/p_hits prior; must be strictly between the product and
    // the min (not collapsed).
    const r = quoteParlay([leg(`KXMLBHR-${G}-${OLSON}-1`), leg(`KXMLBHIT-${G}-${OLSON}-2`)], [0.2, 0.3]);
    expect(r.fair_q).toBeGreaterThan(0.2 * 0.3); // above independence
    expect(r.fair_q).toBeLessThan(0.2 - 0.01); // not collapsed to P(HR)
  });
  it("legImplies encodes the invariants and contrapositives", () => {
    const hr1 = leg(`KXMLBHR-${G}-${OLSON}-1`);
    expect(legImplies(hr1, leg(`KXMLBTB-${G}-${OLSON}-4`))).toBe(true); // 4 TB
    expect(legImplies(hr1, leg(`KXMLBTB-${G}-${OLSON}-5`))).toBe(false); // not 5 TB
    expect(legImplies(hr1, leg(`KXMLBHRR-${G}-${OLSON}-3`))).toBe(true); // 3 H+R+RBI
    // no hits => no HR (contrapositive)
    expect(
      legImplies(leg(`KXMLBHIT-${G}-${OLSON}-1`, "no"), leg(`KXMLBHR-${G}-${OLSON}-1`, "no")),
    ).toBe(true);
  });
});

describe("Plan 06 Fix A: cross-stat contradictions throw, they do not price", () => {
  const hrYes = `KXMLBHR-${G}-${OLSON}-1`;
  it("HR 1+ yes + Hit 1+ no is impossible (a HR is a hit)", () => {
    expect(code(() => quoteParlay([leg(hrYes), leg(`KXMLBHIT-${G}-${OLSON}-1`, "no")], [0.2, 0.1]))).toBe(
      "impossible_combo",
    );
  });
  it("HR 1+ yes + TB 4+ no is impossible (a HR is 4 bases)", () => {
    expect(code(() => quoteParlay([leg(hrYes), leg(`KXMLBTB-${G}-${OLSON}-4`, "no")], [0.2, 0.65]))).toBe(
      "impossible_combo",
    );
  });
  it("TB 2+ yes + Hit 1+ no is impossible (2 bases needs a hit)", () => {
    expect(
      code(() => quoteParlay([leg(`KXMLBTB-${G}-${OLSON}-2`), leg(`KXMLBHIT-${G}-${OLSON}-1`, "no")], [0.4, 0.2])),
    ).toBe("impossible_combo");
  });
  it("Hit 2+ yes + TB 2+ no is impossible (2 hits => 2 bases)", () => {
    expect(
      code(() => quoteParlay([leg(`KXMLBHIT-${G}-${OLSON}-2`), leg(`KXMLBTB-${G}-${OLSON}-2`, "no")], [0.3, 0.4])),
    ).toBe("impossible_combo");
  });
  it("order does not matter (denier before implier)", () => {
    expect(code(() => quoteParlay([leg(`KXMLBHIT-${G}-${OLSON}-1`, "no"), leg(hrYes)], [0.1, 0.2]))).toBe(
      "impossible_combo",
    );
  });
  it("negative control: Hit 1+ yes + HR 1+ no PRICES (a hit without a homer is normal)", () => {
    const r = quoteParlay([leg(`KXMLBHIT-${G}-${OLSON}-1`), leg(`KXMLBHR-${G}-${OLSON}-1`, "no")], [0.5, 0.8]);
    expect(r.price_c).toBeGreaterThan(1);
  });
  it("contradicts() covers both orders and spares the negative control", () => {
    expect(contradicts(leg(hrYes), leg(`KXMLBHIT-${G}-${OLSON}-1`, "no"))).toBe(true);
    expect(contradicts(leg(`KXMLBHIT-${G}-${OLSON}-1`, "no"), leg(hrYes))).toBe(true);
    expect(contradicts(leg(`KXMLBTB-${G}-${OLSON}-2`), leg(`KXMLBHIT-${G}-${OLSON}-1`, "no"))).toBe(true);
    expect(contradicts(leg(`KXMLBHIT-${G}-${OLSON}-1`), leg(`KXMLBHR-${G}-${OLSON}-1`, "no"))).toBe(false);
    // different players never contradict
    expect(contradicts(leg(hrYes), leg(`KXMLBHIT-${G}-STLGARENA5-1`, "no"))).toBe(false);
  });
});

describe("Fix 2/4: exclusive outcomes are impossible", () => {
  it("both moneylines (both teams win) throws impossible_combo", () => {
    expect(
      code(() => quoteParlay([leg(`KXMLBGAME-${G}-STL`), leg(`KXMLBGAME-${G}-ATL`)], [0.45, 0.55], { table: EMPTY })),
    ).toBe("impossible_combo");
  });
  it("F3 team + F3 tie throws impossible_combo", () => {
    expect(
      code(() => quoteParlay([leg(`KXMLBF3-${G}-ATL`), leg(`KXMLBF3-${G}-TIE`)], [0.4, 0.25], { table: EMPTY })),
    ).toBe("impossible_combo");
  });
});

describe("Fix 4: sub-floor longshots are rejected, not sold at 1c", () => {
  it("throws longshot_floor when the fair value is below half a cent", () => {
    // Two ml legs in DIFFERENT games: independent, product 0.0004.
    const other = "26JUL021940NYYBOS";
    expect(
      code(() => quoteParlay([leg(`KXMLBGAME-${G}-STL`), leg(`KXMLBGAME-${other}-NYY`)], [0.02, 0.02])),
    ).toBe("longshot_floor");
  });
});

describe("reduceParlay unit checks", () => {
  it("collapses a same-team ladder to one unit and marks the pair +0.999", () => {
    const legs = [leg(`KXMLBSPREAD-${G}-STL2`), leg(`KXMLBSPREAD-${G}-STL3`)];
    const r = reduceParlay(legs, [0.3, 0.2]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reduced.length).toBe(1);
      expect(r.reduced[0].marginal).toBe(0.2);
      expect(r.logicalRho[0][1]).toBeCloseTo(0.999, 6); // comonotone ladder
    }
  });
  it("marks a lower/upper band pair -0.999", () => {
    const legs = [leg(`KXMLBTOTAL-${G}-9`, "yes"), leg(`KXMLBTOTAL-${G}-10`, "no")];
    const r = reduceParlay(legs, [0.5, 0.6]);
    expect(r.ok && r.logicalRho[0][1]).toBeCloseTo(-0.999, 6); // over vs under, opposite direction
  });
});
