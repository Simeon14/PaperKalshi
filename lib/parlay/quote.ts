// quoteParlay: correlation-aware price for a set of classified legs given their live marginals.
// Pure function. The route layer owns fetching marginals (mids in default mode, executable ask
// side in realistic mode) and re-quotes with fresh no-store quotes at trade time; this function
// never touches the network or DB.

import { defaultTable, rhoFor } from "@/lib/parlay/correlations";
import { jointProbability } from "@/lib/parlay/copula";
import { nearestPSD } from "@/lib/parlay/normal";
import { reduceParlay } from "@/lib/parlay/logic";
import { classifyLeg } from "@/lib/parlay/classify";
import type { ClassifiedLeg, Matrix, QuoteOptions, QuoteResult, Side } from "@/lib/parlay/types";

// Thrown for inputs the engine refuses to price. `code` maps to a 400 at the route layer.
export class QuoteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QuoteError";
    this.code = code;
  }
}

const MC_STDERR_WARN = 0.002; // ~0.2 cent: flag Monte Carlo intervals wider than this
const LONGSHOT_Q = 0.005; // below half a cent it would only ever show the rounded-up 1c floor

// Deterministic seed string: sorted "ticker|side" keys. Order-independent by construction, and
// settlement reprices a void subset with the exact same PRNG stream. NOTE: the seed alone does
// NOT make the price order-independent (the Cholesky factor, thresholds, and hit tests run in
// whatever order the matrix is built); quoteParlay canonicalizes the legs to this same key order
// before pricing so the whole quote is permutation-invariant.
function legKey(l: ClassifiedLeg): string {
  return `${l.ticker}|${l.side}`;
}
function seedFor(legs: ClassifiedLeg[]): string {
  return legs.map(legKey).slice().sort().join(",");
}

function validate(legs: ClassifiedLeg[], marginals: number[]): void {
  if (legs.length !== marginals.length)
    throw new QuoteError("bad_input", "legs and marginals length mismatch");
  if (legs.length < 2) throw new QuoteError("too_few_legs", "a parlay needs at least 2 legs");
  if (legs.length > 10) throw new QuoteError("too_many_legs", "a parlay allows at most 10 legs");
  const sides = new Map<string, Set<string>>();
  for (const l of legs) {
    const s = sides.get(l.ticker) ?? new Set<string>();
    if (s.size > 0) {
      if (s.has(l.side)) throw new QuoteError("duplicate_market", `duplicate market ${l.ticker}`);
      throw new QuoteError("same_market_both_sides", `market ${l.ticker} on both sides`);
    }
    s.add(l.side);
    sides.set(l.ticker, s);
  }
  for (const m of marginals) {
    if (!Number.isFinite(m) || m <= 0 || m >= 1)
      throw new QuoteError("bad_marginal", `marginal out of range: ${m}`);
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const toPriceC = (q: number) => Math.max(1, Math.min(99, Math.round(q * 100)));
const mcPairsFor = (m: number) => (m >= 6 ? 800_000 : 200_000);

// Price a reduced set of representative legs through the copula. `rho` is the reduced m x m
// matrix aligned with `reps` (raw statistical bucket values). Canonicalizes by the reps' keys
// (permutation-invariant), PSD-repairs, prices with the frozen seed, and Frechet-clamps. This is
// the SINGLE pricing path shared by quoteParlay and settlement's priceFrozenSubset, so a quote
// and its later reprice can never disagree.
function priceReduced(
  reps: ClassifiedLeg[],
  marginals: number[],
  rho: Matrix,
  seed: string,
  mcPairs?: number,
): { q: number; stderr: number; method: "exact" | "mc" } {
  const m = reps.length;
  if (m === 0) return { q: 1, stderr: 0, method: "exact" };
  if (m === 1) return { q: clamp01(marginals[0]), stderr: 0, method: "exact" };
  const order = reps.map((_, i) => i).sort((i, j) => legKey(reps[i]).localeCompare(legKey(reps[j])));
  const cMarg = order.map((i) => marginals[i]);
  const raw: Matrix = order.map((oa) => order.map((ob) => (oa === ob ? 1 : rho[oa][ob])));
  const { matrix } = nearestPSD(raw);
  const { q: rawQ, stderr, method } = jointProbability(cMarg, matrix, seed, mcPairs ?? mcPairsFor(m));
  const minMarg = Math.min(...cMarg);
  const lower = Math.max(0, cMarg.reduce((a, b) => a + b, 0) - (m - 1));
  let q = rawQ;
  if (q > minMarg + 1e-9) q = minMarg;
  if (q < lower - 1e-9) q = lower;
  return { q: clamp01(q), stderr, method };
}

export function quoteParlay(
  legs: ClassifiedLeg[],
  marginals: number[],
  opts: QuoteOptions = {},
): QuoteResult {
  validate(legs, marginals);
  const table = opts.table ?? defaultTable();
  const modelVersion = opts.modelVersion ?? "copula-1";
  const n = legs.length;
  const warnings: string[] = [];
  const seed = seedFor(legs);

  // Logic layer: collapse structurally related legs to exact interval probabilities and reject
  // logically impossible combos before the copula ever runs (Fix 2 + Fix 4). The copula then
  // prices only the reduced set, whose members have genuinely statistical dependence.
  const red = reduceParlay(legs, marginals);
  if (!red.ok) throw new QuoteError(red.code, "these legs cannot all win");

  // Price the reduced set through the shared copula path. The reduced rho is the raw statistical
  // bucket value for each representative pair (no logical overrides). n=1 (a single fully
  // determined family) returns its exact marginal.
  const reps = red.reduced.map((r) => r.rep);
  const rMarg = red.reduced.map((r) => r.marginal);
  const m = reps.length;
  const redRho: Matrix = Array.from({ length: m }, (_, i) =>
    Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)),
  );
  let missing = 0;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const res = rhoFor(reps[i], reps[j], table);
      redRho[i][j] = res.rho;
      redRho[j][i] = res.rho;
      if (res.source === "none") missing++;
    }
  }
  const { q: fair_q, stderr, method } = priceReduced(reps, rMarg, redRho, seed, opts.mcPairs);

  // Reject sub-half-cent longshots outright (Fix 4): they would only ever display as the
  // rounded-up 1c floor, which fleeces the buyer. Deliberately not purchasable.
  if (fair_q < LONGSHOT_Q)
    throw new QuoteError("longshot_floor", "these legs are too unlikely to price above the floor");

  const independent_q = marginals.reduce((a, b) => a * b, 1);
  const price_c = toPriceC(fair_q);

  // Snapshot rho: the PURELY STATISTICAL matrix over all ORIGINAL legs (sign-adjusted bucket
  // values, no logical overrides, no propagation). The logical structure (families, ladders,
  // implications) is recomputed from the tickers at settlement via priceFrozenSubset, so the
  // stored matrix cannot disagree with the quoted price the way a baked-in +/-0.999 matrix did.
  const rho: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = rhoFor(legs[i], legs[j], table).rho;
      rho[i][j] = r;
      rho[j][i] = r;
    }
  }

  // Warnings that are behaviour, not silent fallbacks.
  if (legs.some((l) => l.type === "unknown"))
    warnings.push("A leg has an unrecognized market type; it is priced as independent.");
  if (missing > 0)
    warnings.push(`${missing} leg pair(s) had no correlation entry; priced as independent.`);
  if (method === "mc" && stderr > MC_STDERR_WARN)
    warnings.push("Monte Carlo estimate has a wide interval; price may move on re-quote.");

  // Tail dependence: the Gaussian copula underprices long same-game same-direction stacks.
  const perGame = new Map<string, number>();
  for (const l of legs) {
    if (!l.gameKey) continue;
    perGame.set(l.gameKey, (perGame.get(l.gameKey) ?? 0) + 1);
  }
  if ([...perGame.values()].some((c) => c >= 5))
    warnings.push("5+ legs share a game; a Gaussian copula underprices deep same-game stacks.");

  return {
    fair_q,
    independent_q,
    price_c,
    rho,
    seed,
    corr_version: table.version,
    model_version: modelVersion,
    warnings,
    mc_stderr: method === "mc" ? stderr : undefined,
  };
}

