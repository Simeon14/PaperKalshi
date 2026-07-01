// Category board (event cards), ported from kalshi_live.py. Server-side only.
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  LiveMarket,
  Outcome,
  isTradeable,
  toLive,
  toOutcome,
  yesMidC,
} from "@/lib/kalshi/market";
import {
  getMarketRaw,
  getMarketsRaw,
  listEventsRaw,
  listSeriesRaw,
} from "@/lib/kalshi/client";
import { isMlbTicker, mlbMatchup } from "@/lib/kalshi/mlb";

// Cards carry every priced outcome so the client can list them all (the "+N more" menu);
// the display only renders the first few inline. Large enough for any real event's field.
const MAX_OUTCOMES = 100;

export interface Category {
  key: string;
  label: string;
}

interface CategoryCfg {
  key: string;
  label: string;
  source: "series" | "trending";
  series?: string[];
  category?: string;
  series_prefix?: string;
  exclude_tags?: string[];
  series_scan?: number;
  max_series?: number;
  group_by_match?: boolean; // group a match's many market-type events into one match card
  ttl: number;
}

export interface Card {
  id: string;
  title: string;
  vol: number;
  market_count: number; // grouped cards: number of markets (market types); else outcomes
  close_time: string;
  outcomes: Outcome[]; // grouped cards: every market's outcomes, ordered by group then odds,
  //                      each tagged with `group`; the first group is the primary (match odds)
  grouped?: boolean; // a match card: card body opens the full-markets popup, inline shows primary
}

const CATEGORIES: CategoryCfg[] = [
  {
    key: "worldcup", label: "World Cup", source: "series",
    // Curated set of the primary, high-volume soccer markets. There are ~109 KXWC* series and
    // Kalshi returns them in a DIFFERENT random order on every call, so the old "scan + take the
    // first 18" made the board fetch a different set of markets each refresh (hence it reshuffled
    // constantly and was never really sorted). Explicit series make the board deterministic and
    // stable, and avoid false-positive prefix matches ("West Coast Conference", esports "Warzone").
    series: [
      "KXWCADVANCE", "KXWCROUND", "KXWCSPREAD", "KXWCGAME", "KXWCTOTAL",
      "KXWCSCORE", "KXWC1H", "KXWCBTTS", "KXWCTEAMTOTAL", "KXWC1HTOTAL",
      "KXWCCORNERS", "KXWCTCORNERS", "KXWC1HSPREAD", "KXWCSOA", "KXWC1HSCORE",
      "KXWCFTTS", "KXWCSTAGEOFELIM",
    ],
    group_by_match: true,
    ttl: 45,
  },
  { key: "mlb", label: "MLB", source: "series", series: ["KXMLBGAME"], ttl: 8 },
  { key: "elections", label: "Elections", source: "trending", category: "Elections", ttl: 60 },
  { key: "politics", label: "Politics", source: "trending", category: "Politics", ttl: 60 },
  { key: "finance", label: "Finance", source: "trending", category: "Financials", ttl: 60 },
  { key: "tech", label: "Tech & Science", source: "trending", category: "Science and Technology", ttl: 60 },
  {
    key: "mentions", label: "Mentions", source: "series", series: ["KXMLBMENTION"],
    category: "Mentions", series_scan: 80, max_series: 12, ttl: 90,
  },
];

const CATEGORY_BY_KEY: Record<string, CategoryCfg> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c]),
);

export const CATEGORY_LIST: Category[] = CATEGORIES.map((c) => ({ key: c.key, label: c.label }));

// Run `fn` over `items` with at most `limit` in flight (mirrors the Python ThreadPoolExecutor).
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

// A market is BUYABLE when it's active with a live YES mid in 1..99 (a real price you can trade
// at). The board only ever lists buyable outcomes; non-tradeable ones (no real offer on the
// book, only a stale last price) are dropped entirely rather than shown greyed.
function isBuyable(m: LiveMarket): boolean {
  const mid = yesMidC(m);
  return isTradeable(m) && mid != null && mid >= 1 && mid <= 99;
}
// Highest YES odds first (every listed outcome is buyable, so yesMidC is a real 1..99 price).
const oddsKey = (m: LiveMarket): number => yesMidC(m) ?? 0;
const minCloseTime = (markets: LiveMarket[]): string => {
  const times = markets.map((m) => m.close_time).filter(Boolean).sort();
  return times.length ? times[0] : "";
};
// Fetch a series' open events WITH their nested markets in one call. Unlike /markets, the
// event carries a human title ("France vs Sweden: ...", "San Diego vs Los Angeles D") which
// is what names the card, so every card says which game/match it's for.
async function eventsForSeries(series: string, ttl: number): Promise<any[]> {
  try {
    const payload = await listEventsRaw(
      { series_ticker: series, status: "open", with_nested_markets: true, limit: 200 },
      { revalidate: ttl },
    );
    return payload.events ?? [];
  } catch {
    return []; // one bad series shouldn't sink the board
  }
}

