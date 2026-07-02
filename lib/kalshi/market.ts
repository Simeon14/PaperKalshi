// Ported from kalshi_live.py: the LiveMarket snapshot + top-of-book helpers.
// Kalshi returns top-of-book under `*_dollars` fields; we keep everything in integer cents.

import { isMlbTicker, mlbMatchup, mlbTeam } from "@/lib/kalshi/mlb";

export interface LiveMarket {
  ticker: string;
  event_ticker: string;
  matchup: string; // e.g. "Washington vs Baltimore"
  team: string; // the side a YES contract backs (yes_sub_title)
  yes_bid_c: number | null;
  yes_ask_c: number | null;
  no_bid_c: number | null;
  no_ask_c: number | null;
  last_c: number | null;
  volume: number;
  status: string;
  result: string; // '' while active; 'yes' | 'no' once settled
  close_time: string;
  start_time: string; // scheduled game datetime (Kalshi occurrence_datetime); "" if none
}

function cents(d: unknown): number | null {
  if (d === null || d === undefined || d === "") return null;
  const n = Number(d);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Round half to even, matching Python's round() so mids line up with the original app.
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const r = x - f;
  if (r < 0.5) return f;
  if (r > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function mid(bid: number | null, ask: number | null, last: number | null): number | null {
  if (bid !== null && ask !== null) return roundHalfEven((bid + ask) / 2);
  return bid !== null ? bid : ask !== null ? ask : last;
}

export function yesMidC(m: LiveMarket): number | null {
  return mid(m.yes_bid_c, m.yes_ask_c, m.last_c);
}

export function noMidC(m: LiveMarket): number | null {
  const lastNo = m.last_c !== null ? 100 - m.last_c : null;
  return mid(m.no_bid_c, m.no_ask_c, lastNo);
}

export function isResolved(m: LiveMarket): boolean {
  return m.result === "yes" || m.result === "no";
}

// Kalshi occasionally voids a market (result = 'void'): the trade unwinds and holders are
// refunded their cost. Handled separately from isResolved because the payout differs.
export function isVoided(m: LiveMarket): boolean {
  return m.result === "void";
}

export function isTradeable(m: LiveMarket): boolean {
  return m.status === "active" && !isResolved(m) && m.yes_ask_c !== null;
}

// Widest bid-ask (cents) at which a mid still means something. A live main-line book runs
// 1-3c; a dead pre-game book (bid 0-5 / ask 97-98) "mids" to ~49c fiction. Perfect-liquidity
// mode fills buys AT the mid, so fictional mids are exploitable (e.g. buying every NO side of
// a dead mutually-exclusive set is a risk-free arb); the same constant guards the parlay legs.
export const MAX_BOOK_SPREAD_C = 20;

// True when the book is two-sided and tight enough that the mid is a real price. Field names
// are shared by LiveMarket and the client Outcome, so the board, the pills, and the trade
// route all apply the identical test. bid 0 is a real quote (penny longshots stay buyable).
export function hasLiveBook(m: Pick<LiveMarket, "yes_bid_c" | "yes_ask_c">): boolean {
  return (
    m.yes_bid_c !== null && m.yes_ask_c !== null && m.yes_ask_c - m.yes_bid_c <= MAX_BOOK_SPREAD_C
  );
}

// True when BOTH sides are quoted but so far apart that their average is fiction (bid 0 /
// ask 97 "mids" to ~49c). A one-sided book is NOT fictional: mid() falls back to the single
// real quote there. Exits and mark-to-market use this narrower test (a near-resolved market
// often goes one-sided, and its real remaining quote is exactly what a mark should use);
// ENTRY uses the stricter hasLiveBook.
export function midIsFictional(m: Pick<LiveMarket, "yes_bid_c" | "yes_ask_c">): boolean {
  return (
    m.yes_bid_c !== null && m.yes_ask_c !== null && m.yes_ask_c - m.yes_bid_c > MAX_BOOK_SPREAD_C
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toLive(m: any): LiveMarket {
  const ticker = m.ticker ?? "";
  const title = String(m.title ?? "").replace(" Winner?", "").trim();
  const sub = m.yes_sub_title ?? "";
  const mlb = isMlbTicker(ticker);
  return {
    ticker,
    event_ticker: m.event_ticker ?? "",
    matchup: mlb ? mlbMatchup(title) : title,
    team: mlb ? mlbTeam(sub, ticker) : sub,
    yes_bid_c: cents(m.yes_bid_dollars),
    yes_ask_c: cents(m.yes_ask_dollars),
    no_bid_c: cents(m.no_bid_dollars),
    no_ask_c: cents(m.no_ask_dollars),
    last_c: cents(m.last_price_dollars),
    volume: Math.trunc(Number(m.volume_fp ?? 0)) || 0,
    status: m.status ?? "",
    result: m.result ?? "",
    close_time: m.close_time ?? "",
    // occurrence_datetime is the game's scheduled time; expected_expiration_time mirrors it.
    // (close_time is ~2 weeks out for World Cup, so it is not a usable start time.)
    start_time: m.occurrence_datetime ?? m.expected_expiration_time ?? "",
  };
}

// The per-outcome shape sent to the browser: exactly what the board, popups, and trade
// ticket render, nothing more. Server-side logic (settlement, fill pricing) stays on the
// full LiveMarket; keeping this slim matters because a World Cup board ships thousands of
// outcomes per structure refresh.
export interface Outcome {
  ticker: string;
  team: string;
  matchup: string;
  close_time: string;
  yes_bid_c: number | null;
  yes_ask_c: number | null;
  no_bid_c: number | null;
  no_ask_c: number | null;
  last_c: number | null;
  yes_mid_c: number | null;
  no_mid_c: number | null;
  tradeable: boolean;
  group?: string; // market-type label, set for match-grouped (World Cup) cards
}

export function toOutcome(m: LiveMarket): Outcome {
  return {
    ticker: m.ticker,
    team: m.team,
    matchup: m.matchup,
    close_time: m.close_time,
    yes_bid_c: m.yes_bid_c,
    yes_ask_c: m.yes_ask_c,
    no_bid_c: m.no_bid_c,
    no_ask_c: m.no_ask_c,
    last_c: m.last_c,
    yes_mid_c: yesMidC(m),
    no_mid_c: noMidC(m),
    tradeable: isTradeable(m),
  };
}
