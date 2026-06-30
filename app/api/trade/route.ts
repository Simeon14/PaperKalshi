import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarket } from "@/lib/kalshi/board";
import { isResolved } from "@/lib/kalshi/market";
import { computeFill, type Side, type Action } from "@/lib/broker";
import { getAccountState } from "@/lib/account";

// The trusted referee: validate the user, re-price the order against a fresh Kalshi quote,
// then write the result atomically via the apply_trade RPC (service_role bypasses RLS).
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const ticker = String(body.ticker ?? "");
  const side = String(body.side ?? "") as Side;
  const action = String(body.action ?? "") as Action;
  const count = Number(body.count ?? 0);
  if (
    !ticker ||
    (side !== "yes" && side !== "no") ||
    (action !== "buy" && action !== "sell") ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 100000
  ) {
    return NextResponse.json({ error: "invalid order" }, { status: 422 });
  }

  const admin = createAdminClient();
  const market = await fetchMarket(ticker, true); // fresh quote

  if (isResolved(market)) {
    await admin.rpc("settle_market", {
      p_user: user.id,
      p_ticker: ticker,
      p_result: market.result,
      p_ts: Date.now(),
    });
    return NextResponse.json({ error: "market has resolved" }, { status: 409 });
  }

  const { data: acct } = await admin
    .from("accounts")
    .select("realistic")
    .eq("id", user.id)
    .single();
  const realistic = !!acct?.realistic;

  const fill = computeFill(market, side, action, count, realistic);
  if (!fill) {
    return NextResponse.json({ error: "no price available for that side" }, { status: 400 });
  }

  const { data, error } = await admin.rpc("apply_trade", {
    p_user: user.id,
    p_ticker: ticker,
    p_side: side,
    p_action: action,
    p_count: count,
    p_price_c: fill.priceC,
    p_fee_c: fill.feeC,
    p_team: market.team,
    p_matchup: market.matchup,
    p_ts: Date.now(),
  });
  if (error) {
    return NextResponse.json({ error: error.message || "trade rejected" }, { status: 400 });
  }

  const account = await getAccountState(user.id);
  return NextResponse.json({ fill: data, account });
}
