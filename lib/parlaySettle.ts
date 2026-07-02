// Settlement + mark-to-market for one parlay, per overview contract 4. Pure of the DB and Kalshi
// (it takes a parlay row + a market map and returns a decision), so lib/account.ts stays readable
// and this logic is unit-testable against synthetic snapshots.
//
// Repricing honors overview contract 4 exactly: the void-reprice and the mark both use the
// FROZEN entry snapshot (rho submatrix + seed + entry marginals where frozen values apply),
// never a fresh correlation-table lookup, so a parlay settles against what its buyer was
// actually quoted even if the table changes later. The copula engine's jointProbability is the
// entry point (it handles 1-leg subsets, which quoteParlay's 2-leg validation would reject).

import { priceFrozenSubset } from "@/lib/parlay/quote";
import { yesMidC, noMidC, isResolved, isVoided, midIsFictional, type LiveMarket } from "@/lib/kalshi/market";
import type { LegResult, ParlayLegState, ParlaySnapshot, ParlayState, QuoteLeg } from "@/lib/parlayTypes";

// The parlay fields settlement needs (a subset of the parlays row).
export interface ParlayRow {
  id: string;
  created_ts: number;
  count: number;
  price_c: number;
  cost_c: number;
  legs: QuoteLeg[];
  snapshot: ParlaySnapshot;
}

export type Assessment =
  | { action: "settle"; status: "won" | "lost" | "void"; payout_c: number }
  | { action: "mark"; state: ParlayState; value_c: number; cost_c: number };

const d = (c: number) => Math.round(c) / 100;

// Joint probability of a subset of legs under the FROZEN entry snapshot, repriced through the
// SAME model that quoted it: priceFrozenSubset reclassifies the legs from their tickers, reruns
// the logic layer (families/ladders/implications/contradictions), and prices the reduced set
// with the stored STATISTICAL rho submatrix (aligned via legs_order) and the stored seed. This
// is what keeps the settlement basis equal to the quote even on implication chains; a baked-in
// logical-override matrix could not. Stub-era rows (rho [] / identity) reduce to the exact
// independence product, so they settle byte-identically.
function frozenJoint(snapshot: ParlaySnapshot | undefined, legs: QuoteLeg[], marginals: number[]): number {
  return priceFrozenSubset(
    legs.map((l) => ({ ticker: l.ticker, side: l.side })),
    marginals,
    snapshot?.rho ?? [],
    snapshot?.legs_order ?? [],
    snapshot?.seed ?? "settle",
  ).q;
}

// price_c (1..99) the frozen snapshot assigns a subset of legs at the given marginals (0..1).
function priceEffC(snapshot: ParlaySnapshot | undefined, legs: QuoteLeg[], marginals: number[]): number {
  return priceFrozenSubset(
    legs.map((l) => ({ ticker: l.ticker, side: l.side })),
    marginals,
    snapshot?.rho ?? [],
    snapshot?.legs_order ?? [],
    snapshot?.seed ?? "settle",
  ).price_c;
}

export function assessParlay(p: ParlayRow, markets: Map<string, LiveMarket>): Assessment {
  const frozen = p.snapshot?.marginals ?? {};
  const frozenQ = (leg: QuoteLeg): number => frozen[leg.ticker] ?? leg.mid_c / 100;

  // Per-leg result + the live marginal used for marking (frozen fallback if the market is gone).
  const legEval = p.legs.map((leg) => {
    const m = markets.get(leg.ticker);
    let status: LegResult = "pending";
    let liveQ = frozenQ(leg);
    if (m) {
      if (isVoided(m)) status = "void";
      else if (isResolved(m)) status = m.result === leg.side ? "won" : "lost";
      else {
        // A wide two-sided book's mid is fiction; keep the frozen entry marginal instead so
        // marks (and cashout, which prices off this assessment) never pay out against it.
        const mid = leg.side === "yes" ? yesMidC(m) : noMidC(m);
        if (mid != null && !midIsFictional(m)) liveQ = mid / 100;
      }
    }
    return { leg, status, liveQ };
  });

  const anyLost = legEval.some((e) => e.status === "lost");
  const anyPending = legEval.some((e) => e.status === "pending");
  const anyVoid = legEval.some((e) => e.status === "void");

  // 1) Any leg lost: the parlay is dead now, payout 0.
  if (anyLost) return { action: "settle", status: "lost", payout_c: 0 };

  // 2) Every leg resolved, none lost: won (repriced over the surviving legs) or a full-void refund.
  if (!anyPending) {
    const survivors = legEval.filter((e) => e.status === "won");
    if (survivors.length === 0) return { action: "settle", status: "void", payout_c: p.cost_c };
    // No-void shortcut: with nothing voided the basis is EXACTLY the stored entry price, so pay
    // cost / price_c (== count*100 for a whole-contract bet, the exact stake for a dollar-stake)
    // with no recompute. Only a genuine void reprices the survivors from their FROZEN marginals.
    const priceEff = anyVoid
      ? priceEffC(p.snapshot, survivors.map((e) => e.leg), survivors.map((e) => frozenQ(e.leg)))
      : p.price_c;
    const payout = Math.round((p.cost_c * 100) / priceEff);
    return { action: "settle", status: "won", payout_c: payout };
  }

  // 3) Still open: mark it. potential_payout = cost / price_eff over the non-void legs (== the
  // full stake return when nothing has voided, taken straight from the stored price); q_live is
  // the joint of the still-unresolved legs at LIVE marginals (won legs have dropped out).
  const nonVoid = legEval.filter((e) => e.status !== "void");
  const potentialC = anyVoid
    ? Math.round(
        (p.cost_c * 100) / priceEffC(p.snapshot, nonVoid.map((e) => e.leg), nonVoid.map((e) => frozenQ(e.leg))),
      )
    : Math.round((p.cost_c * 100) / p.price_c);
  const pending = legEval.filter((e) => e.status === "pending");
  const qLive = frozenJoint(p.snapshot, pending.map((e) => e.leg), pending.map((e) => e.liveQ));
  const valueC = Math.round(potentialC * qLive);

  const legs: ParlayLegState[] = legEval.map((e) => ({
    ticker: e.leg.ticker,
    side: e.leg.side,
    type: e.leg.type,
    team: e.leg.team,
    matchup: e.leg.matchup,
    group: e.leg.group,
    mid_c: e.leg.mid_c,
    status: e.status,
  }));

  const state: ParlayState = {
    id: p.id,
    created_ts: p.created_ts,
    count: p.count,
    price_c: p.price_c,
    cost: d(p.cost_c),
    status: "open",
    value: d(valueC),
    unrealized: d(valueC - p.cost_c),
    potential_payout: d(potentialC),
    legs,
  };
  return { action: "mark", state, value_c: valueC, cost_c: p.cost_c };
}
