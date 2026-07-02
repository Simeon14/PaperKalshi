import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { boardOutcomeInfo, fetchMarket } from "@/lib/kalshi/board";
import { yesMidC, noMidC, isTradeable, type LiveMarket } from "@/lib/kalshi/market";
import { getAccountState } from "@/lib/account";
import { buildParlayQuote, normalizeLegs, type LegMarket, type Mode } from "@/lib/parlayQuote";
import { QuoteError } from "@/lib/parlay/quote";
import { computeParlayHolds, PARLAY_HOLD_INFO } from "@/lib/parlayHold";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// A parlay places a fresh no-store quote per leg + one RPC + the account snapshot; give it the
// same headroom the single-trade route gets so a slow Kalshi day can't kill it mid-flight.
export const maxDuration = 30;

// The trusted referee for placing a parlay: re-price every leg against a fresh no-store Kalshi
// quote (the client's shown price is never trusted), honor max_price_c with a 409 + fresh quote on
// a reprice, then write the parlay atomically via apply_parlay (service_role bypasses RLS).
export async function POST(req: NextRequest) {
  if (!rateLimit("parlaytrade:" + clientIp(req), 60, 60_000)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const parsed = normalizeLegs(body?.legs);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  // TEMPORARY hold (lib/parlayHold.ts): only MLB legs and independent World Cup picks may be
  // placed until the other pricing models land. Quoting stays open; placing does not.
  const holds = computeParlayHolds(parsed.legs.map((l) => l.ticker));
  if (holds.length) {
    return NextResponse.json({ error: PARLAY_HOLD_INFO[holds[0]].label, holds }, { status: 400 });
  }

  // Sizing is per unit: contracts mode fixes an integer contract count (cost = count*price at the
  // fresh price); dollars mode fixes an exact dollar stake and the contract count / payout float
  // with the price, so a $20 parlay costs exactly $20 and pays the true stake*multiple on a win.
  const unit = body?.unit === "dollars" ? "dollars" : "contracts";
  let inCount = 0;
  let inCostC = 0;
  if (unit === "dollars") {
    inCostC = Math.round(Number(body?.cost_c ?? 0));
    if (!Number.isFinite(inCostC) || inCostC < 1 || inCostC > 1_000_000_000) {
      return NextResponse.json({ error: "invalid parlay amount" }, { status: 422 });
    }
  } else {
    inCount = Number(body?.count ?? 0);
    if (!Number.isInteger(inCount) || inCount < 1 || inCount > 100_000_000) {
      return NextResponse.json({ error: "invalid contract count" }, { status: 422 });
    }
  }
  const rawMax = body?.max_price_c;
  const maxPriceC = rawMax === undefined || rawMax === null ? null : Number(rawMax);
  if (maxPriceC !== null && !Number.isFinite(maxPriceC)) {
    return NextResponse.json({ error: "invalid max_price_c" }, { status: 422 });
  }

  const admin = createAdminClient();
  const { data: acct } = await admin.from("accounts").select("realistic").eq("id", user.id).single();
  const mode: Mode = acct?.realistic ? "realistic" : "default";

  // Fresh, no-store quote per unique leg (order execution never reads the cached quote path).
  let markets: LiveMarket[];
  try {
    markets = await Promise.all(parsed.legs.map((l) => fetchMarket(l.ticker, true)));
  } catch {
    return NextResponse.json({ error: "market data unavailable" }, { status: 502 });
  }
  const legMarkets: LegMarket[] = parsed.legs.map((l, i) => {
    const m = markets[i];
    // Prefer the board card's clean title/group over the market-level fields (a score market's
    // own title is the question, not the game). These land in the stored legs jsonb.
    const info = boardOutcomeInfo(l.ticker);
    return {
      ticker: l.ticker,
      side: l.side,
      yesBidC: m.yes_bid_c,
      noBidC: m.no_bid_c,
      yesMidC: yesMidC(m),
      noMidC: noMidC(m),
      yesAskC: m.yes_ask_c,
      noAskC: m.no_ask_c,
      team: m.team,
      matchup: info?.matchup || m.matchup,
      group: info?.group,
      tradeable: isTradeable(m),
    };
  });

  let built: ReturnType<typeof buildParlayQuote>;
  try {
    built = buildParlayQuote(legMarkets, mode);
  } catch (e) {
    // Impossible combos and sub-floor longshots are refused (Fix 4): a clean 400, not a 500.
    if (e instanceof QuoteError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
  if (!built.ok) {
    return NextResponse.json(
      { error: "some legs are no longer buyable; rebuild your parlay", invalid: built.invalid },
      { status: 400 },
    );
  }
  const { quote, snapshot } = built.built;

  // Reprice guard: if the fresh price is worse than the ceiling the client agreed to, bounce it
  // with the fresh quote so the builder can show the new price for one-click acceptance.
  if (maxPriceC !== null && quote.price_c > maxPriceC) {
    return NextResponse.json({ error: "price moved", quote }, { status: 409 });
  }

  // Size against the FRESH price. Contracts mode: cost = count*price. Dollars mode: cost is the
  // fixed stake and count is the implied number of $1-payout contracts (for the blotter + the
  // per-contract settle price).
  const priceC = quote.price_c;
  const count = unit === "dollars" ? Math.max(1, Math.round(inCostC / priceC)) : inCount;
  const costC = unit === "dollars" ? inCostC : inCount * priceC;

  const { data: parlay, error } = await admin.rpc("apply_parlay", {
    p_user: user.id,
    p_count: count,
    p_price_c: priceC,
    p_cost_c: costC,
    p_legs: quote.legs,
    p_snapshot: snapshot,
    p_ts: Date.now(),
  });
  if (error) {
    // insufficient cash and friends surface here as a clean 400.
    return NextResponse.json({ error: error.message || "parlay rejected" }, { status: 400 });
  }

  const account = await getAccountState(user.id, { forceLeaderboard: true });
  return NextResponse.json({ parlay, account });
}
