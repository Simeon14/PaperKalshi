// Pure board-state helpers for the trading terminal. The client holds one BoardCard[] that
// two writers race over: the fast /api/quotes patch (fresh prices, every ~1.5s) and the slow
// /api/markets structure refetch (fresh membership/volumes, but served from a server cache
// that can be older than the latest patched prices). These helpers keep both honest while
// preserving object identity wherever nothing changed, so React re-renders only real changes.

import type { Card } from "@/lib/kalshi/board";
import type { Outcome } from "@/lib/kalshi/market";
import { eventStart } from "@/lib/kalshi/eventTime";

// An outcome as the board holds it client-side: the server shape plus the timestamp of the
// last live quote patch, used to decide which side is fresher when a structure refresh merges.
export type BoardOutcome = Outcome & { _at?: number };
export type BoardCard = Omit<Card, "outcomes"> & { outcomes: BoardOutcome[] };
export type SortBy = "vol" | "date";

const QUOTE_FIELDS = [
  "yes_bid_c",
  "yes_ask_c",
  "no_bid_c",
  "no_ask_c",
  "last_c",
  "yes_mid_c",
  "no_mid_c",
  "tradeable",
  "close_time",
] as const;

function sameQuote(a: Outcome, b: Outcome): boolean {
  return QUOTE_FIELDS.every((f) => a[f] === b[f]);
}

function sameCardShell(a: BoardCard, b: BoardCard): boolean {
  return (
    a.title === b.title &&
    a.vol === b.vol &&
    a.market_count === b.market_count &&
    a.close_time === b.close_time &&
    a.start_time === b.start_time &&
    a.grouped === b.grouped
  );
}

// A grouped card for an actual head-to-head match (title "X vs Y"), as opposed to a futures /
// season-long market ("Will Spain qualify...", "Stage of Elimination"). Real matches always sort
// ahead of everything else (e.g. World Cup lists the games before the tournament futures), in
// both Vol and Date modes. Flat categories have no grouped cards, so this is a no-op for them.
const isMatch = (c: BoardCard) => !!c.grouped && c.title.includes(" vs ");

// Deterministic ordering (ties broken by id). Applied to establish the board's order on first
// load / category switch / sort toggle, and to place newly-appeared cards among themselves.
// It is NOT re-run on every refresh: once the board is shown its order is frozen, so live
// volume/price changes don't reshuffle it (see mergeBoards).
export function sortCards(cards: BoardCard[], sortBy: SortBy): BoardCard[] {
  const byId = (a: BoardCard, b: BoardCard) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const rank = (c: BoardCard) => (isMatch(c) ? 0 : 1); // matches first
  const cs = [...cards];
  if (sortBy === "date") {
    cs.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const ta = eventStart(a.id, a.close_time, a.start_time).ts;
      const tb = eventStart(b.id, b.close_time, b.start_time).ts;
      return ta !== tb ? ta - tb : byId(a, b);
    });
  } else {
    cs.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return b.vol !== a.vol ? b.vol - a.vol : byId(a, b);
    });
  }
  return cs;
}

// Merge a quote batch into the board, cloning ONLY what actually changed: an untouched card
// keeps its object identity, and when nothing changed at all the input array itself comes
// back so no state update (and no render) happens.
export function patchOutcomes(
  cards: BoardCard[],
  quotes: Record<string, Outcome>,
  now: number,
): BoardCard[] {
  let boardChanged = false;
  const next = cards.map((c) => {
    let cardChanged = false;
    const outcomes = c.outcomes.map((o) => {
      const q = quotes[o.ticker];
      if (!q || sameQuote(o, q)) return o;
      cardChanged = true;
      return { ...o, ...q, _at: now }; // quotes carry no `group`, so the label survives the spread
    });
    if (!cardChanged) return c;
    boardChanged = true;
    return { ...c, outcomes };
  });
  return boardChanged ? next : cards;
}

// The periodic structure refetch: surviving cards keep their on-screen position (the board's
// order is deliberately frozen after load) but ADOPT the fresh card data, so volumes, market
// counts, dates, and newly listed markets actually update. New cards are sorted among
// themselves and appended at the bottom; closed cards drop out.
//
// Per outcome, the freshest data wins: an outcome live-patched AFTER the incoming board was
// assembled (_at > bornAt) keeps its patched object, one whose values already match keeps its
// identity, and everything else takes the fresh copy.
export function mergeBoards(
  prev: BoardCard[],
  api: BoardCard[],
  bornAt: number,
  sortBy: SortBy,
): BoardCard[] {
  if (!prev.length) return sortCards(api, sortBy);
  const prevIds = new Set(prev.map((c) => c.id));
  const apiById = new Map(api.map((c) => [c.id, c]));
  const kept: BoardCard[] = [];
  for (const old of prev) {
    const fresh = apiById.get(old.id);
    if (!fresh) continue; // closed / dropped
    const oldByTicker = new Map(old.outcomes.map((o) => [o.ticker, o]));
    let identical = old.outcomes.length === fresh.outcomes.length;
    const outcomes = fresh.outcomes.map((f, i) => {
      const o = oldByTicker.get(f.ticker);
      const pick = o && ((o._at ?? 0) > bornAt || sameQuote(o, f)) ? o : f;
      if (identical && pick !== old.outcomes[i]) identical = false;
      return pick;
    });
    kept.push(identical && sameCardShell(old, fresh) ? old : { ...fresh, outcomes });
  }
  const added = sortCards(
    api.filter((c) => !prevIds.has(c.id)),
    sortBy,
  );
  return [...kept, ...added];
}