// Settlement entry point: reprice a (surviving) subset of a stored parlay through the SAME model
// that quoted it. Classifies the subset from its tickers, reruns the logic layer (families,
// implications, contradictions), and prices the reduced set with the FROZEN statistical rho
// submatrix (aligned via legsOrder) and the frozen seed. A contradictory subset prices to 0; an
// all-zero/absent rho reduces to the exact independence product (stub-era rows settle
// byte-identically). This is what makes the settlement basis match the quote exactly.
export function priceFrozenSubset(
  legs: { ticker: string; side: Side }[],
  marginals: number[],
  rho: Matrix,
  legsOrder: string[],
  seed: string,
): { q: number; price_c: number } {
  const classified = legs.map((l) => classifyLeg(l.ticker, l.side));
  const red = reduceParlay(classified, marginals);
  if (!red.ok) return { q: 0, price_c: 1 }; // a contradictory subset can never pay
  const reps = red.reduced.map((r) => r.rep);
  const rMarg = red.reduced.map((r) => r.marginal);
  const m = reps.length;
  const idx = new Map(legsOrder.map((t, i) => [t, i]));
  const redRho: Matrix = Array.from({ length: m }, (_, i) =>
    Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)),
  );
  let anyNonZero = false;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const a = idx.get(reps[i].ticker);
      const b = idx.get(reps[j].ticker);
      const r = a != null && b != null ? rho?.[a]?.[b] ?? 0 : 0;
      if (r !== 0) anyNonZero = true;
      redRho[i][j] = r;
      redRho[j][i] = r;
    }
  }
  if (!anyNonZero) {
    const q = clamp01(rMarg.reduce((acc, x) => acc * x, 1));
    return { q, price_c: toPriceC(q) };
  }
  const { q } = priceReduced(reps, rMarg, redRho, seed);
  return { q, price_c: toPriceC(q) };
}
