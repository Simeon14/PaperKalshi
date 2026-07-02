import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarket } from "@/lib/kalshi/board";
import { hasLiveBook, isResolved, isVoided, midIsFictional } from "@/lib/kalshi/market";
import { computeFill, type Side, type Action } from "@/lib/broker";
import { getAccountState } from "@/lib/account";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// Headroom over the ~10s default: a trade is a fresh quote + up to two RPC legs + the
// account snapshot's batched marks, and a slow Kalshi day must not kill it mid-flight.
export const maxDuration = 30;

// The trusted referee: validate the user, re-price the order against a fresh Kalshi quote,
// then write the result atomically via the apply_trade RPC (service_role bypasses RLS).
//
// Positions net per market, like Kalshi: a buy first CLOSES any holding on the other side,
// and only the remainder opens new contracts. The two legs are two apply_trade calls (each
// atomic on the locked account row). On Kalshi's mirrored book the closing sell price is the
// complement of the buy price, so the economics match a single netted order; the one
// divergence is that the taker fee is ceiled per leg, which can cost a cent more than a
// single order would.
export async function POST(req: NextRequest) {
  if (!rateLimit("trade:" + clientIp(req), 60, 60_000)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }
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
    count > 100_000_000 // sanity bound only; affordability is enforced in apply_trade
  ) {
    return NextResponse.json({ error: "invalid order" }, { status: 422 });
  }

  const admin = createAdminClient();
  const market = await fetchMarket(ticker, true); // fresh quote

  if (isResolved(market) || isVoided(market)) {
    await admin.rpc("settle_market", {
      p_user: user.id,
      p_ticker: ticker,
      p_result: isVoided(market) ? "void" : market.result,
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

  // Dead-book guards for perfect-liquidity mode, which fills AT the mid. Buys: no opening
  // exposure without a live two-sided book (a dead book's mid is fiction). Sells: blocked only
  // when the mid is truly fictional (wide two-sided book); a one-sided book's mid falls back to
  // the real remaining quote, and Realistic mode always exits honestly at the live bid.
  if (!realistic && action === "buy" && !hasLiveBook(market)) {
    return NextResponse.json(
      { error: "this market has no live two-sided book right now" },
      { status: 400 },
    );
  }
  if (!realistic && action === "sell" && midIsFictional(market)) {
    return NextResponse.json(
      { error: "this market's book is too wide to exit at a mid price; switch on Realistic fills to sell at the live bid" },
      { status: 400 },
    );
  }

  const applyTrade = (a: Action, s: Side, n: number, priceC: number, feeC: number) =>
    admin.rpc("apply_trade", {
      p_user: user.id,
      p_ticker: ticker,
      p_side: s,
      p_action: a,
      p_count: n,
      p_price_c: priceC,
      p_fee_c: feeC,
      p_team: market.team,
      p_matchup: market.matchup,
      p_ts: Date.now(),
    });

  const fills: unknown[] = [];

  // Netting: how much of a buy just closes the opposite side.
  let closeCount = 0;
  if (action === "buy") {
    const opposite: Side = side === "yes" ? "no" : "yes";
    const { data: opp } = await admin
      .from("positions")
      .select("contracts")
      .eq("user_id", user.id)
      .eq("ticker", ticker)
      .eq("side", opposite)
      .maybeSingle();
    closeCount = Math.min(count, opp?.contracts ?? 0);
    if (closeCount > 0) {
      const closeFill = computeFill(market, opposite, "sell", closeCount, realistic);
      if (!closeFill) {
        return NextResponse.json(
          { error: `no price available to close your ${opposite.toUpperCase()} position` },
          { status: 400 },
        );
      }
      const { data, error } = await applyTrade("sell", opposite, closeCount, closeFill.priceC, closeFill.feeC);
      if (error) {
        return NextResponse.json({ error: error.message || "trade rejected" }, { status: 400 });
      }
      fills.push(data);
    }
  }

  const remainder = action === "buy" ? count - closeCount : count;
  if (remainder > 0) {
    const fill = computeFill(market, side, action, remainder, realistic);
    if (!fill) {
      if (fills.length) {
        // The closing leg executed but the opening side has no usable price (the book moved
        // between legs). Report the partial result honestly instead of erroring it away.
        const account = await getAccountState(user.id, { forceLeaderboard: true });
        return NextResponse.json({
          fills,
          account,
          warning: "Closed your opposite position, but no price was available to open the rest.",
        });
      }
      return NextResponse.json({ error: "no price available for that side" }, { status: 400 });
    }
    const { data, error } = await applyTrade(action, side, remainder, fill.priceC, fill.feeC);
    if (error) {
      if (fills.length) {
        const account = await getAccountState(user.id, { forceLeaderboard: true });
        return NextResponse.json({
          fills,
          account,
          warning: error.message || "The opening leg was rejected after your opposite position closed.",
        });
      }
      return NextResponse.json({ error: error.message || "trade rejected" }, { status: 400 });
    }
    fills.push(data);
  }

  const account = await getAccountState(user.id, { forceLeaderboard: true });
  return NextResponse.json({ fills, account });
}