async function seriesFor(cfg: CategoryCfg): Promise<string[]> {
  const out: string[] = [...(cfg.series ?? [])];
  if (cfg.category) {
    try {
      const payload = await listSeriesRaw(cfg.category, cfg.series_scan ?? 200);
      const exclude = new Set(cfg.exclude_tags ?? []);
      for (const s of payload.series ?? []) {
        const ticker: string = s.ticker ?? "";
        if (cfg.series_prefix && !ticker.startsWith(cfg.series_prefix)) continue;
        const tags: string[] = s.tags ?? [];
        if (exclude.size && tags.some((t) => exclude.has(t))) continue;
        out.push(ticker);
      }
    } catch {
      /* ignore a failed series scan */
    }
  }
  const seen = new Set<string>();
  const uniq = out.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  // Sort so the selected series are the SAME on every call (Kalshi's series order is not stable);
  // otherwise a capped scan picks a different subset each refresh and the board churns.
  uniq.sort();
  return uniq.slice(0, cfg.max_series ?? 40);
}

async function fetchSeriesCards(key: string): Promise<Card[]> {
  const cfg = CATEGORY_BY_KEY[key] ?? CATEGORY_BY_KEY["mlb"];
  const series = await seriesFor(cfg);
  if (!series.length) return [];
  const lists = await mapLimit(series, 6, (s) => eventsForSeries(s, cfg.ttl));
  const events = lists.flat();
  if (cfg.group_by_match) return matchCardsFromEvents(events);
  const cards = events.map(cardFromEvent).filter((c): c is Card => c !== null);
  cards.sort((a, b) => b.vol - a.vol);
  return cards.slice(0, 36);
}

// Clean, short labels for each World Cup market type (keyed by the event ticker's series prefix).
// Falls back to the event title after its "Match: " prefix, then the raw title.
const WC_TYPE: Record<string, string> = {
  KXWCGAME: "Moneyline",
  KXWCADVANCE: "To Advance",
  KXWCSPREAD: "Spread",
  KXWCTOTAL: "Total Goals",
  KXWCSCORE: "Correct Score",
  KXWCBTTS: "Both Teams to Score",
  KXWCTEAMTOTAL: "Team Total Goals",
  KXWC1H: "1st Half Result",
  KXWC1HTOTAL: "1st Half Total Goals",
  KXWC1HSCORE: "1st Half Correct Score",
  KXWC1HSPREAD: "1st Half Spread",
  KXWCCORNERS: "Corners",
  KXWCTCORNERS: "Team Corners",
  KXWCSOA: "Score or Assist",
  KXWCFTTS: "First Team to Score",
  KXWCROUND: "Reach Round",
  KXWCSTAGEOFELIM: "Stage of Elimination",
};

function marketTypeLabel(ev: any): string {
  const prefix = String(ev.event_ticker ?? "").split("-")[0];
  if (WC_TYPE[prefix]) return WC_TYPE[prefix];
  const title = String(ev.title ?? "");
  const i = title.indexOf(": ");
  return (i >= 0 ? title.slice(i + 2) : title).trim() || "Market";
}

// Group a category's events into one card PER MATCH. Every event ticker is
// "<SERIES>-<date><teams>" (e.g. KXWCTOTAL-26JUL01ENGCOD), so the suffix after the first "-" is
// the match key; all market types for the same match share it. The card lists every market's
// outcomes (tagged with `group`, ordered by market volume then odds); the first group is the
// primary market (the match odds) that the client shows inline, and the whole card opens a popup.
function matchCardsFromEvents(events: any[], maxCards = 40): Card[] {
  const byMatch = new Map<string, any[]>();
  for (const ev of events) {
    const et = String(ev.event_ticker ?? "");
    const dash = et.indexOf("-");
    const key = dash >= 0 ? et.slice(dash + 1) : et;
    (byMatch.get(key) ?? byMatch.set(key, []).get(key)!).push(ev);
  }

  const cards: Card[] = [];
  for (const [key, evs] of byMatch) {
    const groups: { label: string; vol: number; outcomes: Outcome[] }[] = [];
    for (const ev of evs) {
      const markets = ((ev.markets ?? []) as any[]).map(toLive).filter(isBuyable);
      if (!markets.length) continue;
      markets.sort((a, b) => oddsKey(b) - oddsKey(a));
      groups.push({
        label: marketTypeLabel(ev),
        vol: Math.max(0, ...markets.map((m) => m.volume)),
        outcomes: markets.slice(0, MAX_OUTCOMES).map(toOutcome),
      });
    }
    if (!groups.length) continue;
    groups.sort((a, b) => b.vol - a.vol); // primary (highest-volume) market first
    const outcomes = groups.flatMap((g) => g.outcomes.map((o) => ({ ...o, group: g.label })));
    const titleSrc =
      evs.map((e) => String(e.title ?? "")).find((t) => t.includes(" vs ")) ??
      String(evs[0].title ?? "");
    const title = titleSrc.includes(" vs ") ? titleSrc.split(": ")[0].trim() : titleSrc.trim();
    const closeTimes = evs
      .flatMap((e) => ((e.markets ?? []) as any[]).map((m) => m.close_time as string))
      .filter(Boolean)
      .sort();
    cards.push({
      id: "WCM-" + key,
      title: title || key,
      vol: Math.max(0, ...groups.map((g) => g.vol)),
      market_count: groups.length,
      close_time: closeTimes[0] ?? "",
      outcomes,
      grouped: true,
    });
  }
  cards.sort((a, b) => b.vol - a.vol);
  return cards.slice(0, maxCards);
}

