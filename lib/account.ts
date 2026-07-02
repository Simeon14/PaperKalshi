import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarketsByTickers } from "@/lib/kalshi/board";
import { yesMidC, noMidC, isResolved, isVoided, midIsFictional, type LiveMarket } from "@/lib/kalshi/market";
import { isMlbTicker, mlbMatchup, mlbTeam } from "@/lib/kalshi/mlb";
import { assessParlay, type ParlayRow } from "@/lib/parlaySettle";
import type { ParlayState } from "@/lib/parlayTypes";

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
  parlays_value: number;
  equity: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  positions: PositionState[];
  parlays: ParlayState[];
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

  // 1. Fresh marks for held tickers AND open-parlay legs in one batched call; settle any that
  // have resolved. Parlay legs join the same deduplicated batch, so they add no Kalshi cost
  // beyond tickers not already held.
  const [{ data: heldRows }, { data: parlayRows }] = await Promise.all([
    admin.from("positions").select("ticker").eq("user_id", userId),
    admin.from("parlays").select("*").eq("user_id", userId).eq("status", "open"),
  ]);
  const openParlays: ParlayRow[] = (parlayRows ?? []).map((r) => ({
    id: r.id,
    created_ts: r.created_ts,
    count: r.count,
    price_c: r.price_c,
    cost_c: r.cost_c,
    legs: r.legs,
    snapshot: r.snapshot,
  }));
  const positionTickers = Array.from(new Set((heldRows ?? []).map((r) => r.ticker as string)));
  const parlayTickers = openParlays.flatMap((p) => p.legs.map((l) => l.ticker));
  const tickers = Array.from(new Set([...positionTickers, ...parlayTickers]));
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
  for (const t of positionTickers) {
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
    } else if (!midIsFictional(m)) {
      marks.set(t, { yes: yesMidC(m), no: noMidC(m) });
    }
    // A wide two-sided book's mid is fiction: leave the ticker unmarked so the position
    // values at cost (same as a missing market) instead of at the fictional average.
  }

  // 1b. Assess open parlays against the same market batch: settle any that resolved (any leg
  // lost => lost; all resolved => won with the frozen-snapshot void reprice, or a void refund),
  // and mark the rest to market. Settlement must run before the account read below so the credited
  // payout + realized P&L are picked up.
  const parlayStates: ParlayState[] = [];
  let parlaysValueC = 0;
  let parlaysCostC = 0;
  let settledParlays = 0;
  for (const p of openParlays) {
    const a = assessParlay(p, markets);
    if (a.action === "settle") {
      await admin.rpc("settle_parlay", {
        p_parlay: p.id,
        p_status: a.status,
        p_payout_c: a.payout_c,
        p_ts: Date.now(),
      });
      settledParlays += 1;
    } else {
      parlayStates.push(a.state);
      parlaysValueC += a.value_c;
      parlaysCostC += a.cost_c;
    }
  }
  parlayStates.sort((x, y) => y.created_ts - x.created_ts); // newest first for display

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

  // Equity = cash + open positions marked to market + open parlays marked to market. Because
  // apply_parlay deducted the cost from cash and settle_parlay credits payouts through realized
  // P&L, this keeps total_pnl = realized + unrealized(positions) + unrealized(parlays) exact.
  const equityC = cashC + positionsValueC + parlaysValueC;

  // Refresh this player's public leaderboard row, but only when it is missing, stale, forced
  // (trades, cron), or a settlement just changed realized P&L. Without the throttle every
  // account poll was a database write.
  const lbAge = lbRow?.updated_at ? Date.now() - Date.parse(lbRow.updated_at) : Infinity;
  if (opts.forceLeaderboard || settled > 0 || settledParlays > 0 || lbAge > LEADERBOARD_REFRESH_MS) {
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
    parlays_value: d(parlaysValueC),
    equity: d(equityC),
    realized_pnl: d(realizedC),
    unrealized_pnl: d(positionsValueC - positionsCostC + parlaysValueC - parlaysCostC),
    total_pnl: d(equityC - startingC),
    positions: positionStates,
    parlays: parlayStates,
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
  const [{ data: users }, { data: allPositions }, { data: allParlays }] = await Promise.all([
    admin.from("accounts").select("id"),
    admin.from("positions").select("ticker"),
    admin.from("parlays").select("legs").eq("status", "open"),
  ]);
  const positionTickers = (allPositions ?? []).map((r) => r.ticker as string);
  const parlayTickers = (allParlays ?? []).flatMap((r) =>
    ((r.legs ?? []) as { ticker: string }[]).map((l) => l.ticker),
  );
  const tickers = Array.from(new Set([...positionTickers, ...parlayTickers]));
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
