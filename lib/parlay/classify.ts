// Classify a Kalshi MLB market ticker into a ClassifiedLeg for the correlation engine.
// Ticker-only (no market object): the grammar and per-series mapping are documented in
// Parlay/reports/02-mlb-market-anatomy.md. Unknown prefixes return type "unknown" and are
// priced independent; this function never throws.

import { MLB_TEAM_CODES } from "@/lib/kalshi/mlb";
import type { ClassifiedLeg, Direction, LegType, Side } from "@/lib/parlay/types";

// Kalshi series prefix -> engine LegType.
const SERIES_TYPE: Record<string, LegType> = {
  KXMLBGAME: "ml",
  KXMLBSPREAD: "spread",
  KXMLBTOTAL: "total",
  KXMLBTEAMTOTAL: "team_total",
  KXMLBF3: "f3_ml",
  KXMLBF5: "f5_ml",
  KXMLBF5SPREAD: "f5_spread",
  KXMLBF5TOTAL: "f5_total",
  KXMLBF7: "f7_ml",
  KXMLBEXTRAS: "extras",
  KXMLBRFI: "rfi",
  KXMLBHIT: "p_hits",
  KXMLBHR: "p_hr",
  KXMLBHRR: "p_hrr",
  KXMLBKS: "p_ks",
  KXMLBRBI: "p_rbi",
  KXMLBSB: "p_sb",
  KXMLBTB: "p_tb",
  KXMLBOUTS: "p_outs",
  KXMLBNEXTHR: "p_hr", // provisional: in-game market, no open sample yet
};

// Series that carry a team code in the outcome suffix (team-scoped game legs).
const TEAM_SCOPED: ReadonlySet<LegType> = new Set<LegType>([
  "ml",
  "spread",
  "team_total",
  "f3_ml",
  "f5_ml",
  "f5_spread",
  "f7_ml",
]);

// The canonical YES direction of each type.
const DIRECTION: Record<LegType, Direction> = {
  ml: "team_win",
  f3_ml: "team_win",
  f5_ml: "team_win",
  f7_ml: "team_win",
  spread: "team_cover",
  f5_spread: "team_cover",
  total: "over",
  team_total: "over",
  f5_total: "over",
  rfi: "yes",
  extras: "extras",
  p_hits: "player_over",
  p_hr: "player_over",
  p_hrr: "player_over",
  p_ks: "player_over",
  p_rbi: "player_over",
  p_sb: "player_over",
  p_tb: "player_over",
  p_outs: "player_over",
  unknown: "unknown",
};

// Pseudo-teams that appear in a team-scoped suffix but reference no real club.
const PSEUDO_TEAMS: ReadonlySet<string> = new Set(["TIE", "EXTRAS"]);

// Types whose strike index sits in the team-or-index suffix (parts[2]: "LAD4", "3", ...).
const LINE_IN_SUFFIX2: ReadonlySet<LegType> = new Set<LegType>([
  "spread",
  "team_total",
  "f5_spread",
  "total",
  "f5_total",
]);

// Strip trailing digits from an outcome suffix ("LAD4" -> "LAD", "SD" -> "SD").
function teamFromSuffix(suffix: string): string {
  return suffix.replace(/\d+$/, "");
}

// The trailing integer of a suffix ("LAD4" -> 4, "3" -> 3, "SD" -> undefined).
function trailingInt(s: string): number | undefined {
  const m = s.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : undefined;
}

// Strike index N maps to line N - 0.5 (see Parlay/reports/02-mlb-market-anatomy.md): a total's
// "-3" is Over 2.5, a team's "-LAD4" is +3.5, a player's "-2" is 1.5+. Winner/binary types
// (ml, f3/f5/f7 winner, extras, rfi) carry no strike and get no line.
function lineFrom(strikeIndex: number | undefined): number | undefined {
  return strikeIndex === undefined ? undefined : strikeIndex - 0.5;
}

// Return the known team code that prefixes `token`, preferring the two codes in `pair` (the
// game's own teams) and falling back to the global 30-code table. Longest match wins.
function leadingTeamCode(token: string, pair: string[]): string {
  const candidates = [...pair, ...MLB_TEAM_CODES].sort((a, b) => b.length - a.length);
  for (const code of candidates) {
    if (code && token.startsWith(code)) return code;
  }
  return "";
}

// Split the concatenated team pair out of a game key ("26JUL022210SDLAD" -> ["SD","LAD"]).
export function teamPair(gameKey: string): string[] {
  const m = gameKey.match(/^\d{2}[A-Z]{3}\d{2}(?:\d{4})?([A-Z]+)$/);
  const letters = m ? m[1] : "";
  if (!letters) return [];
  const away = leadingTeamCode(letters, []);
  if (!away) return [];
  const home = letters.slice(away.length);
  return home ? [away, home] : [away];
}

export function classifyLeg(ticker: string, side: Side): ClassifiedLeg {
  const parts = (ticker || "").split("-");
  const series = parts[0] ?? "";
  const gameKey = parts[1] ?? "";
  const type = SERIES_TYPE[series] ?? "unknown";
  const canonical = side === "yes"; // YES is canonical for every known MLB series
  const base: ClassifiedLeg = {
    ticker,
    side,
    type,
    gameKey,
    direction: DIRECTION[type] ?? "unknown",
    canonical,
  };
  if (type === "unknown") return base;

  const pair = teamPair(gameKey);

  if (LINE_IN_SUFFIX2.has(type)) {
    base.line = lineFrom(trailingInt(parts[2] ?? ""));
  }

  if (TEAM_SCOPED.has(type)) {
    const team = teamFromSuffix(parts[2] ?? "");
    if (team && !PSEUDO_TEAMS.has(team)) base.teamRef = team;
    return base;
  }

  if (type === "p_hits" || type === "p_hr" || type === "p_hrr" || type === "p_ks" ||
      type === "p_rbi" || type === "p_sb" || type === "p_tb" || type === "p_outs") {
    const token = parts[2] ?? ""; // "<TEAM><PLAYER>"
    if (token) {
      base.playerRef = token;
      const team = leadingTeamCode(token, pair);
      if (team) base.teamRef = team;
    }
    base.line = lineFrom(trailingInt(parts[3] ?? "")); // strike index is the last segment
    return base;
  }

  // total / f5_total: line set above. rfi / extras: team-agnostic binary legs, no teamRef/line.
  return base;
}
