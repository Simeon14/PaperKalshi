import { describe, it, expect } from "vitest";
import { buildParlayQuote, normalizeLegs, type LegMarket } from "@/lib/parlayQuote";
import { assessParlay, type ParlayRow } from "@/lib/parlaySettle";
import { quoteParlay, priceFrozenSubset } from "@/lib/parlay/quote";
import { classifyLeg } from "@/lib/parlay/classify";
import type { LiveMarket } from "@/lib/kalshi/market";
import type { ParlaySnapshot, QuoteLeg, Side } from "@/lib/parlayTypes";

// Real-ish MLB tickers so classifyLeg parses a series + gameKey (anatomy doc format).
// ML + TOT is the measured-zero correlation bucket (ml/total game rho -0.0), so those pairs
// still price as the exact independence product; ML + TT (same team) carries rho +0.7249.
const ML = "KXMLBGAME-26JUL022210SDLAD-SD";
const TOT = "KXMLBTOTAL-26JUL022210SDLAD-3";
const TT = "KXMLBTEAMTOTAL-26JUL022210SDLAD-SD5";

function lm(over: Partial<LegMarket> & { ticker: string }): LegMarket {
  return {
    side: "yes",
    yesBidC: 48, // a real two-sided book (spread 4c) so the liquidity guard passes
    noBidC: 48,
    yesMidC: 50,
    noMidC: 50,
    yesAskC: 52,
    noAskC: 52,
    team: "Padres",
    matchup: "Padres vs Dodgers",
    tradeable: true,
    ...over,
  };
}

describe("normalizeLegs", () => {
  it("rejects fewer than 2 legs", () => {
    expect(normalizeLegs([{ ticker: ML, side: "yes" }])).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects both sides of the same market", () => {
    const r = normalizeLegs([
      { ticker: ML, side: "yes" },
      { ticker: ML, side: "no" },
    ]);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
  it("dedupes identical legs", () => {
    const r = normalizeLegs([
      { ticker: ML, side: "yes" },
      { ticker: ML, side: "yes" },
      { ticker: TOT, side: "yes" },
    ]);
    expect(r.ok && r.legs.length).toBe(2);
  });
  it("rejects more than 10 legs", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ticker: `KXMLBGAME-26JUL022210SDLAD-T${i}`,
      side: "yes" as const,
    }));
    expect(normalizeLegs(many)).toMatchObject({ ok: false });
  });
});

