// TEMPORARY parlay hold rules (added 2026-07-02, before the first parlay deploy).
//
// Until pricing models exist beyond MLB, a parlay may only be PLACED when every leg is
// either an MLB market (correlations modeled) or an independent World Cup pick: no two WC
// legs from the same match/event, and no two WC legs involving the same team. Anything else
// can still sit in the builder (and quote), but cannot be placed.
//
// Enforced server-side in /api/parlay/trade and mirrored in the builder UI from the same
// function. Deliberately conservative: a rare false positive (blocking a combinable pair)
// is fine for a temporary hold; a false negative sells a mispriced correlated parlay.
// DELETE this module when the World Cup / other-market models land.

export type ParlayHoldCode = "wc_correlated" | "unsupported_market";

export const PARLAY_HOLD_INFO: Record<ParlayHoldCode, { label: string; tip: string }> = {
  wc_correlated: {
    label: "Some legs can't be combined",
    tip:
      "These are correlated markets: they involve the same match or the same team, so " +
      "their outcomes move together. Correlated pricing is only supported for MLB so far, " +
      "so this parlay can't be placed. Remove the overlapping legs to place the rest.",
  },
  unsupported_market: {
    label: "Parlays aren't available for some legs",
    tip:
      "Parlays currently work for MLB markets and independent World Cup picks. Some of " +
      "these legs are from markets without parlay pricing yet, so this parlay can't be " +
      "placed. Remove them to place the rest.",
  },
};

// Outcome suffixes that name a result, not a team; never treated as a shared entity.
const PSEUDO = new Set(["TIE", "DRAW", "DRW", "YES", "NO"]);
const DATE_RE = /^\d{2}[A-Z]{3}\d{2}/; // 26JUL02

// Split a letters-only token into FIFA-style 3-letter team codes when it divides evenly
// ("ESPAUT" -> ESP, AUT), else keep it whole ("FINAL" -> FINAL).
function chunk3(token: string, into: Set<string>): void {
  if (!token) return;
  if (token.length % 3 === 0) {
    for (let i = 0; i < token.length; i += 3) {
      const t = token.slice(i, i + 3);
      if (!PSEUDO.has(t)) into.add(t);
    }
  } else if (!PSEUDO.has(token)) {
    into.add(token);
  }
}

// A WC leg's event key (match/futures grouping) and the team-ish entities it references,
// from both the event segment ("26JUL02ESPAUT" -> ESP, AUT; "26USA" -> USA) and the outcome
// suffix ("ESP2AUT0" -> ESP, AUT).
function wcParts(ticker: string): { eventKey: string; entities: Set<string> } {
  const parts = ticker.split("-");
  const eventKey = parts[1] ?? "";
  const entities = new Set<string>();
  chunk3(eventKey.replace(DATE_RE, "").replace(/^\d+/, "").replace(/\d+/g, ""), entities);
  chunk3((parts[2] ?? "").replace(/\d+/g, ""), entities);
  return { eventKey, entities };
}

// The hold codes for a would-be parlay. Empty array = placeable.
export function computeParlayHolds(tickers: string[]): ParlayHoldCode[] {
  const holds = new Set<ParlayHoldCode>();
  const wc: { eventKey: string; entities: Set<string> }[] = [];
  for (const t of tickers) {
    if (t.startsWith("KXMLB")) continue; // modeled; anything goes
    if (t.startsWith("KXWC")) {
      wc.push(wcParts(t));
      continue;
    }
    holds.add("unsupported_market");
  }
  outer: for (let i = 0; i < wc.length; i++) {
    for (let j = i + 1; j < wc.length; j++) {
      const sameEvent = wc[i].eventKey !== "" && wc[i].eventKey === wc[j].eventKey;
      const sharedTeam = [...wc[i].entities].some((e) => wc[j].entities.has(e));
      if (sameEvent || sharedTeam) {
        holds.add("wc_correlated");
        break outer;
      }
    }
  }
  return [...holds].sort();
}
