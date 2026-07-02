// Structural MLB runs model: simulate a baseball game at the runs level, with no external data,
// and read every game-scoped leg off each simulated game. Used OFFLINE by
// scripts/parlay/structural.ts to generate source:"structural" correlation entries. The app
// never runs this at request time.
//
// DESCOPED (2026-07-02): agent 01's measured historical correlations now outrank structural for
// every game-scoped bucket, so these numbers are CROSS-CHECK ONLY, not the pricing path. Do not
// spend time debugging the simulation. Known pathology, for the record: extras/spread comes out
// ~-0.999 vs a ground-truth ~-0.35, because simulated extra-inning games (entered only when tied
// after 9) almost never end with a 2+ run margin, so "extras" and "team wins by 2+" look almost
// mutually exclusive. Real extra-inning games score more freely (e.g. the runner-on-2nd rule,
// which this model omits). Left as-is by design.
//
// Imports are relative (./normal.ts) rather than the "@/" alias so this file and the generator
// script run directly under `node` (native TS type-stripping). It is offline tooling and the
// app never imports it.

import { normInv, phi2 } from "./normal.ts";
import type { CorrelationEntry, CorrelationSource, LegType, Relation } from "./types.ts";

// Empirical half-inning run distribution (league average). MLB half-innings are scoreless
// ~72-73% of the time; the tail falls off fast. Team strength re-weights this to a target mean
// via an exponential tilt, so only the SHAPE matters here.
// Source: MLB/Retrosheet per-inning run aggregates (scoreless ~0.73, 1 run ~0.15, ...).
export const BASE_PMF = [0.73, 0.15, 0.07, 0.03, 0.012, 0.005, 0.002, 0.0007, 0.0003];

// Exponential tilt of a base PMF to hit a target mean: q_k proportional to p_k * exp(theta*k),
// theta found by bisection. Preserves shape while matching each team's expected runs.
export function tiltPmf(base: number[], mean: number): number[] {
  const K = base.length;
  if (mean <= 1e-9) return base.map((_, i) => (i === 0 ? 1 : 0));
  const meanAt = (theta: number): number => {
    let z = 0;
    let m = 0;
    for (let k = 0; k < K; k++) {
      const w = base[k] * Math.exp(theta * k);
      z += w;
      m += k * w;
    }
    return m / z;
  };
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (meanAt(mid) < mean) lo = mid;
    else hi = mid;
  }
  const theta = (lo + hi) / 2;
  const out = base.map((p, k) => p * Math.exp(theta * k));
  const s = out.reduce((a, b) => a + b, 0);
  return out.map((x) => x / s);
}

function cdfOf(pmf: number[]): number[] {
  const c = pmf.slice();
  for (let i = 1; i < c.length; i++) c[i] += c[i - 1];
  return c;
}

function sampleFromCdf(cdf: number[], u: number): number {
  for (let k = 0; k < cdf.length; k++) if (u <= cdf[k]) return k;
  return cdf.length - 1;
}

// --- deterministic PRNG (mulberry32 seeded via xmur3), inlined so this file has no runtime
// dependency on the copula module (which uses the "@/" alias). ---
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GameResult {
  home: number[]; // runs per inning (index 0 = 1st)
  away: number[];
  homeTotal: number;
  awayTotal: number;
  extras: boolean;
}