describe("buildParlayQuote", () => {
  it("multiplies marginals when the measured correlation is zero: 50c x 50c = 25c", () => {
    const r = buildParlayQuote(
      [lm({ ticker: ML, side: "yes", yesMidC: 50 }), lm({ ticker: TOT, side: "yes", yesMidC: 50 })],
      "default",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.built.quote.price_c).toBe(25);
      expect(r.built.quote.fair_q).toBeCloseTo(0.25, 6);
      expect(r.built.quote.independent_q).toBeCloseTo(0.25, 6);
      expect(r.built.snapshot.marginals[ML]).toBeCloseTo(0.5, 6);
    }
  });
  it("62c x 40c = 25c, never exceeding the smallest leg (Frechet upper bound)", () => {
    const r = buildParlayQuote(
      [lm({ ticker: ML, side: "yes", yesMidC: 62 }), lm({ ticker: TOT, side: "yes", yesMidC: 40 })],
      "default",
    );
    expect(r.ok && r.built.quote.price_c).toBe(25);
    if (r.ok) expect(r.built.quote.price_c).toBeLessThanOrEqual(40);
  });
  it("uses the executable ask in realistic mode", () => {
    const r = buildParlayQuote(
      [
        lm({ ticker: ML, side: "yes", yesMidC: 50, yesAskC: 60 }),
        lm({ ticker: TOT, side: "yes", yesMidC: 50, yesAskC: 60 }),
      ],
      "realistic",
    );
    expect(r.ok && r.built.quote.price_c).toBe(36); // 0.6 * 0.6 = 0.36
  });
  it("prices a NO leg off the no mid", () => {
    const r = buildParlayQuote(
      [lm({ ticker: ML, side: "no", noMidC: 30 }), lm({ ticker: TOT, side: "yes", yesMidC: 50 })],
      "default",
    );
    expect(r.ok && r.built.quote.price_c).toBe(15); // 0.3 * 0.5 = 0.15
  });
  it("lifts a positively correlated same-team pair above the independence product", () => {
    // ml(SD) + team_total(SD over): same_team rho +0.7249, so 50c x 50c prices well above 25c:
    // q = phi2(0, 0, 0.7249) = 0.25 + asin(0.7249)/(2*pi) ~ 0.379.
    const r = buildParlayQuote(
      [lm({ ticker: ML, side: "yes", yesMidC: 50 }), lm({ ticker: TT, side: "yes", yesMidC: 50 })],
      "default",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const expected = 0.25 + Math.asin(0.7249) / (2 * Math.PI);
      expect(r.built.quote.fair_q).toBeCloseTo(expected, 6);
      expect(r.built.quote.price_c).toBe(38);
      expect(r.built.quote.independent_q).toBeCloseTo(0.25, 6);
      expect(r.built.snapshot.rho[0][1]).toBeCloseTo(0.7249, 6);
    }
  });
  it("reports non-buyable legs to prune", () => {
    const r = buildParlayQuote(
      [lm({ ticker: ML, side: "yes", yesMidC: 50 }), lm({ ticker: TOT, side: "yes", yesMidC: null })],
      "default",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toContain(TOT);
  });
  it("Fix 3: prunes a dead one-sided book (fantasy ~49c mid) as non-buyable", () => {
    // bid 0 / ask 97: mid ~48 passes the old mid-only check but the book is not two-sided.
    const r = buildParlayQuote(
      [
        lm({ ticker: ML, side: "yes", yesMidC: 50 }),
        lm({ ticker: TOT, side: "yes", yesBidC: 0, yesAskC: 97, yesMidC: 48 }),
      ],
      "default",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toContain(TOT);
  });
});

// --- settlement ---
function mk(result: string, over: Partial<LiveMarket> = {}): LiveMarket {
  return {
    ticker: "T",
    event_ticker: "E",
    matchup: "Padres vs Dodgers",
    team: "Padres",
    yes_bid_c: 40,
    yes_ask_c: 60,
    no_bid_c: 40,
    no_ask_c: 60,
    last_c: 50,
    volume: 0,
    status: result ? "finalized" : "active",
    result,
    close_time: "",
    start_time: "",
    ...over,
  };
}
function ql(ticker: string, side: Side, mid_c = 50): QuoteLeg {
  return { ticker, side, type: "ml", team: "Padres", matchup: "Padres vs Dodgers", group: "Moneyline", mid_c, exec_c: mid_c + 2 };
}
function row(legs: QuoteLeg[], count = 10, price_c = 25): ParlayRow {
  const marginals: Record<string, number> = {};
  legs.forEach((l) => (marginals[l.ticker] = l.mid_c / 100));
  const snapshot: ParlaySnapshot = {
    marginals,
    rho: [],
    legs_order: legs.map((l) => l.ticker),
    corr_version: 0,
    model_version: "stub-independent",
    mode: "default",
    seed: "stub",
  };
  return { id: "p1", created_ts: 1, count, price_c, cost_c: count * price_c, legs, snapshot };
}

describe("assessParlay", () => {
  const A = "KXMLBGAME-26JUL022210SDLAD-SD";
  const B = "KXMLBTOTAL-26JUL022210SDLAD-3";

  it("any leg lost => settle lost, payout 0", () => {
    const p = row([ql(A, "yes"), ql(B, "yes")]);
    const markets = new Map<string, LiveMarket>([
      [A, mk("no")], // the A-yes leg lost
      [B, mk("")], // B still pending
    ]);
    expect(assessParlay(p, markets)).toEqual({ action: "settle", status: "lost", payout_c: 0 });
  });

  it("all legs won, none void => payout count*100", () => {
    const p = row([ql(A, "yes"), ql(B, "yes")], 10, 25);
    const markets = new Map<string, LiveMarket>([
      [A, mk("yes")],
      [B, mk("yes")],
    ]);
    expect(assessParlay(p, markets)).toEqual({ action: "settle", status: "won", payout_c: 1000 });
  });

  it("all legs void => refund cost", () => {
    const p = row([ql(A, "yes"), ql(B, "yes")], 10, 25);
    const markets = new Map<string, LiveMarket>([
      [A, mk("void")],
      [B, mk("void")],
    ]);
    expect(assessParlay(p, markets)).toEqual({ action: "settle", status: "void", payout_c: 250 });
  });

  it("won with one void reprices to the surviving leg (higher payout per ticket)", () => {
    // 2 legs at 50c each => entry 25c, cost 250. One leg voids; survivor's frozen marginal is
    // 50c, so price_eff = 50c and payout = cost*100/price_eff = 250*100/50 = 500.
    const p = row([ql(A, "yes", 50), ql(B, "yes", 50)], 10, 25);
    const markets = new Map<string, LiveMarket>([
      [A, mk("yes")],
      [B, mk("void")],
    ]);
    expect(assessParlay(p, markets)).toEqual({ action: "settle", status: "won", payout_c: 500 });
  });

  it("dollar-stake win pays stake*multiple, not count*100", () => {
    // $20 stake at 36c (two 60c legs -> 0.36 -> 36c). Win = round(2000*100/36) = 5556c, NOT
    // count*100. cost_c is decoupled from count*price for a dollar-stake parlay.
    const legs = [ql(A, "yes", 60), ql(B, "yes", 60)];
    const p: ParlayRow = {
      id: "p2",
      created_ts: 1,
      count: 56,
      price_c: 36,
      cost_c: 2000,
      legs,
      snapshot: {
        marginals: { [A]: 0.6, [B]: 0.6 },
        rho: [],
        legs_order: [A, B],
        corr_version: 0,
        model_version: "stub-independent",
        mode: "default",
        seed: "stub",
      },
    };
    const markets = new Map<string, LiveMarket>([
      [A, mk("yes")],
      [B, mk("yes")],
    ]);
    expect(assessParlay(p, markets)).toEqual({ action: "settle", status: "won", payout_c: 5556 });
  });

  it("a pending leg whose book turns fictional marks at its FROZEN marginal, not the fake mid", () => {
    // Leg B's book dies (bid 0 / ask 97, fake mid ~49): the mark must keep B's frozen 0.5,
    // so value stays at cost instead of following the fiction.
    const p = row([ql(A, "yes", 50), ql(B, "yes", 50)], 10, 25);
    const markets = new Map<string, LiveMarket>([
      [A, mk("")], // live book, mid 50
      [B, mk("", { yes_bid_c: 0, yes_ask_c: 97, no_bid_c: 3, no_ask_c: 100 })],
    ]);
    const r = assessParlay(p, markets);
    expect(r.action).toBe("mark");
    if (r.action === "mark") expect(r.value_c).toBe(250); // 0.5 * 0.5 * 1000, frozen B

    // Control: the same dead book on a LIVE mid of 20 would have dragged the value to 100.
    const drifted = new Map<string, LiveMarket>([
      [A, mk("")],
      [B, mk("", { yes_bid_c: 18, yes_ask_c: 22 })], // live book at mid 20
    ]);
    const r2 = assessParlay(p, drifted);
    if (r2.action === "mark") expect(r2.value_c).toBe(100); // live mids still flow through
  });

  it("all pending marks to ~cost with an independence snapshot", () => {
    const p = row([ql(A, "yes", 50), ql(B, "yes", 50)], 10, 25);
    const markets = new Map<string, LiveMarket>([
      [A, mk("")], // mid 50
      [B, mk("")], // mid 50
    ]);
    const r = assessParlay(p, markets);
    expect(r.action).toBe("mark");
    if (r.action === "mark") {
      // q_live = 0.5*0.5 = 0.25, potential = count*100 = 1000, value = 250 = cost.
      expect(r.value_c).toBe(250);
      expect(r.state.value).toBe(2.5);
      expect(r.state.unrealized).toBe(0);
      expect(r.state.legs.every((l) => l.status === "pending")).toBe(true);
    }
  });

  it("marks with the FROZEN snapshot rho, not a fresh table lookup", () => {
    // Entry was quoted at rho 0.7249 (price 38c); both legs still pending at mid 50. The mark
    // must reuse the stored matrix: q_live = phi2(0, 0, 0.7249) ~ 0.379, potential = 1000,
    // value = round(1000 * q_live) ~ cost (380).
    const legs = [ql(A, "yes", 50), ql(B, "yes", 50)];
    const p: ParlayRow = {
      id: "p3",
      created_ts: 1,
      count: 10,
      price_c: 38,
      cost_c: 380,
      legs,
      snapshot: {
        marginals: { [A]: 0.5, [B]: 0.5 },
        rho: [
          [1, 0.7249],
          [0.7249, 1],
        ],
        legs_order: [A, B],
        corr_version: 1,
        model_version: "copula-1",
        mode: "default",
        seed: "test",
      },
    };
    const markets = new Map<string, LiveMarket>([
      [A, mk("")],
      [B, mk("")],
    ]);
    const r = assessParlay(p, markets);
    expect(r.action).toBe("mark");
    if (r.action === "mark") {
      const q = 0.25 + Math.asin(0.7249) / (2 * Math.PI);
      expect(r.value_c).toBe(Math.round(1000 * q));
      expect(r.state.potential_payout).toBe(10);
    }
  });

  // Plan 06: settlement reruns the logic layer, so a ladder collapses to the binding leg from the
  // TICKERS alone. The stored rho is now purely statistical (spread/spread same_team has no bucket
  // -> 0), and the ladder still marks/void-reprices to the binding leg regardless of it.
  it("a ladder marks to the binding leg and void-reprices to it (logic recomputed at settlement)", () => {
    const L1 = "KXMLBSPREAD-26JUL021915STLATL-STL2"; // looser (win by 2+), marginal 0.30
    const L2 = "KXMLBSPREAD-26JUL021915STLATL-STL3"; // binding (win by 3+), marginal 0.20
    const legs = [ql(L1, "yes", 30), ql(L2, "yes", 20)];
    const p: ParlayRow = {
      id: "pL",
      created_ts: 1,
      count: 10,
      price_c: 20,
      cost_c: 200,
      legs,
      snapshot: {
        marginals: { [L1]: 0.3, [L2]: 0.2 },
        rho: [
          [1, 0],
          [0, 1],
        ],
        legs_order: [L1, L2],
        corr_version: 1,
        model_version: "copula-1",
        mode: "default",
        seed: "ladder",
      },
    };
    // Both pending at live mids 30 / 20: q_live ~ phi2(z.30, z.20, 0.999) ~ 0.20 (the binding
    // leg), so value tracks ~cost, NOT the 0.06 independence product (which would mark ~60c).
    const marked = assessParlay(
      p,
      new Map<string, LiveMarket>([
        [L1, mk("", { yes_bid_c: 29, yes_ask_c: 31 })],
        [L2, mk("", { yes_bid_c: 19, yes_ask_c: 21 })],
      ]),
    );
    expect(marked.action).toBe("mark");
    if (marked.action === "mark") {
      expect(marked.value_c).toBeGreaterThan(150);
      expect(marked.value_c).toBeLessThan(230);
    }
    // The looser leg voids, the binding leg wins: pay the surviving 20c leg (5x per ticket).
    const settled = assessParlay(
      p,
      new Map<string, LiveMarket>([
        [L1, mk("void")],
        [L2, mk("yes")],
      ]),
    );
    expect(settled).toEqual({ action: "settle", status: "won", payout_c: 1000 });
  });
});

// Plan 06 Fix B: settlement reprices through the SAME model that quoted, so the basis never
// drifts from the sold price, even on an implication chain (the round-2 bug: quoted 0.20, settled
// 0.1861).
describe("Fix B: quote/settlement consistency", () => {
  const CH_G = "26JUL021915STLATL";
  const HR = `KXMLBHR-${CH_G}-ATLMOLSON21-1`;
  const HIT = `KXMLBHIT-${CH_G}-ATLMOLSON21-1`;
  const TB = `KXMLBTB-${CH_G}-ATLMOLSON21-4`;
  const order = [HR, HIT, TB];
  const marg = [0.2, 0.9, 0.35];
  const q = quoteParlay([classifyLeg(HR, "yes"), classifyLeg(HIT, "yes"), classifyLeg(TB, "yes")], marg);

  function chainRow(): ParlayRow {
    return {
      id: "chain",
      created_ts: 1,
      count: 10,
      price_c: q.price_c,
      cost_c: 10 * q.price_c,
      legs: [ql(HR, "yes", 20), ql(HIT, "yes", 90), ql(TB, "yes", 35)],
      snapshot: {
        marginals: { [HR]: 0.2, [HIT]: 0.9, [TB]: 0.35 },
        rho: q.rho,
        legs_order: order,
        corr_version: q.corr_version,
        model_version: q.model_version,
        mode: "default",
        seed: q.seed,
      },
    };
  }

  it("the chain quotes to P(HR) exactly (HR implies both Hit and TB4)", () => {
    expect(q.fair_q).toBe(0.2);
    expect(q.price_c).toBe(20);
  });

  it("settlement recompute over all legs equals the quoted fair_q EXACTLY (was 0.1861)", () => {
    const reprice = priceFrozenSubset(
      order.map((t) => ({ ticker: t, side: "yes" as Side })),
      marg,
      q.rho,
      order,
      q.seed,
    );
    expect(reprice.q).toBe(q.fair_q);
  });

  it("the open mark shows count*100 potential and value = potential * fair_q", () => {
    const r = assessParlay(
      chainRow(),
      new Map<string, LiveMarket>([
        [HR, mk("", { yes_bid_c: 19, yes_ask_c: 21 })],
        [HIT, mk("", { yes_bid_c: 89, yes_ask_c: 91 })],
        [TB, mk("", { yes_bid_c: 34, yes_ask_c: 36 })],
      ]),
    );
    expect(r.action).toBe("mark");
    if (r.action === "mark") {
      expect(r.state.potential_payout).toBe(10); // count*100 cents via the STORED price, no drift
      expect(r.value_c).toBe(Math.round(1000 * q.fair_q));
    }
  });

  it("voiding the implier reprices to the surviving statistical pair (bucket path, ~min for Hit+TB)", () => {
    // HR voids; Hit + TB survive and win. The reprice must equal a direct priceFrozenSubset over
    // {Hit, TB} via the same_player bucket, so quote and settlement cannot drift. With the plan-07
    // measured historical value (p_hits/p_tb same_player rho ~0.98, near-comonotone: TB 2+ nearly
    // implies Hit 1+, a pair logic.ts deliberately does NOT collapse) the pair prices at ~min-of-
    // marginals, not the strictly-below-min the old +0.55 prior gave.
    const direct = priceFrozenSubset(
      [
        { ticker: HIT, side: "yes" },
        { ticker: TB, side: "yes" },
      ],
      [0.9, 0.35],
      q.rho,
      order,
      q.seed,
    );
    expect(direct.q).toBeGreaterThan(0.9 * 0.35); // above the product
    expect(direct.q).toBeLessThanOrEqual(0.35 + 1e-9); // at or below min-of-marginals
    const settled = assessParlay(
      chainRow(),
      new Map<string, LiveMarket>([
        [HR, mk("void")],
        [HIT, mk("yes")],
        [TB, mk("yes")],
      ]),
    );
    expect(settled).toEqual({
      action: "settle",
      status: "won",
      payout_c: Math.round((10 * q.price_c * 100) / direct.price_c),
    });
  });

  it("priceFrozenSubset is permutation-invariant", () => {
    const a = priceFrozenSubset(
      [
        { ticker: HIT, side: "yes" },
        { ticker: TB, side: "yes" },
      ],
      [0.9, 0.35],
      q.rho,
      order,
      q.seed,
    );
    const b = priceFrozenSubset(
      [
        { ticker: TB, side: "yes" },
        { ticker: HIT, side: "yes" },
      ],
      [0.35, 0.9],
      q.rho,
      order,
      q.seed,
    );
    expect(a.q).toBe(b.q);
  });
});
