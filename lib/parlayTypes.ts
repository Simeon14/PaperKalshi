// Parlay view + wire types owned by the integration layer (plan 03). Client-safe: pure type
// declarations, no runtime, no server-only imports, so both the browser bundle (the builder UI)
// and the server (routes, lib/account.ts) import from here. LegType/Side come from the engine's
// shared contract (lib/parlay/types.ts); everything the UI and DB shape needs lives here.

import type { LegType, Side } from "@/lib/parlay/types";

export type { LegType, Side };

// The minimal client -> server leg: one Kalshi market taken on one side.
export interface Leg {
  ticker: string;
  side: Side;
}

// A leg enriched with everything the builder renders. Server-computed and returned by
// /api/parlay/quote (overview contract 3), and the shape stored in the parlays.legs jsonb.
export interface QuoteLeg {
  ticker: string;
  side: Side;
  type: LegType;
  team: string; // the team / subject a YES backs (display)
  matchup: string; // "Tigers vs Nationals" (display)
  group: string; // market-type label ("Moneyline", "Total Runs", ...) (display)
  mid_c: number; // the side's live mid in cents (1..99)
  exec_c: number | null; // the side's executable (ask) price in cents, if any
}

// The /api/parlay/quote response body (overview contract 3).
export interface ParlayQuoteResponse {
  legs: QuoteLeg[];
  price_c: number; // clamp(round(fair_q * 100), 1, 99)
  fair_q: number; // correlation-aware joint probability
  independent_q: number; // product of marginals (comparison baseline)
  corr_version: number;
  model_version: string;
  seed: string;
  warnings: string[];
}

// The immutable pricing snapshot frozen into a parlay row at placement. Settlement reprices void
// legs out of the parlay using exactly these frozen inputs, so the result is reproducible.
export interface ParlaySnapshot {
  marginals: Record<string, number>; // ticker -> entry marginal q (probability the side hits, 0..1)
  rho: number[][]; // the frozen STATISTICAL correlation layer only; logical structure (families,
  // ladders, implications) is recomputed from the tickers at settlement (priceFrozenSubset)
  legs_order: string[]; // ticker order aligning rho rows/cols
  corr_version: number;
  model_version: string;
  mode: "default" | "realistic";
  seed: string;
}

// Per-leg status while a parlay is open (derived live in getAccountState).
export type LegResult = "pending" | "won" | "lost" | "void";

// A leg as rendered inside an open-parlay row.
export interface ParlayLegState {
  ticker: string;
  side: Side;
  type: LegType;
  team: string;
  matchup: string;
  group: string;
  mid_c: number; // entry mid (from the stored leg)
  status: LegResult;
}

// An open parlay marked to market, returned inside AccountState.
export interface ParlayState {
  id: string;
  created_ts: number;
  count: number;
  price_c: number; // entry price per ticket
  cost: number; // dollars paid
  status: string; // "open" (settled parlays leave this list and surface via fills)
  value: number; // marked value, dollars
  unrealized: number; // value - cost, dollars
  potential_payout: number; // dollars if it wins (void-adjusted)
  legs: ParlayLegState[];
}