// Simulate one game. lh/la = expected runs per 9 innings for home/away. Home skips the bottom
// of the 9th when already ahead; a bottom-9th/extra-inning walk-off ends at the winning run;
// extra innings continue until a completed inning is decided.
export function simulateGame(lh: number, la: number, rng: () => number): GameResult {
  const cdfH = cdfOf(tiltPmf(BASE_PMF, lh / 9));
  const cdfA = cdfOf(tiltPmf(BASE_PMF, la / 9));
  const home: number[] = [];
  const away: number[] = [];
  let HT = 0;
  let AT = 0;
  let inning = 0;
  while (true) {
    inning++;
    const ar = sampleFromCdf(cdfA, rng());
    away.push(ar);
    AT += ar;
    if (inning >= 9 && HT > AT) break; // home already leads after the top: no bottom half
    let hr = sampleFromCdf(cdfH, rng());
    if (inning >= 9) {
      const need = AT - HT + 1; // runs to take the lead
      if (need > 0 && hr >= need) hr = need; // walk-off ends at the winning run
    }
    home.push(hr);
    HT += hr;
    if (inning >= 9 && HT !== AT) break; // decided after a completed inning
    if (inning >= 30) break; // pathological safety cap
  }
  return { home, away, homeTotal: HT, awayTotal: AT, extras: inning > 9 };
}

export interface GameStats {
  pHome: number;
  meanTotal: number;
}

// Aggregate win rate and mean total over `sims` games. A fixed seed gives common random numbers
// so calibration bisection sees a monotone, noise-free response.
export function simStats(lh: number, la: number, sims: number, seed: string): GameStats {
  const rng = mulberry32(xmur3(seed));
  let wins = 0;
  let total = 0;
  for (let i = 0; i < sims; i++) {
    const g = simulateGame(lh, la, rng);
    if (g.homeTotal > g.awayTotal) wins++;
    total += g.homeTotal + g.awayTotal;
  }
  return { pHome: wins / sims, meanTotal: total / sims };
}

// Recover (lambdaHome, lambdaAway) from a Kalshi moneyline mid (P home wins) and total mid
// (expected total runs). Outer bisection on the run total, inner bisection on the split.
export function calibrate(
  mlTarget: number,
  totalTarget: number,
  sims: number,
  seed: string,
): { lambdaHome: number; lambdaAway: number } {
  let loT = totalTarget * 0.5;
  let hiT = totalTarget * 1.6;
  let lambdaTotal = totalTarget;
  let split = 0.5;
  for (let outer = 0; outer < 22; outer++) {
    lambdaTotal = (loT + hiT) / 2;
    let loS = 0.15;
    let hiS = 0.85;
    for (let inner = 0; inner < 20; inner++) {
      split = (loS + hiS) / 2;
      const { pHome } = simStats(lambdaTotal * split, lambdaTotal * (1 - split), sims, seed);
      if (pHome < mlTarget) loS = split;
      else hiS = split;
    }
    const { meanTotal } = simStats(lambdaTotal * split, lambdaTotal * (1 - split), sims, seed);
    if (meanTotal < totalTarget) loT = lambdaTotal;
    else hiT = lambdaTotal;
  }
  return { lambdaHome: lambdaTotal * split, lambdaAway: lambdaTotal * (1 - split) };
}

