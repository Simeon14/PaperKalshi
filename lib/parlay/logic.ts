// The logic layer: exact interval algebra for structurally related legs, run inside quoteParlay
// after classification and before the copula. Most broken same-game combos are logically
// determined and need no correlation model: a spread ladder, ml+spread, over+under, a HR and its
// implied hit are all threshold events on one underlying scalar, so their joint probability is
// exact interval algebra on the legs' own marginals. The copula should only ever see legs whose
// dependence is genuinely statistical.
//
// See Parlay/reports/04-pricing-probe-findings.md (the audit) and Parlay/05-pricing-fixes.md.

import { isPlayerType } from "@/lib/parlay/types";
import type { ClassifiedLeg, LegType } from "@/lib/parlay/types";

// The near-certain correlation the copula uses to REPRODUCE a logical relationship for the
// stored snapshot (so settlement's frozenJoint reprices a ladder to the binding leg without
// re-running this layer). +value for comonotone (same-direction) family members and
// implications, -value for opposite-direction (a lower vs an upper bound on the same scalar).
export const LOGICAL_RHO = 0.999;

// A reduced pricing unit: one family (or one singleton) that the copula prices.
export interface ReducedLeg {
  rep: ClassifiedLeg; // representative leg for the cross-family bucket lookup + display
  marginal: number; // the family's exact interval probability (0..1)
  members: number[]; // original leg indices that collapsed into this unit
}

export type ReduceResult =
  | { ok: true; reduced: ReducedLeg[]; logicalRho: (number | null)[][]; collapsed: number }
  | { ok: false; code: "impossible_combo"; reason: string };

// Certain per-game invariants for one player: stat[to] >= mult * stat[from], always. A home run
// is a hit (1x), 4 total bases (4x), an RBI (1x) and 3 of H+R+RBI (3x); a hit is a total base
// (1x) and 1 of H+R+RBI (1x); an RBI is 1 of H+R+RBI (1x).
const INVARIANTS: [string, string, number][] = [
  ["p_hr", "p_hits", 1],
  ["p_hr", "p_tb", 4],
  ["p_hr", "p_rbi", 1],
  ["p_hr", "p_hrr", 3],
  ["p_hits", "p_tb", 1],
  ["p_hits", "p_hrr", 1],
  ["p_rbi", "p_hrr", 1],
];

function invariantMult(from: string, to: string): number | undefined {
  const r = INVARIANTS.find(([f, t]) => f === from && t === to);
  return r ? r[2] : undefined;
}

// For CONTRADICTION detection only (not redundancy collapse), add the certain floor that any
// positive total-bases count needs at least one hit: Hits >= TB/4 (a hit is at most 4 bases). We
// deliberately keep this OUT of the redundancy set so a plain "Hit 1+ AND TB 4+" still prices
// through the same_player bucket (as the round-2 audit verified), while "TB 2+ AND Hit 1+ NO"
// is still caught as impossible.
const CONTRA_INVARIANTS: [string, string, number][] = [...INVARIANTS, ["p_tb", "p_hits", 0.25]];
function contraMult(from: string, to: string): number | undefined {
  const r = CONTRA_INVARIANTS.find(([f, t]) => f === from && t === to);
  return r ? r[2] : undefined;
}

// Does the yes-event of leg `y` (stat_y >= y.line+0.5) certainly force stat[zType] >= tZ? Uses
// stat_z >= mult * stat_y and integer counts (ceil).
function yesForces(y: ClassifiedLeg, zType: LegType, tZ: number): boolean {
  if (y.line == null) return false;
  const m = contraMult(y.type, zType);
  return m != null && Math.ceil(m * (y.line + 0.5)) >= tZ;
}

// Two same-player legs contradict when one leg's event forces a stat the other leg's NO side
// denies (a HR with zero hits, 4 total bases with no hit, ...). Covers both orders. A voided or
// non-player pair never contradicts. The family/interval contradictions (over 9.5 + not-over 8.5)
// are caught separately by the empty-interval check.
export function contradicts(a: ClassifiedLeg, b: ClassifiedLeg): boolean {
  if (!isPlayerType(a.type) || !isPlayerType(b.type)) return false;
  if (!a.playerRef || a.playerRef !== b.playerRef) return false;
  if (a.line == null || b.line == null) return false;
  // yes A forces stat_B up to (b.line+0.5), which a NO on B (stat_B <= b.line-0.5) denies.
  if (a.side === "yes" && b.side === "no" && yesForces(a, b.type, b.line + 0.5)) return true;
  if (b.side === "yes" && a.side === "no" && yesForces(b, a.type, a.line + 0.5)) return true;
  return false;
}

