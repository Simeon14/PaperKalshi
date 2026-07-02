import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarket } from "@/lib/kalshi/board";
import { type LiveMarket } from "@/lib/kalshi/market";
import { getAccountState } from "@/lib/account";
import { assessParlay, type ParlayRow } from "@/lib/parlaySettle";
import { rateLimit, clientIp } from "@/lib/ratelimit";

export const maxDuration = 30;

// Cash out an open parlay early at its current marked value. The server recomputes the value from
// fresh no-store Kalshi quotes (the client value is never trusted). If a leg has already resolved,
// the parlay is settled normally instead (a lost leg => loss), never cashed out for value.
export async function POST(req: NextRequest) {
  if (!rateLimit("parlaycashout:" + clientIp(req), 60, 60_000)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = String(body?.id ?? "");
  if (!id) return NextResponse.json({ error: "missing parlay id" }, { status: 422 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("parlays")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "open")
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "parlay not found or already settled" }, { status: 404 });

  const parlay: ParlayRow = {
    id: row.id,
    created_ts: row.created_ts,
    count: row.count,
    price_c: row.price_c,
    cost_c: row.cost_c,
    legs: row.legs,
    snapshot: row.snapshot,
  };

  const tickers = Array.from(new Set(parlay.legs.map((l) => l.ticker)));
  let markets: Map<string, LiveMarket>;
  try {
    const fetched = await Promise.all(tickers.map((t) => fetchMarket(t, true)));
    markets = new Map(fetched.filter((m) => m.ticker).map((m) => [m.ticker, m]));
  } catch {
    return NextResponse.json({ error: "market data unavailable" }, { status: 502 });
  }

  const a = assessParlay(parlay, markets);
  if (a.action === "settle") {
    // A leg already resolved: settle it (a lost leg => loss), don't pay out a cash-out value.
    await admin.rpc("settle_parlay", {
      p_parlay: parlay.id,
      p_status: a.status,
      p_payout_c: a.payout_c,
      p_ts: Date.now(),
    });
    const account = await getAccountState(user.id, { forceLeaderboard: true });
    return NextResponse.json({ account, settled: a.status });
  }

  await admin.rpc("cashout_parlay", { p_parlay: parlay.id, p_value_c: a.value_c, p_ts: Date.now() });
  const account = await getAccountState(user.id, { forceLeaderboard: true });
  return NextResponse.json({ account, cashed_out_c: a.value_c });
}