// Tetrachoric correlation: the latent-normal rho reproducing a 2x2 hit table. Invert
// phi2(zA, zB, rho) = P(A and B) by bisection (phi2 is increasing in rho).
export function tetrachoric(pA: number, pB: number, pAB: number): number {
  if (pA <= 0 || pA >= 1 || pB <= 0 || pB >= 1) return 0;
  const zA = normInv(pA);
  const zB = normInv(pB);
  let lo = -0.999;
  let hi = 0.999;
  if (pAB <= phi2(zA, zB, lo)) return lo;
  if (pAB >= phi2(zA, zB, hi)) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (phi2(zA, zB, mid) < pAB) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// --- named binary events read off a simulated game ---

function sumFirst(arr: number[], n: number): number {
  let s = 0;
  for (let i = 0; i < n && i < arr.length; i++) s += arr[i];
  return s;
}

// Representative canonical events, in a fixed vector order. Team-scoped events have home/away
// variants; the "2" suffix is a second (higher) line so same-type nested pairs (e.g. team_total
// over 3.5 vs 4.5) can be measured. `totalLine` is the cell's calibrated total line.
export const EVENT_NAMES = [
  "ml.home", "ml.away", "spread.home", "spread.away", "team_total.home", "team_total.away",
  "team_total.home2", "total.over", "total.over2", "f3_ml.home", "f3_ml.away", "f5_ml.home",
  "f5_ml.away", "f5_spread.home", "f5_spread.away", "f5_total.over", "f5_total.over2",
  "f7_ml.home", "f7_ml.away", "extras", "rfi",
] as const;
export const EVENT_INDEX: Record<string, number> = Object.fromEntries(
  EVENT_NAMES.map((n, i) => [n, i]),
);

// Fill `out` with 0/1 for each event in EVENT_NAMES order. The single source of truth for the
// event definitions; evalEvents is the named-object view for tests.
export function evalEventVector(g: GameResult, totalLine: number, out: Int8Array): void {
  const HT = g.homeTotal;
  const AT = g.awayTotal;
  const h3 = sumFirst(g.home, 3);
  const a3 = sumFirst(g.away, 3);
  const h5 = sumFirst(g.home, 5);
  const a5 = sumFirst(g.away, 5);
  const h7 = sumFirst(g.home, 7);
  const a7 = sumFirst(g.away, 7);
  const first5 = h5 + a5;
  out[0] = HT > AT ? 1 : 0;
  out[1] = AT > HT ? 1 : 0;
  out[2] = HT - AT >= 2 ? 1 : 0;
  out[3] = AT - HT >= 2 ? 1 : 0;
  out[4] = HT >= 4 ? 1 : 0;
  out[5] = AT >= 4 ? 1 : 0;
  out[6] = HT >= 5 ? 1 : 0;
  out[7] = HT + AT > totalLine ? 1 : 0;
  out[8] = HT + AT > totalLine + 2 ? 1 : 0;
  out[9] = h3 > a3 ? 1 : 0;
  out[10] = a3 > h3 ? 1 : 0;
  out[11] = h5 > a5 ? 1 : 0;
  out[12] = a5 > h5 ? 1 : 0;
  out[13] = h5 - a5 >= 2 ? 1 : 0;
  out[14] = a5 - h5 >= 2 ? 1 : 0;
  out[15] = first5 > 4.5 ? 1 : 0;
  out[16] = first5 > 5.5 ? 1 : 0;
  out[17] = h7 > a7 ? 1 : 0;
  out[18] = a7 > h7 ? 1 : 0;
  out[19] = g.extras ? 1 : 0;
  out[20] = (g.home[0] ?? 0) + (g.away[0] ?? 0) >= 1 ? 1 : 0;
}

export function evalEvents(g: GameResult, totalLine: number): Record<string, boolean> {
  const vec = new Int8Array(EVENT_NAMES.length);
  evalEventVector(g, totalLine, vec);
  const out: Record<string, boolean> = {};
  EVENT_NAMES.forEach((name, i) => (out[name] = vec[i] === 1));
  return out;
}

export interface BucketSpec {
  a: LegType;
  b: LegType;
  relation: Relation;
  evA: string;
  evB: string;
}

const TEAM_SCOPED: LegType[] = [
  "ml", "spread", "team_total", "f3_ml", "f5_ml", "f5_spread", "f7_ml",
];
const TEAM_AGNOSTIC: LegType[] = ["total", "f5_total", "rfi", "extras"];
const HOME_EV: Record<string, string> = {
  ml: "ml.home", spread: "spread.home", team_total: "team_total.home", f3_ml: "f3_ml.home",
  f5_ml: "f5_ml.home", f5_spread: "f5_spread.home", f7_ml: "f7_ml.home",
};
const AWAY_EV: Record<string, string> = {
  ml: "ml.away", spread: "spread.away", team_total: "team_total.away", f3_ml: "f3_ml.away",
  f5_ml: "f5_ml.away", f5_spread: "f5_spread.away", f7_ml: "f7_ml.away",
};
const AG_EV: Record<string, string> = {
  total: "total.over", f5_total: "f5_total.over", rfi: "rfi", extras: "extras",
};

function sortPair(a: LegType, b: LegType): [LegType, LegType] {
  return a <= b ? [a, b] : [b, a];
}

// Every game-scoped correlation bucket the structural model can measure.
export function buildBucketSpecs(): BucketSpec[] {
  const out: BucketSpec[] = [];
  const seen = new Set<string>();
  const push = (a: LegType, b: LegType, relation: Relation, evA: string, evB: string) => {
    const [sa, sb] = sortPair(a, b);
    const key = `${sa}|${sb}|${relation}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ a: sa, b: sb, relation, evA, evB });
  };

  // same_team: two team-scoped legs on the same team (distinct types).
  for (let i = 0; i < TEAM_SCOPED.length; i++) {
    for (let j = i + 1; j < TEAM_SCOPED.length; j++) {
      const a = TEAM_SCOPED[i];
      const b = TEAM_SCOPED[j];
      push(a, b, "same_team", HOME_EV[a], HOME_EV[b]);
    }
  }
  // same_team, same type, nested lines (only team_total has a second line here).
  push("team_total", "team_total", "same_team", "team_total.home", "team_total.home2");

  // opp_team: one leg per team (includes same-type, e.g. ml home vs ml away).
  for (let i = 0; i < TEAM_SCOPED.length; i++) {
    for (let j = i; j < TEAM_SCOPED.length; j++) {
      const a = TEAM_SCOPED[i];
      const b = TEAM_SCOPED[j];
      push(a, b, "opp_team", HOME_EV[a], AWAY_EV[b]);
    }
  }

  // game: at least one team-agnostic leg.
  for (const ag of TEAM_AGNOSTIC) {
    for (const ts of TEAM_SCOPED) push(ag, ts, "game", AG_EV[ag], HOME_EV[ts]);
  }
  for (let i = 0; i < TEAM_AGNOSTIC.length; i++) {
    for (let j = i + 1; j < TEAM_AGNOSTIC.length; j++) {
      const a = TEAM_AGNOSTIC[i];
      const b = TEAM_AGNOSTIC[j];
      push(a, b, "game", AG_EV[a], AG_EV[b]);
    }
  }
  // game, same type, nested lines.
  push("total", "total", "game", "total.over", "total.over2");
  push("f5_total", "f5_total", "game", "f5_total.over", "f5_total.over2");

  return out;
}

export interface CellRho {
  key: string; // "a|b|relation"
  rho: number;
  pA: number;
  pB: number;
  usable: boolean; // false if a marginal was degenerate
}

// Estimate every bucket's rho for one calibrated cell.
export function estimateCell(
  lh: number,
  la: number,
  sims: number,
  seed: string,
  totalLine: number,
  specs: BucketSpec[],
): CellRho[] {
  const rng = mulberry32(xmur3(seed));
  const n = specs.length;
  // Resolve each spec's two event names to indices into the event vector once, up front, so the
  // hot loop only touches typed arrays.
  const idxA = specs.map((s) => EVENT_INDEX[s.evA]);
  const idxB = specs.map((s) => EVENT_INDEX[s.evB]);
  const cA = new Int32Array(n);
  const cB = new Int32Array(n);
  const cAB = new Int32Array(n);
  const vec = new Int8Array(EVENT_NAMES.length);
  for (let i = 0; i < sims; i++) {
    evalEventVector(simulateGame(lh, la, rng), totalLine, vec);
    for (let s = 0; s < n; s++) {
      const a = vec[idxA[s]];
      const b = vec[idxB[s]];
      cA[s] += a;
      cB[s] += b;
      cAB[s] += a & b;
    }
  }
  return specs.map((s, i) => {
    const pA = cA[i] / sims;
    const pB = cB[i] / sims;
    const pAB = cAB[i] / sims;
    const usable = pA > 0.01 && pA < 0.99 && pB > 0.01 && pB < 0.99;
    return { key: `${s.a}|${s.b}|${s.relation}`, rho: usable ? tetrachoric(pA, pB, pAB) : 0, pA, pB, usable };
  });
}

export interface GridCell {
  ml: number;
  total: number;
}

// Run the full grid and aggregate each bucket's rho (mean over usable cells; spread = stdev).
export function generateStructuralEntries(
  grid: GridCell[],
  calSims: number,
  estSims: number,
): CorrelationEntry[] {
  const specs = buildBucketSpecs();
  const acc = new Map<string, number[]>();
  for (const cell of grid) {
    const seedBase = `mlb-${cell.ml}-${cell.total}`;
    const { lambdaHome, lambdaAway } = calibrate(cell.ml, cell.total, calSims, `${seedBase}-cal`);
    const cellRhos = estimateCell(
      lambdaHome, lambdaAway, estSims, `${seedBase}-est`, cell.total, specs,
    );
    for (const cr of cellRhos) {
      if (!cr.usable) continue;
      (acc.get(cr.key) ?? acc.set(cr.key, []).get(cr.key)!).push(cr.rho);
    }
  }
  const entries: CorrelationEntry[] = [];
  for (const s of specs) {
    const key = `${s.a}|${s.b}|${s.relation}`;
    const vals = acc.get(key);
    if (!vals || vals.length === 0) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    entries.push({
      a: s.a,
      b: s.b,
      relation: s.relation,
      rho: Math.round(mean * 1000) / 1000,
      source: "structural",
      n: estSims * vals.length,
      spread: Math.round(Math.sqrt(variance) * 1000) / 1000,
      notes: "runs-model MC, avg over moneyline x total grid (cross-check only; historical outranks)",
    });
  }
  return entries;
}

// --- table merge (so the offline generator never clobbers sources it does not own) ---

// The only sources this generator owns and may replace. Everything else (historical from agent
// 01, any future distilled) must be preserved verbatim.
export const OWNED_SOURCES: ReadonlySet<CorrelationSource> = new Set<CorrelationSource>([
  "structural",
  "prior",
]);

// Minimal structural validation of an existing table's entries, enough to merge safely without
// depending on correlations.ts (which uses the "@/" alias and is not node-runnable here). Throws
// on anything malformed so the generator refuses to overwrite a file it cannot understand.
export function parseTableEntries(raw: unknown): CorrelationEntry[] {
  if (!raw || typeof raw !== "object") throw new Error("existing table is not an object");
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error("existing table has no entries array");
  return entries.map((e, i) => {
    if (!e || typeof e !== "object") throw new Error(`existing entry ${i} is not an object`);
    const o = e as Record<string, unknown>;
    if (
      typeof o.a !== "string" ||
      typeof o.b !== "string" ||
      typeof o.relation !== "string" ||
      typeof o.source !== "string" ||
      typeof o.rho !== "number"
    ) {
      throw new Error(`existing entry ${i} is malformed`);
    }
    return e as CorrelationEntry;
  });
}

// Merge freshly generated owned entries (structural + prior) into an existing table: drop the
// existing owned entries, keep every foreign entry (historical, distilled, ...) untouched, and
// append the fresh owned ones. Refuses (throws) rather than return a set that would lose any
// foreign entry it does not own.
export function mergeCorrelationTable(
  existing: CorrelationEntry[] | null,
  generated: CorrelationEntry[],
): CorrelationEntry[] {
  for (const e of generated) {
    if (!OWNED_SOURCES.has(e.source))
      throw new Error(`generated entry has a non-owned source: ${e.source}`);
  }
  const prior = existing ?? [];
  const foreign = prior.filter((e) => !OWNED_SOURCES.has(e.source));
  const merged = [...foreign, ...generated];
  const keptForeign = merged.filter((e) => !OWNED_SOURCES.has(e.source)).length;
  if (keptForeign !== foreign.length)
    throw new Error("refusing to write: merge would drop entries from a source it does not own");
  return merged;
}
