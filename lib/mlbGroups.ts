// MLB market-type labels, keyed by Kalshi series prefix. Mirrors WC_TYPE in lib/kalshi/board.ts
// and the "group" column of Parlay/reports/02-mlb-market-anatomy.md. Pure and client-safe (no
// imports), so the board grouping (lib/kalshi/board.ts) and the parlay quote route can share one
// source of truth for these labels.

export const MLB_TYPE: Record<string, string> = {
  KXMLBGAME: "Moneyline",
  KXMLBSPREAD: "Run Spread",
  KXMLBTOTAL: "Total Runs",
  KXMLBTEAMTOTAL: "Team Total",
  KXMLBF3: "First 3 Innings",
  KXMLBF5: "First 5 Innings",
  KXMLBF5SPREAD: "First 5 Spread",
  KXMLBF5TOTAL: "First 5 Total",
  KXMLBF7: "First 7 Innings",
  KXMLBEXTRAS: "Extra Innings",
  KXMLBRFI: "Run in 1st Inning",
  KXMLBHIT: "Hits",
  KXMLBHR: "Home Runs",
  KXMLBHRR: "Hits+Runs+RBIs",
  KXMLBKS: "Strikeouts",
  KXMLBRBI: "RBIs",
  KXMLBSB: "Stolen Bases",
  KXMLBTB: "Total Bases",
  KXMLBOUTS: "Pitcher Outs",
  KXMLBNEXTHR: "Next Home Run",
};

// The clean market-type label for a ticker (or event ticker), from its series prefix. Unknown
// series (e.g. World Cup) return "" so callers can fall back to a board-derived group label
// instead of a meaningless literal "Market".
export function mlbGroupLabel(ticker: string): string {
  const series = (ticker || "").split("-")[0];
  return MLB_TYPE[series] ?? "";
}