// Does leg a (certainly) imply leg b for the same player, so b is redundant? Line-aware.
// A yes leg "stat > line" wins at stat >= line + 0.5; a no leg "stat <= line" wins at
// stat <= line - 0.5. Only same-side pairs imply (a yes and a no never make each other
// redundant). Contrapositive handles the no-side (no hits implies no HR).
export function legImplies(a: ClassifiedLeg, b: ClassifiedLeg): boolean {
  if (!isPlayerType(a.type) || !isPlayerType(b.type)) return false;
  if (!a.playerRef || a.playerRef !== b.playerRef) return false;
  if (a.line == null || b.line == null) return false;
  if (a.side === "yes" && b.side === "yes") {
    const m = invariantMult(a.type, b.type);
    if (m == null) return false;
    return m * (a.line + 0.5) >= b.line + 0.5; // stat_b >= m*stat_a >= m*t_a; wins if >= t_b
  }
  if (a.side === "no" && b.side === "no") {
    // Contrapositive: a caps stat_a <= cA; via stat_a >= m*stat_b it caps stat_b <= cA/m.
    const m = invariantMult(b.type, a.type);
    if (m == null) return false;
    return b.line - 0.5 >= Math.floor((a.line - 0.5) / m);
  }
  return false;
}

// Single-winner market families: two or more YES legs on different outcomes of the same
// (series, game) are jointly impossible. The margin folding below already catches the two
// moneylines case; this also catches the F3/F5/F7 team-plus-tie case and is cheap insurance.
const EXCLUSIVE_SERIES: ReadonlySet<string> = new Set([
  "KXMLBGAME",
  "KXMLBF3",
  "KXMLBF5",
  "KXMLBF7",
]);

const seriesOf = (ticker: string) => ticker.split("-")[0] ?? "";
const outcomeOf = (ticker: string) => ticker.split("-")[2] ?? "";

// The threshold family a leg belongs to, or null for a singleton (f3/f7 winner, extras, rfi,
// unknown, or anything without a game key). ml/spread fold into one per-game `margin` scalar;
// f5_ml/f5_spread into `f5margin`; totals/team totals/player stats into their own scalar.
function familyKey(leg: ClassifiedLeg): string | null {
  if (!leg.gameKey) return null;
  const t = leg.type;
  if ((t === "ml" || t === "spread") && leg.teamRef) return `margin|${leg.gameKey}`;
  if ((t === "f5_ml" || t === "f5_spread") && leg.teamRef) return `f5margin|${leg.gameKey}`;
  if (t === "total") return `total|${leg.gameKey}`;
  if (t === "f5_total") return `f5_total|${leg.gameKey}`;
  if (t === "team_total" && leg.teamRef) return `team_total|${leg.gameKey}|${leg.teamRef}`;
  if (isPlayerType(t) && leg.playerRef) return `${t}|${leg.gameKey}|${leg.playerRef}`;
  return null;
}

// A one-sided interval constraint on the family's scalar X, from one leg's own marginal.
// lower: {X > val} with prob = P(X > val); upper: {X <= val} with prob = P(X <= val).
// dir is the latent's sign relative to X (+1 lower, -1 upper) so same-scalar pairs get
// LOGICAL_RHO * dir_i * dir_j.
interface Bound {
  kind: "lower" | "upper";
  val: number;
  prob: number;
  dir: 1 | -1;
  idx: number;
}

function boundFor(
  leg: ClassifiedLeg,
  marginal: number,
  idx: number,
  isMargin: boolean,
  refTeam: string | undefined,
): Bound {
  const L = leg.line ?? 0.5; // ml/f5_ml winners fold into the margin scalar at 0.5 (a win is 1+)
  if (isMargin && leg.teamRef !== refTeam) {
    // Opponent leg on the reference team's margin X = -X_opp: yes flips to an upper bound.
    return leg.side === "yes"
      ? { kind: "upper", val: -L, prob: marginal, dir: -1, idx }
      : { kind: "lower", val: -L, prob: marginal, dir: 1, idx };
  }
  return leg.side === "yes"
    ? { kind: "lower", val: L, prob: marginal, dir: 1, idx }
    : { kind: "upper", val: L, prob: marginal, dir: -1, idx };
}

