import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarketsByTickers } from "@/lib/kalshi/board";
import { yesMidC, noMidC, isResolved, isVoided, type LiveMarket } from "@/lib/kalshi/market";
import { isMlbTicker, mlbMatchup, mlbTeam } from "@/lib/kalshi/mlb";

// Account snapshot shaped like the original /api/account response, so the UI port can reuse
// the same fields. Money fields are dollars; *_c fields are cents.
export interface PositionState {
  ticker: string;
  matchup: string;
  team: string;
  side: string;
  contracts: number;
  avg_price_c: number;
  mark_c: number | null;
  cost: number;
  value: number;
  unrealized: number;
}

export interface FillState {
  ts: number;
  matchup: string;
  team: string;
  side: string;
  action: string;
  count: number;
  price_c: number;
  fee: number;
  realized: number;
}

export interface AccountState {
  realistic: boolean;
  cash: number;
  starting: number;
  positions_value: number;
  equity: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  positions: PositionState[];
  fills: FillState[];
}

export interface GetAccountStateOpts {
  // Prefetched market data keyed by ticker (the cron passes one shared batch for all users);
  // when absent, this call fetches its own batch (one Kalshi request per 50 held tickers).
  markets?: Map<string, LiveMarket>;
  // Write the leaderboard row regardless of the freshness throttle (trades, cron).
  forceLeaderboard?: boolean;
}

const d = (c: number) => Math.round(c) / 100;

// The leaderboard row is public state, not a cache of this response, so it does not need a
// write per read: account polls land here every few seconds per user, and anonymous
// portfolio views land here too.
const LEADERBOARD_REFRESH_MS = 60_000;

