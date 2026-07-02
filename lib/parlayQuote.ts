// Shared parlay quote assembly for /api/parlay/quote and /api/parlay/trade. Both routes fetch
// their own markets (the quote route from the shared 1s cache, the trade route no-store) and
// normalize them into LegMarket[]; this module does the identical validate -> classify -> price
// -> snapshot work so the two routes can never diverge on how a parlay is priced.
//
// Pure of Next/fetch (it only imports classify, the engine stub, and the label map), so it is
// unit-testable directly against the hand-computed independence product.

import { classifyLeg } from "@/lib/parlay/classify";
import type { ClassifiedLeg } from "@/lib/parlay/types";
import { quoteParlay } from "@/lib/parlayEngine";
import { mlbGroupLabel } from "@/lib/mlbGroups";
import type { Leg, ParlayQuoteResponse, ParlaySnapshot, QuoteLeg, Side } from "@/lib/parlayTypes";

export type Mode = "default" | "realistic";

// A leg joined to its live market, normalized so both the Outcome (quote route) and the
// LiveMarket (trade route) feed the same fields.
export interface LegMarket {
  ticker: string;
  side: Side;
  yesBidC: number | null;
  noBidC: number | null;
  yesMidC: number | null;
  noMidC: number | null;
  yesAskC: number | null;
  noAskC: number | null;
  team: string;
  matchup: string;
  group?: string; // board-derived market-type label (e.g. "Correct Score"); falls back to MLB_TYPE
  tradeable: boolean; // active + not resolved + a live YES offer
}

// Widest bid-ask (cents) on a leg's traded side we will price into a parlay. A dead book quotes
// one-sided (bid 0-5 / ask 97-98), so its ~49c mid is a fantasy marginal; a live main-line MLB
// book runs 1-3c and even a thin-but-real one stays well inside 20c. The constant only needs to
// separate a real two-sided book from a junk one, so the exact value is not sensitive.
const MAX_SPREAD_C = 20;

export interface BuiltQuote {
  quote: ParlayQuoteResponse;
  snapshot: ParlaySnapshot;
}

export type BuildResult =
  | { ok: true; built: BuiltQuote }
  | { ok: false; invalid: string[] }; // tickers that are not buyable (client prunes + re-quotes)

// Parse and validate the raw legs array from a request body (overview contract 3): each leg is
// { ticker, side }, 2..10 legs after de-duplication, and the same market on both sides is
// rejected. Returns a typed error the route maps straight to a 400/422.
export function normalizeLegs(
  raw: unknown,
): { ok: true; legs: Leg[] } | { ok: false; error: string; status: number } {
  if (!Array.isArray(raw)) return { ok: false, error: "legs must be an array", status: 422 };
  const seen = new Set<string>(); // ticker:side, drops exact-duplicate legs
  const perTicker = new Set<string>(); // ticker, catches the same market on both sides
  const legs: Leg[] = [];
  for (const item of raw) {
    const ticker = String((item as { ticker?: unknown })?.ticker ?? "");
    const side = String((item as { side?: unknown })?.side ?? "") as Side;
    if (!ticker || (side !== "yes" && side !== "no")) {
      return { ok: false, error: "each leg needs a ticker and a yes/no side", status: 422 };
    }
    const key = ticker + ":" + side;
    if (seen.has(key)) continue; // duplicate leg: dedupe silently
    if (perTicker.has(ticker)) {
      return { ok: false, error: "a parlay cannot take both sides of the same market", status: 400 };
    }
    seen.add(key);
    perTicker.add(ticker);
    legs.push({ ticker, side });
  }
  if (legs.length < 2) return { ok: false, error: "a parlay needs at least 2 legs", status: 400 };
  if (legs.length > 10) return { ok: false, error: "a parlay can have at most 10 legs", status: 400 };
  return { ok: true, legs };
}

