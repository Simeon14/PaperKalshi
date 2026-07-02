// Category board (event cards), ported from kalshi_live.py. Server-side only.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { after } from "next/server";
import {
  LiveMarket,
  Outcome,
  hasLiveBook,
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
import { MLB_TYPE } from "@/lib/mlbGroups";

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
  card_prefix?: string; // grouped cards: card id prefix (default "WCM"); "MLBM" for MLB
  primary_series?: string; // grouped cards: the series pinned inline as the primary market
  mlb_titles?: boolean; // grouped cards: map MLB city names to club nicknames in the card title
  start_offset_min?: number; // minutes to add to the primary market's occurrence_datetime to get
  //                            the real kickoff (Kalshi's occurrence == settlement; soccer = -180)
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
  start_time?: string; // scheduled game datetime (from the primary market's occurrence_datetime)
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
    // Pin regulation Moneyline (KXWCGAME) as the inline market, and back out the real kickoff:
    // Kalshi's occurrence_datetime for soccer is the expected settlement (scheduled start + ~3h).
    group_by_match: true, primary_series: "KXWCGAME", start_offset_min: -180,
    ttl: 45,
  },
  {
    key: "mlb", label: "MLB", source: "series",
    // Grouped match cards like World Cup: one card per game, every market type inside. The event
    // ticker is "<SERIES>-<gameKey>" and the gameKey is identical across every MLB series for a
    // game (Parlay/reports/02-mlb-market-anatomy.md), so they group cleanly. Moneyline (KXMLBGAME)
    // is pinned as the inline primary market. Player-prop series are included so the parlay builder
    // can reach them; illiquid ones simply return no events and cost one empty fetch.
    series: [
      "KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL", "KXMLBTEAMTOTAL", "KXMLBF3", "KXMLBF5",
      "KXMLBF5SPREAD", "KXMLBF5TOTAL", "KXMLBF7", "KXMLBEXTRAS", "KXMLBRFI",
      "KXMLBHIT", "KXMLBHR", "KXMLBHRR", "KXMLBKS", "KXMLBRBI", "KXMLBSB", "KXMLBTB", "KXMLBOUTS",
    ],
    group_by_match: true, card_prefix: "MLBM", primary_series: "KXMLBGAME", mlb_titles: true, ttl: 8,
  },
  { key: "elections", label: "Elections", source: "trending", category: "Elections", ttl: 180 },
  { key: "politics", label: "Politics", source: "trending", category: "Politics", ttl: 180 },
  { key: "finance", label: "Finance", source: "trending", category: "Financials", ttl: 180 },
  { key: "tech", label: "Tech & Science", source: "trending", category: "Science and Technology", ttl: 180 },
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
// at) AND a two-sided book tight enough that the mid is meaningful (hasLiveBook): a dead
// pre-game book mids to ~49c fiction. The board only ever lists buyable outcomes;
// non-tradeable ones are dropped entirely rather than shown greyed, so dead books simply
// reappear when their makers show up.
function isBuyable(m: LiveMarket): boolean {
  const mid = yesMidC(m);
  return isTradeable(m) && hasLiveBook(m) && mid != null && mid >= 1 && mid <= 99;
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

async function fetchSeriesCards(cfg: CategoryCfg): Promise<Card[]> {
  const series = await seriesFor(cfg);
  if (!series.length) return [];
  const lists = await mapLimit(series, 6, (s) => eventsForSeries(s, cfg.ttl));
  const events = lists.flat();
  if (cfg.group_by_match)
    return matchCardsFromEvents(events, {
      idPrefix: cfg.card_prefix,
      primarySeries: cfg.primary_series,
      mlbTitles: cfg.mlb_titles,
      startOffsetMin: cfg.start_offset_min,
    });
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

// World Cup + MLB market-type labels, keyed by the event ticker's series prefix. The MLB labels
// live in lib/mlbGroups.ts so the parlay quote route names leg market types identically. The two
// prefix namespaces are disjoint, so the merge never collides.
const TYPE_LABELS: Record<string, string> = { ...WC_TYPE, ...MLB_TYPE };

function marketTypeLabel(ev: any): string {
  const prefix = String(ev.event_ticker ?? "").split("-")[0];
  if (TYPE_LABELS[prefix]) return TYPE_LABELS[prefix];
  const title = String(ev.title ?? "");
  const i = title.indexOf(": ");
  return (i >= 0 ? title.slice(i + 2) : title).trim() || "Market";
}

// Group a category's events into one card PER MATCH. Every event ticker is "<SERIES>-<gameKey>"
// (e.g. KXWCTOTAL-26JUL01ENGCOD, KXMLBHR-26JUL022210SDLAD), so the suffix after the first "-" is
// the match key and every market-type event for the same match shares it. (Verified for MLB in
// Parlay/reports/02-mlb-market-anatomy.md: player-prop player codes live in the MARKET ticker, not
// the event ticker, so player-prop events group with the game with no special handling.) The card
// lists every market's outcomes (tagged with `group`); `primarySeries` pins one market type inline
// (MLB moneyline), else the highest-volume group leads. The whole card opens the full-markets popup.
interface MatchOpts {
  idPrefix?: string; // card id prefix; "WCM" (World Cup) by default, "MLBM" for MLB
  primarySeries?: string; // the series pinned inline as the primary market (else highest volume)
  mlbTitles?: boolean; // map MLB city names to club nicknames in the card title
  startOffsetMin?: number; // minutes to add to occurrence_datetime to get the real kickoff
}
function matchCardsFromEvents(events: any[], opts: MatchOpts = {}, maxCards = 40): Card[] {
  const idPrefix = opts.idPrefix ?? "WCM";
  const byMatch = new Map<string, any[]>();
  for (const ev of events) {
    const et = String(ev.event_ticker ?? "");
    const dash = et.indexOf("-");
    const key = dash >= 0 ? et.slice(dash + 1) : et;
    (byMatch.get(key) ?? byMatch.set(key, []).get(key)!).push(ev);
  }

  const cards: Card[] = [];
  for (const [key, evs] of byMatch) {
    const groups: { label: string; series: string; vol: number; outcomes: Outcome[]; startTime: string }[] = [];
    for (const ev of evs) {
      const markets = ((ev.markets ?? []) as any[]).map(toLive).filter(isBuyable);
      if (!markets.length) continue;
      markets.sort((a, b) => oddsKey(b) - oddsKey(a));
      groups.push({
        label: marketTypeLabel(ev),
        series: String(ev.event_ticker ?? "").split("-")[0],
        vol: Math.max(0, ...markets.map((m) => m.volume)),
        outcomes: markets.slice(0, MAX_OUTCOMES).map(toOutcome),
        startTime: markets[0]?.start_time ?? "",
      });
    }
    if (!groups.length) continue;
    // Primary market first: the pinned series if configured (MLB moneyline), else highest volume.
    groups.sort((a, b) => {
      if (opts.primarySeries) {
        const pa = a.series === opts.primarySeries ? 0 : 1;
        const pb = b.series === opts.primarySeries ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      return b.vol - a.vol;
    });
    const outcomes = groups.flatMap((g) => g.outcomes.map((o) => ({ ...o, group: g.label })));
    const titleSrc =
      evs.map((e) => String(e.title ?? "")).find((t) => t.includes(" vs ")) ??
      String(evs[0].title ?? "");
    let title = titleSrc.includes(" vs ") ? titleSrc.split(": ")[0].trim() : titleSrc.trim();
    if (opts.mlbTitles) title = mlbMatchup(title);
    const closeTimes = evs
      .flatMap((e) => ((e.markets ?? []) as any[]).map((m) => m.close_time as string))
      .filter(Boolean)
      .sort();
    // The primary market's occurrence_datetime is the expected settlement; back out the real
    // kickoff with the sport's offset (soccer settles ~3h after the scheduled start).
    const occ = groups[0]?.startTime ? Date.parse(groups[0].startTime) : NaN;
    const startTime = Number.isNaN(occ)
      ? undefined
      : new Date(occ + (opts.startOffsetMin ?? 0) * 60000).toISOString();
    cards.push({
      id: idPrefix + "-" + key,
      title: title || key,
      vol: Math.max(0, ...groups.map((g) => g.vol)),
      market_count: groups.length,
      close_time: closeTimes[0] ?? "",
      outcomes,
      grouped: true,
      start_time: startTime,
    });
  }
  cards.sort((a, b) => b.vol - a.vol);
  return cards.slice(0, maxCards);
}

// One shared walk of ALL open events (with nested markets), reused by every trending
// category. Kalshi's /events has no category filter, returns the FARTHEST-closing events
// first (2099 futures on page one), and silently ignores min/max_close_ts, so any partial
// walk samples exactly the least relevant markets; a correct board needs the whole list.
// The whole list is heavy (~25 pages, ~2.5MB each), so the walk is progressive: a cold start
// serves after TRENDING_FIRST_PAGES (the old code's latency), the walk continues in the
// background under a time budget, and the completed result is shared by every trending
// category for TRENDING_TTL_MS. Events outside the trending categories are discarded as
// pages arrive and the rest are trimmed to the fields the card builders read, so the cache
// stays a few MB instead of ~50.
const TRENDING_CATEGORIES = new Set(
  CATEGORIES.filter((c) => c.source === "trending").map((c) => c.category as string),
);
let trendingComplete: { at: number; events: any[] } | null = null;
let trendingInflight: Promise<any[]> | null = null;
let trendingFirstPages: Promise<any[]> | null = null;
const TRENDING_TTL_MS = 600_000; // refresh the full walk in the background every 10 min
const TRENDING_FIRST_PAGES = 4; // cold start: serve once this many pages are in
const TRENDING_MAX_PAGES = 40; // safety cap (~8000 events), far above the ~4400 observed
// Must fit inside the markets route's maxDuration (60s, the Vercel Hobby ceiling) together
// with the response itself; a page in flight when the budget trips still completes.
const TRENDING_TIME_BUDGET_MS = 45_000;
const TRENDING_COLD_DEADLINE_MS = 15_000; // a cold-start request never waits longer than this

// On Vercel a serverless function freezes once its response is sent, so a floating background
// promise (an SWR rebuild, the rest of the trending walk) would silently stop. after() keeps
// the function alive until the work settles. Outside a request scope this is a no-op.
function keepAlive(work: Promise<unknown>) {
  try {
    after(work.catch(() => {}));
  } catch {
    /* not in a request scope (tests, scripts): nothing to extend */
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trimEvent(ev: any): any {
  return {
    event_ticker: ev.event_ticker,
    title: ev.title,
    category: ev.category,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markets: ((ev.markets ?? []) as any[]).map((m) => ({
      ticker: m.ticker,
      event_ticker: m.event_ticker,
      title: m.title,
      yes_sub_title: m.yes_sub_title,
      yes_bid_dollars: m.yes_bid_dollars,
      yes_ask_dollars: m.yes_ask_dollars,
      no_bid_dollars: m.no_bid_dollars,
      no_ask_dollars: m.no_ask_dollars,
      last_price_dollars: m.last_price_dollars,
      volume_fp: m.volume_fp,
      status: m.status,
      result: m.result,
      close_time: m.close_time,
    })),
  };
}

// Never rejects: on an upstream failure it returns (and warns about) what it collected.
async function walkTrendingEvents(onPartial: (events: any[]) => void): Promise<any[]> {
  const events: any[] = [];
  const started = Date.now();
  let cursor: string | undefined;
  for (let i = 0; i < TRENDING_MAX_PAGES; i++) {
    try {
      const payload = await listEventsRaw(
        { status: "open", with_nested_markets: true, limit: 200, cursor },
        { revalidate: 600 },
      );
      for (const ev of payload.events ?? []) {
        if (TRENDING_CATEGORIES.has(ev.category)) events.push(trimEvent(ev));
      }
      cursor = payload.cursor || undefined;
    } catch {
      console.warn(`trending walk failed at page ${i + 1}; serving ${events.length} events`);
      return events;
    }
    if (i + 1 === TRENDING_FIRST_PAGES) onPartial([...events]);
    if (!cursor) return events;
    if (Date.now() - started > TRENDING_TIME_BUDGET_MS) {
      // Never truncate silently: a budget-stopped walk means boards may be missing events.
      console.warn(
        `trending walk stopped at page ${i + 1} after ${Date.now() - started}ms (slow upstream)`,
      );
      return events;
    }
  }
  console.warn(`trending walk hit the ${TRENDING_MAX_PAGES}-page cap`);
  return events;
}

async function fetchTrendingEvents(): Promise<any[]> {
  if (trendingComplete && Date.now() - trendingComplete.at < TRENDING_TTL_MS) {
    return trendingComplete.events;
  }
  if (!trendingInflight) {
    let releasePartial!: (evs: any[]) => void;
    trendingFirstPages = new Promise<any[]>((resolve) => (releasePartial = resolve));
    trendingInflight = walkTrendingEvents(releasePartial)
      .then((events) => {
        releasePartial(events); // walks shorter than the partial threshold resolve here
        if (events.length) trendingComplete = { at: Date.now(), events };
        return events;
      })
      .finally(() => {
        trendingInflight = null;
        trendingFirstPages = null;
      });
    trendingInflight.catch(() => {});
    keepAlive(trendingInflight); // the walk must outlive the response that started it
  }
  if (trendingComplete) return trendingComplete.events; // stale while the walk refreshes behind
  // Cold start: unblock on the first pages (the walk keeps upgrading the cache behind us),
  // but never hang the request if even those are slow; an empty board is not cached, so the
  // next structure poll simply tries again.
  const source = trendingFirstPages ?? trendingInflight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<any[]>((resolve) => {
    timer = setTimeout(() => resolve([]), TRENDING_COLD_DEADLINE_MS);
  });
  const events = await Promise.race([source, deadline]);
  clearTimeout(timer);
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

// Quotes for a specific set of tickers in ONE Kalshi call. Powers the fast, viewport-scoped
// price refresh: cost is a single request no matter how many markets are visible. The 1s
// revalidate keeps quotes effectively live for the 500ms ticket poll while letting concurrent
// pollers of the same set share the call (and capping what any one URL can cost us upstream).
// Order EXECUTION never uses this: the trade route pulls its own no-store quote.
export async function fetchQuotes(tickers: string[]): Promise<Record<string, Outcome>> {
  const uniq = Array.from(new Set(tickers.filter(Boolean))).slice(0, 50);
  if (!uniq.length) return {};
  const payload = await getMarketsRaw(
    { tickers: uniq.join(","), limit: uniq.length },
    { revalidate: 1 },
  );
  const out: Record<string, Outcome> = {};
  for (const m of payload.markets ?? []) {
    const live = toLive(m);
    if (live.ticker) out[live.ticker] = toOutcome(live);
  }
  return out;
}

// LiveMarkets for a set of tickers, batched 50 per Kalshi call. Used for account marking and
// settlement detection, where each held ticker previously cost its own round-trip. Settled
// markets ARE returned by this endpoint (verified: status "finalized" comes back); tickers
// Kalshi no longer knows are simply absent from the map.
export async function fetchMarketsByTickers(tickers: string[]): Promise<Map<string, LiveMarket>> {
  const uniq = Array.from(new Set(tickers.filter(Boolean)));
  const out = new Map<string, LiveMarket>();
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const payload = await getMarketsRaw(
      { tickers: chunk.join(","), limit: chunk.length },
      { revalidate: 5 },
    );
    for (const m of payload.markets ?? []) {
      const live = toLive(m);
      if (live.ticker) out.set(live.ticker, live);
    }
  }
  return out;
}

// Assembled-board cache: hand back the identical set of cards for a category for its ttl window.
// This is what keeps the board STABLE across the client's periodic structure refetch (same set
// in, same order out, no reshuffle) and avoids re-fanning-out to Kalshi on every request. Prices
// are not stale in practice: the client patches them from the separate /api/quotes poll (~1.5s)
// and uses `at` to know which side is fresher when merging.
const boardCache = new Map<string, { at: number; cards: Card[] }>();
const boardInflight = new Map<string, Promise<Card[]>>();

export interface Board {
  cards: Card[];
  at: number; // when this board was assembled (server clock)
}

// Board-derived display info for one market: the card's clean title as the matchup (e.g.
// "Switzerland vs Algeria" where the raw market title is "Will the final score be Draw 1-1?")
// plus its market-type group label. Reads only the in-memory board cache (no Kalshi calls);
// returns null on a cold instance or an unboarded ticker, and callers fall back to the
// market-level fields.
export function boardOutcomeInfo(ticker: string): { matchup: string; group?: string } | null {
  for (const { cards } of boardCache.values()) {
    for (const c of cards) {
      const o = c.outcomes.find((x) => x.ticker === ticker);
      if (o) return { matchup: c.title, group: o.group };
    }
  }
  return null;
}

// Event cards for a category tab. Returns null for an unknown category key.
// Concurrent cache misses share one in-flight build (a stampede would otherwise multiply the
// Kalshi fan-out), and an expired entry is served stale while the rebuild runs in the
// background, so nobody waits on a rebuild after first load.
export async function cardsForCategory(key: string): Promise<Board | null> {
  const cfg = CATEGORY_BY_KEY[key];
  if (!cfg) return null;
  const now = Date.now();
  const hit = boardCache.get(key);
  if (hit && now - hit.at < cfg.ttl * 1000) return { cards: hit.cards, at: hit.at };

  let pending = boardInflight.get(key);
  if (!pending) {
    pending = (async () => {
      const cards =
        cfg.source === "trending"
          ? cardsFromEvents(await fetchTrendingEvents(), cfg.category ?? "")
          : await fetchSeriesCards(cfg);
      if (cards.length) boardCache.set(key, { at: Date.now(), cards }); // don't pin a transient empty fetch
      return cards;
    })();
    boardInflight.set(key, pending);
    pending.catch(() => {}).finally(() => boardInflight.delete(key));
    keepAlive(pending); // an SWR rebuild must survive the stale response being sent
  }

  if (hit) {
    // Stale-while-revalidate: a background failure just means we keep serving the stale board.
    return { cards: hit.cards, at: hit.at };
  }
  const cards = await pending;
  return { cards, at: boardCache.get(key)?.at ?? Date.now() };
}