// Builds the account snapshot, marking open positions to the live mid and lazily settling
// any held market that has resolved (or refunding one that voided). Mirrors
// PaperBroker.state() + _marks_and_settle().
export async function getAccountState(
  userId: string,
  opts: GetAccountStateOpts = {},
): Promise<AccountState> {
  const admin = createAdminClient();

  // 1. Fresh marks for held tickers in one batched call; settle any that have resolved.
  const { data: heldRows } = await admin
    .from("positions")
    .select("ticker")
    .eq("user_id", userId);
  const tickers = Array.from(new Set((heldRows ?? []).map((r) => r.ticker as string)));
  let markets = opts.markets;
  let marketFetchFailed = false;
  if (!markets) {
    try {
      markets = tickers.length ? await fetchMarketsByTickers(tickers) : new Map();
    } catch {
      markets = new Map(); // Kalshi unreachable: mark everything at cost this round
      marketFetchFailed = true;
    }
  }
  const marks = new Map<string, { yes: number | null; no: number | null }>();
  let settled = 0;
  for (const t of tickers) {
    const m = markets.get(t);
    if (!m) {
      // Kalshi no longer returns this ticker (delisted?). The position stays, marked at cost.
      if (!marketFetchFailed) console.warn(`no market data for held ticker ${t}; marking at cost`);
      continue;
    }
    if (isResolved(m) || isVoided(m)) {
      const { data } = await admin.rpc("settle_market", {
        p_user: userId,
        p_ticker: t,
        p_result: isVoided(m) ? "void" : m.result,
        p_ts: Date.now(),
      });
      settled += typeof data === "number" ? data : 0;
    } else {
      marks.set(t, { yes: yesMidC(m), no: noMidC(m) });
    }
  }

  // 2. Read account + remaining positions + recent fills (+ leaderboard freshness).
  const [{ data: account }, { data: positions }, { data: fills }, { data: profile }, { data: lbRow }] =
    await Promise.all([
      admin.from("accounts").select("*").eq("id", userId).single(),
      admin.from("positions").select("*").eq("user_id", userId).order("ticker").order("side"),
      admin
        .from("fills")
        .select("*")
        .eq("user_id", userId)
        .order("ts", { ascending: false })
        .limit(40),
      admin.from("profiles").select("username").eq("id", userId).single(),
      admin.from("leaderboard").select("updated_at").eq("id", userId).maybeSingle(),
    ]);

  const cashC: number = account?.cash_c ?? 0;
  const startingC: number = account?.starting_c ?? 0;
  const realizedC: number = account?.realized_pnl_c ?? 0;

  let positionsValueC = 0;
  let positionsCostC = 0;
  const positionStates: PositionState[] = (positions ?? []).map((p) => {
    const mk = marks.get(p.ticker);
    const markC = mk ? (p.side === "yes" ? mk.yes : mk.no) : null;
    const valueC = markC !== null && markC !== undefined ? markC * p.contracts : p.cost_c;
    positionsValueC += valueC;
    positionsCostC += p.cost_c;
    const mlb = isMlbTicker(p.ticker);
    return {
      ticker: p.ticker,
      matchup: mlb ? mlbMatchup(p.matchup) : p.matchup,
      team: mlb ? mlbTeam(p.team, p.ticker) : p.team,
      side: p.side,
      contracts: p.contracts,
      avg_price_c: Math.round((p.cost_c / p.contracts) * 10) / 10,
      mark_c: markC ?? null,
      cost: d(p.cost_c),
      value: d(valueC),
      unrealized: d(valueC - p.cost_c),
    };
  });

  const equityC = cashC + positionsValueC;

  // Refresh this player's public leaderboard row, but only when it is missing, stale, forced
  // (trades, cron), or a settlement just changed realized P&L. Without the throttle every
  // account poll was a database write.
  const lbAge = lbRow?.updated_at ? Date.now() - Date.parse(lbRow.updated_at) : Infinity;
  if (opts.forceLeaderboard || settled > 0 || lbAge > LEADERBOARD_REFRESH_MS) {
    await admin.from("leaderboard").upsert({
      id: userId,
      username: profile?.username ?? "player",
      equity_c: equityC,
      realized_pnl_c: realizedC,
      total_pnl_c: equityC - startingC,
      updated_at: new Date().toISOString(),
    });
  }

  return {
    realistic: !!account?.realistic,
    cash: d(cashC),
    starting: d(startingC),
    positions_value: d(positionsValueC),
    equity: d(equityC),
    realized_pnl: d(realizedC),
    unrealized_pnl: d(positionsValueC - positionsCostC),
    total_pnl: d(equityC - startingC),
    positions: positionStates,
    fills: (fills ?? []).map((f) => ({
      ts: f.ts,
      matchup: isMlbTicker(f.ticker) ? mlbMatchup(f.matchup) : f.matchup,
      team: isMlbTicker(f.ticker) ? mlbTeam(f.team, f.ticker) : f.team,
      side: f.side,
      action: f.action,
      count: f.count,
      price_c: f.price_c,
      fee: d(f.fee_c),
      realized: d(f.realized_c),
    })),
  };
}

// Re-mark every account against live quotes and refresh its leaderboard row. Run on a
// schedule so inactive players' equity still tracks the market (getAccountState also
// settles any resolved holdings as a side effect). All users' held tickers are fetched in
// one deduplicated batch up front, so Kalshi cost stays ~(unique tickers / 50) calls no
// matter how many accounts exist.
export async function refreshLeaderboard(): Promise<number> {
  const admin = createAdminClient();
  const [{ data: users }, { data: allPositions }] = await Promise.all([
    admin.from("accounts").select("id"),
    admin.from("positions").select("ticker"),
  ]);
  const tickers = Array.from(new Set((allPositions ?? []).map((r) => r.ticker as string)));
  let markets: Map<string, LiveMarket>;
  try {
    markets = tickers.length ? await fetchMarketsByTickers(tickers) : new Map();
  } catch {
    markets = new Map();
  }
  for (const u of users ?? []) {
    await getAccountState(u.id as string, { markets, forceLeaderboard: true });
  }
  return users?.length ?? 0;
}