async function fetchTrendingEvents(pages = 4): Promise<any[]> {
  const events: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const payload = await listEventsRaw(
      { status: "open", with_nested_markets: true, limit: 200, cursor },
      { revalidate: 90 },
    );
    events.push(...(payload.events ?? []));
    cursor = payload.cursor || undefined;
    if (!cursor) break;
  }
  return events;
}

function cardFromEvent(ev: any): Card | null {
  // Only buyable markets make the card; a card whose every outcome is non-tradeable is dropped.
  const markets: LiveMarket[] = (ev.markets ?? []).map(toLive).filter(isBuyable);
  if (!markets.length) return null;
  const ordered = [...markets].sort((a, b) => oddsKey(b) - oddsKey(a));
  const evTicker = ev.event_ticker ?? "";
  const rawTitle = String(ev.title ?? markets[0].matchup).replace(" Winner?", "").trim();
  const title = isMlbTicker(evTicker) ? mlbMatchup(rawTitle) : rawTitle;
  return {
    id: evTicker,
    title,
    vol: Math.max(0, ...markets.map((m) => m.volume)),
    market_count: markets.length,
    close_time: minCloseTime(markets),
    outcomes: ordered.slice(0, MAX_OUTCOMES).map(toOutcome),
  };
}

function cardsFromEvents(events: any[], category: string, maxCards = 36): Card[] {
  const cards = events
    .filter((e) => e.category === category)
    .map(cardFromEvent)
    .filter((c): c is Card => c !== null);
  cards.sort((a, b) => b.vol - a.vol);
  return cards.slice(0, maxCards);
}

// A single market with a fresh quote (used at order execution / settlement check).
export async function fetchMarket(ticker: string, fresh = false): Promise<LiveMarket> {
  return toLive(await getMarketRaw(ticker, fresh));
}

// Fresh quotes for a specific set of tickers in ONE Kalshi call. Powers the fast,
// viewport-scoped price refresh: cost is a single request no matter how many markets are
// visible. `fresh` bypasses the cache for the buy-ticket's continuous poll; otherwise a 1s
// revalidate lets concurrent viewers of the same set share the call.
export async function fetchQuotes(tickers: string[], fresh = false): Promise<Record<string, Outcome>> {
  const uniq = Array.from(new Set(tickers.filter(Boolean))).slice(0, 50);
  if (!uniq.length) return {};
  const payload = await getMarketsRaw(
    { tickers: uniq.join(","), limit: uniq.length },
    fresh ? { noStore: true } : { revalidate: 1 },
  );
  const out: Record<string, Outcome> = {};
  for (const m of payload.markets ?? []) {
    const live = toLive(m);
    if (live.ticker) out[live.ticker] = toOutcome(live);
  }
  return out;
}

// Assembled-board cache: hand back the identical set of cards for a category for its ttl window.
// This is what keeps the board STABLE across the client's periodic structure refetch (same set
// in, same order out, no reshuffle) and avoids re-fanning-out to Kalshi on every request. Prices
// are not stale in practice: the client patches them from the separate /api/quotes poll (~1.5s).
const boardCache = new Map<string, { at: number; cards: Card[] }>();

// Event cards for a category tab.
export async function cardsForCategory(key: string): Promise<Card[]> {
  const cfg = CATEGORY_BY_KEY[key] ?? CATEGORY_BY_KEY["mlb"];
  const now = Date.now();
  const hit = boardCache.get(key);
  if (hit && now - hit.at < cfg.ttl * 1000) return hit.cards;
  const cards =
    cfg.source === "trending"
      ? cardsFromEvents(await fetchTrendingEvents(), cfg.category ?? "")
      : await fetchSeriesCards(key);
  if (cards.length) boardCache.set(key, { at: now, cards }); // don't pin a transient empty fetch
  return cards;
}
