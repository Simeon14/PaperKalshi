// Ported from kalshi_live.py: the LiveMarket snapshot + top-of-book helpers.
// Kalshi returns top-of-book under `*_dollars` fields; we keep everything in integer cents.

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

export function isTradeable(m: LiveMarket): boolean {
  return m.status === "active" && !isResolved(m) && m.yes_ask_c !== null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toLive(m: any): LiveMarket {
  const title = String(m.title ?? "").replace(" Winner?", "").trim();
  return {
    ticker: m.ticker,
    event_ticker: m.event_ticker ?? "",
    matchup: title,
    team: m.yes_sub_title ?? "",
    yes_bid_c: cents(m.yes_bid_dollars),
    yes_ask_c: cents(m.yes_ask_dollars),
    no_bid_c: cents(m.no_bid_dollars),
    no_ask_c: cents(m.no_ask_dollars),
    last_c: cents(m.last_price_dollars),
    volume: Math.trunc(Number(m.volume_fp ?? 0)) || 0,
    status: m.status ?? "",
    result: m.result ?? "",
    close_time: m.close_time ?? "",
  };
}

// The per-outcome shape sent to the browser (mirrors LiveMarket.to_dict()).
export interface Outcome extends LiveMarket {
  yes_mid_c: number | null;
  no_mid_c: number | null;
  tradeable: boolean;
}

export function toOutcome(m: LiveMarket): Outcome {
  return { ...m, yes_mid_c: yesMidC(m), no_mid_c: noMidC(m), tradeable: isTradeable(m) };
}
