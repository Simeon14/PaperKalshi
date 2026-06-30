// Category board (event cards), ported from kalshi_live.py. Server-side only.
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  LiveMarket,
  Outcome,
  toLive,
  toOutcome,
} from "@/lib/kalshi/market";
import {
  getMarketRaw,
  getMarketsRaw,
  listEventsRaw,
  listSeriesRaw,
} from "@/lib/kalshi/client";

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
  ttl: number;
}

export interface Card {
  id: string;
  title: string;
  vol: number;
  market_count: number;
  close_time: string;
  outcomes: Outcome[];
}

const CATEGORIES: CategoryCfg[] = [
  { key: "mlb", label: "MLB", source: "series", series: ["KXMLBGAME"], ttl: 8 },
  {
    key: "worldcup", label: "World Cup", source: "series", category: "Sports",
    series_prefix: "KXWC", exclude_tags: ["Esports"], series_scan: 400, max_series: 18, ttl: 90,
  },
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

const askKey = (m: LiveMarket): number => m.yes_ask_c ?? m.last_c ?? -1;
const minCloseTime = (markets: LiveMarket[]): string => {
  const times = markets.map((m) => m.close_time).filter(Boolean).sort();
  return times.length ? times[0] : "";
};
const priced = (m: LiveMarket): boolean =>
  m.yes_ask_c !== null || m.yes_bid_c !== null || m.last_c !== null;

async function marketsForSeries(series: string, ttl: number): Promise<LiveMarket[]> {
  try {
    const payload = await getMarketsRaw(
      { series_ticker: series, status: "open", limit: 200 },
      { revalidate: ttl },
    );
    return (payload.markets ?? []).map(toLive);
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
  return uniq.slice(0, cfg.max_series ?? 30);
}

function cardsFromMarkets(markets: LiveMarket[], maxCards = 36, maxOutcomes = 6): Card[] {
  const byEvent = new Map<string, LiveMarket[]>();
  for (const m of markets) {
    const arr = byEvent.get(m.event_ticker) ?? [];
    arr.push(m);
    byEvent.set(m.event_ticker, arr);
  }
  const cards: Card[] = [];
  for (const [ev, mk] of byEvent) {
    const ordered = [...mk].sort((a, b) => askKey(b) - askKey(a));
    cards.push({
      id: ev,
      title: mk[0].matchup,
      vol: Math.max(0, ...mk.map((m) => m.volume)),
      market_count: mk.length,
      close_time: minCloseTime(mk),
      outcomes: ordered.slice(0, maxOutcomes).map(toOutcome),
    });
  }
  cards.sort((a, b) => b.vol - a.vol);
  return cards.slice(0, maxCards);
}

async function fetchSeriesCards(key: string): Promise<Card[]> {
  const cfg = CATEGORY_BY_KEY[key] ?? CATEGORY_BY_KEY["mlb"];
  const series = await seriesFor(cfg);
  let markets: LiveMarket[] = [];
  if (series.length) {
    const lists = await mapLimit(series, 6, (s) => marketsForSeries(s, cfg.ttl));
    markets = lists.flat();
  }
  return cardsFromMarkets(markets.filter(priced));
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
  const markets: LiveMarket[] = (ev.markets ?? []).map(toLive).filter(priced);
  if (!markets.length) return null;
  const ordered = [...markets].sort((a, b) => askKey(b) - askKey(a));
  const title = String(ev.title ?? markets[0].matchup).replace(" Winner?", "").trim();
  return {
    id: ev.event_ticker ?? "",
    title,
    vol: Math.max(0, ...markets.map((m) => m.volume)),
    market_count: markets.length,
    close_time: minCloseTime(markets),
    outcomes: ordered.slice(0, 6).map(toOutcome),
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

// Event cards for a category tab.
export async function cardsForCategory(key: string): Promise<Card[]> {
  const cfg = CATEGORY_BY_KEY[key] ?? CATEGORY_BY_KEY["mlb"];
  if (cfg.source === "trending") {
    return cardsFromEvents(await fetchTrendingEvents(), cfg.category ?? "");
  }
  return fetchSeriesCards(key);
}