// The mode-selected marginal (cents) for a leg's side: its live mid in the default perfect-
// liquidity mode, its executable ask in realistic mode (buying a leg lifts that side's ask).
function marginalC(lm: LegMarket, mode: Mode): number | null {
  if (mode === "realistic") return lm.side === "yes" ? lm.yesAskC : lm.noAskC;
  return lm.side === "yes" ? lm.yesMidC : lm.noMidC;
}

function midC(lm: LegMarket): number | null {
  return lm.side === "yes" ? lm.yesMidC : lm.noMidC;
}
function execC(lm: LegMarket): number | null {
  return lm.side === "yes" ? lm.yesAskC : lm.noAskC;
}

// Price a fully-resolved set of legs (leg + its live market, in leg order) into the quote
// response + the frozen snapshot, or report which tickers are not buyable so the caller can 400.
export function buildParlayQuote(legMarkets: LegMarket[], mode: Mode): BuildResult {
  const invalid: string[] = [];
  const classified: ClassifiedLeg[] = [];
  const marginals: number[] = [];
  const qlegs: QuoteLeg[] = [];
  const snapshotMarginals: Record<string, number> = {};

  for (const lm of legMarkets) {
    const mid = midC(lm);
    const exec = execC(lm);
    const marginal = marginalC(lm, mode);
    // Liquidity guard (Fix 3): the traded side must have a real two-sided book, else its mid is a
    // fantasy marginal (a dead 0/98 book mids to ~49c and would enter the parlay as a coin flip).
    const bid = lm.side === "yes" ? lm.yesBidC : lm.noBidC;
    const ask = lm.side === "yes" ? lm.yesAskC : lm.noAskC;
    const twoSided =
      bid != null && ask != null && bid >= 1 && ask <= 99 && ask - bid <= MAX_SPREAD_C;
    // Buyable = active, not resolved, a real mid in 1..99, a real two-sided book, and (in
    // realistic mode) a real ask.
    const buyable =
      lm.tradeable &&
      mid != null &&
      mid >= 1 &&
      mid <= 99 &&
      marginal != null &&
      marginal >= 1 &&
      marginal <= 99 &&
      twoSided;
    if (!buyable) {
      invalid.push(lm.ticker);
      continue;
    }
    const cl = classifyLeg(lm.ticker, lm.side);
    const q = marginal / 100;
    classified.push(cl);
    marginals.push(q);
    snapshotMarginals[lm.ticker] = q;
    qlegs.push({
      ticker: lm.ticker,
      side: lm.side,
      type: cl.type,
      team: lm.team,
      matchup: lm.matchup,
      group: lm.group || mlbGroupLabel(lm.ticker),
      mid_c: mid,
      exec_c: exec,
    });
  }

  if (invalid.length) return { ok: false, invalid };

  const result = quoteParlay(classified, marginals);
  // The engine's warnings surface in the builder UI, minus two that are not user-actionable:
  // the unknown-market-type note (non-MLB legs, e.g. World Cup, are deliberately priced as
  // independent for now) and the routine PSD-repair note (internal numerical detail).
  const HIDDEN = [/unrecognized market type/i, /PSD-repaired/i];
  const warnings = result.warnings.filter((w) => !HIDDEN.some((re) => re.test(w)));

  const legsOrder = legMarkets.map((lm) => lm.ticker);
  const quote: ParlayQuoteResponse = {
    legs: qlegs,
    price_c: result.price_c,
    fair_q: result.fair_q,
    independent_q: result.independent_q,
    corr_version: result.corr_version,
    model_version: result.model_version,
    seed: result.seed,
    warnings,
  };
  const snapshot: ParlaySnapshot = {
    marginals: snapshotMarginals,
    rho: result.rho,
    legs_order: legsOrder,
    corr_version: result.corr_version,
    model_version: result.model_version,
    mode,
    seed: result.seed,
  };
  return { ok: true, built: { quote, snapshot } };
}