// Reduce a parlay to its statistically-independent units. May report the combo impossible.
export function reduceParlay(legs: ClassifiedLeg[], marginals: number[]): ReduceResult {
  const n = legs.length;

  // 1) Exclusive-outcome detection (single-winner series, yes legs on distinct outcomes).
  const outcomes = new Map<string, Set<string>>();
  for (let i = 0; i < n; i++) {
    const l = legs[i];
    if (l.side !== "yes" || !EXCLUSIVE_SERIES.has(seriesOf(l.ticker)) || !l.gameKey) continue;
    const key = seriesOf(l.ticker) + "|" + l.gameKey;
    const set = outcomes.get(key) ?? outcomes.set(key, new Set()).get(key)!;
    set.add(outcomeOf(l.ticker));
  }
  for (const set of outcomes.values()) {
    if (set.size >= 2)
      return { ok: false, code: "impossible_combo", reason: "exclusive outcomes of one market" };
  }

  // 1b) Cross-stat contradictions: a yes leg plus a NO on a stat it implies is probability zero.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (contradicts(legs[i], legs[j]))
        return { ok: false, code: "impossible_combo", reason: "a leg denies a stat another forces" };
    }
  }

  const logicalRho: (number | null)[][] = Array.from({ length: n }, () => new Array(n).fill(null));
  const setRho = (i: number, j: number, v: number) => {
    logicalRho[i][j] = v;
    logicalRho[j][i] = v;
  };

  // 2) Implication pre-pass: drop each leg certainly implied by another present leg. Dropping is
  // always globally safe (the implied event is guaranteed) and never distorts a family interval
  // (an external implication only reaches the looser members; the tightest survivor is untouched).
  const dropped = new Array<boolean>(n).fill(false);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (i === j || dropped[j]) continue;
      if (!dropped[i] && legImplies(legs[i], legs[j])) {
        dropped[j] = true;
        setRho(i, j, LOGICAL_RHO); // comonotone containment
        break;
      }
    }
  }

  // 3) Group surviving legs into families.
  const families = new Map<string, number[]>();
  const singletons: number[] = [];
  for (let i = 0; i < n; i++) {
    if (dropped[i]) continue;
    const key = familyKey(legs[i]);
    if (key == null) {
      singletons.push(i);
      continue;
    }
    (families.get(key) ?? families.set(key, []).get(key)!).push(i);
  }

  // 4) Reduce each family by intersecting its interval; empty interval => impossible.
  const reduced: ReducedLeg[] = [];
  for (const [key, members] of families) {
    const isMargin = key.startsWith("margin|") || key.startsWith("f5margin|");
    const refTeam = isMargin ? legs[members[0]].teamRef : undefined;
    const bounds = members.map((idx) =>
      boundFor(legs[idx], marginals[idx], idx, isMargin, refTeam),
    );
    let lo: Bound | null = null;
    let hi: Bound | null = null;
    for (const b of bounds) {
      if (b.kind === "lower") {
        if (!lo || b.val > lo.val) lo = b;
      } else if (!hi || b.val < hi.val) hi = b;
    }
    if (lo && hi && lo.val >= hi.val)
      return { ok: false, code: "impossible_combo", reason: "empty interval" };
    // P(lo < X <= hi) = P(X > lo) - P(X > hi). No lower bound => P(X > -inf) = 1; no upper
    // bound => P(X > +inf) = 0. An upper bound's leg gives P(X <= hi) = its marginal.
    const pLo = lo ? lo.prob : 1;
    const pHi = hi ? 1 - hi.prob : 0;
    const marginal = Math.max(0, Math.min(1, pLo - pHi));
    const repIdx = lo ? lo.idx : hi ? hi.idx : members[0];
    reduced.push({ rep: legs[repIdx], marginal, members });
    // Same-scalar pairs are comonotone/anti-monotone: LOGICAL_RHO * dir_i * dir_j.
    for (let x = 0; x < bounds.length; x++)
      for (let y = x + 1; y < bounds.length; y++)
        setRho(bounds[x].idx, bounds[y].idx, LOGICAL_RHO * bounds[x].dir * bounds[y].dir);
  }

  // 5) Singletons pass through unchanged.
  for (const i of singletons) reduced.push({ rep: legs[i], marginal: marginals[i], members: [i] });

  return { ok: true, reduced, logicalRho, collapsed: n - reduced.length };
}
