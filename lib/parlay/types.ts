// Shared contracts for the parlay pricing engine. These mirror the taxonomy and correlation
// table defined in Parlay/00-overview.md. Pure types, no runtime dependencies.

// A leg is one Kalshi market taken on one side.
export type Side = "yes" | "no";

// Game-scoped (score-derived) leg types + player-scoped types. `unknown` is a catch-all for
// series prefixes we do not recognize; those are priced independent (rho 0) with a warning.
export type LegType =
  // game-scoped
  | "ml"
  | "spread"
  | "total"
  | "team_total"
  | "f3_ml"
  | "f5_ml"
  | "f5_spread"
  | "f5_total"
  | "f7_ml"
  | "extras"
  | "rfi"
  // player-scoped
  | "p_hits"
  | "p_hr"
  | "p_hrr"
  | "p_ks"
  | "p_rbi"
  | "p_sb"
  | "p_tb"
  | "p_outs"
  // fallback
  | "unknown";

export const PLAYER_TYPES: ReadonlySet<LegType> = new Set<LegType>([
  "p_hits",
  "p_hr",
  "p_hrr",
  "p_ks",
  "p_rbi",
  "p_sb",
  "p_tb",
  "p_outs",
]);

export function isPlayerType(t: LegType): boolean {
  return PLAYER_TYPES.has(t);
}

// The correlation bucket key between two legs. `independent` is a resolved outcome (different
// games, or unknown types) and is never stored in the table.
export type Relation =
  | "same_team"
  | "opp_team"
  | "game"
  | "same_player"
  | "player_team"
  | "player_opp"
  | "player_player_same_team"
  | "player_player_opp"
  | "independent";

// The canonical event direction of a leg type (constant per type). A leg taken as side "no"
// flips its orientation away from canonical; see ClassifiedLeg.canonical.
export type Direction =
  | "team_win" // ml / f3_ml / f5_ml / f7_ml: referenced team wins the segment
  | "team_cover" // spread / f5_spread: referenced team wins by over the line
  | "over" // total / team_total / f5_total: runs over the line
  | "yes" // rfi: a run scores in the 1st
  | "extras" // extras: game goes to extra innings
  | "player_over" // player props: player reaches the threshold
  | "unknown";

// Output of classifyLeg. Ticker-only classification: `canonical` folds the side in (YES is
// the canonical direction for every known MLB series), so a "no" side sets canonical=false
// and negates every rho involving this leg.
export interface ClassifiedLeg {
  ticker: string;
  side: Side;
  type: LegType;
  gameKey: string; // date+time+teams, e.g. "26JUL022210SDLAD"; "" if unparseable
  teamRef?: string; // team code for team-scoped legs / player's team for player legs
  playerRef?: string; // "<TEAM><PLAYER>" key, unique within a game
  line?: number; // the strike as a threshold (X > line); undefined for winner/binary types
  direction: Direction; // the type's canonical direction label
  canonical: boolean; // true if this leg (given side) is in the canonical direction
}

export type CorrelationSource = "distilled" | "structural" | "historical" | "prior";

// One stored correlation. `a`/`b` are LegTypes sorted alphabetically; `rho` is for the
// canonical orientation of both legs under `relation`.
export interface CorrelationEntry {
  a: LegType;
  b: LegType;
  relation: Relation;
  rho: number;
  source: CorrelationSource;
  n?: number; // sample size (distilled/structural/historical)
  spread?: number; // rho's sensitivity across the marginal grid (informational)
  notes?: string;
}

export interface CorrelationTable {
  version: number;
  sport: string;
  updated: string;
  entries: CorrelationEntry[];
}

// Where a resolved rho came from. Adds resolution-only outcomes on top of the stored sources.
export type RhoSource = CorrelationSource | "independent" | "none";

export interface RhoResult {
  rho: number;
  source: RhoSource;
  relation: Relation;
  entry?: CorrelationEntry; // the winning stored entry, if any
}

export type Matrix = number[][];

export interface QuoteOptions {
  table?: CorrelationTable; // defaults to the bundled table
  mcPairs?: number; // antithetic pairs for n>=3 Monte Carlo; default 200_000
  modelVersion?: string; // default "copula-1"
}

export interface QuoteResult {
  fair_q: number; // correlation-aware joint probability, Frechet-clamped
  independent_q: number; // product of marginals
  price_c: number; // clamp(round(fair_q*100), 1, 99)
  rho: Matrix; // the PURELY STATISTICAL correlation matrix (sign-adjusted bucket values, no
  // logical overrides); logical structure is recomputed from the tickers at settlement
  seed: string; // deterministic seed for exact settlement repricing
  corr_version: number;
  model_version: string;
  warnings: string[];
  mc_stderr?: number; // Monte Carlo standard error (n>=3 only)
}
