import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarket } from "@/lib/kalshi/board";
import { yesMidC, noMidC, isResolved } from "@/lib/kalshi/market";

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

const d = (c: number) => Math.round(c) / 100;

// Builds the account snapshot, marking open positions to the live mid and lazily settling
// any held market that has resolved. Mirrors PaperBroker.state() + _marks_and_settle().
export async function getAccountState(userId: string): Promise<AccountState> {
  const admin = createAdminClient();

  // 1. Fresh marks for held tickers; settle any that have resolved.
  const { data: heldRows } = await admin
    .from("positions")
    .select("ticker")
    .eq("user_id", userId);
  const tickers = Array.from(new Set((heldRows ?? []).map((r) => r.ticker as string)));
  const marks = new Map<string, { yes: number | null; no: number | null }>();
  for (const t of tickers) {
    try {
      const m = await fetchMarket(t);
      if (isResolved(m)) {
        await admin.rpc("settle_market", {
          p_user: userId,
          p_ticker: t,
          p_result: m.result,
          p_ts: Date.now(),
        });
      } else {
        marks.set(t, { yes: yesMidC(m), no: noMidC(m) });
      }
    } catch {
      // skip a ticker we couldn't refresh
    }
  }

  // 2. Read account + remaining positions + recent fills.
  const [{ data: account }, { data: positions }, { data: fills }, { data: profile }] =
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
    return {
      ticker: p.ticker,
      matchup: p.matchup,
      team: p.team,
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

  // Refresh this player's public leaderboard row whenever their account is computed.
  await admin.from("leaderboard").upsert({
    id: userId,
    username: profile?.username ?? "player",
    equity_c: equityC,
    realized_pnl_c: realizedC,
    total_pnl_c: equityC - startingC,
    updated_at: new Date().toISOString(),
  });

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
      matchup: f.matchup,
      team: f.team,
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
// settles any resolved holdings as a side effect).
export async function refreshLeaderboard(): Promise<number> {
  const admin = createAdminClient();
  const { data: users } = await admin.from("accounts").select("id");
  for (const u of users ?? []) {
    await getAccountState(u.id as string);
  }
  return users?.length ?? 0;
}
