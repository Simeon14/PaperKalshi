import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { boardOutcomeInfo, fetchQuotes } from "@/lib/kalshi/board";
import { buildParlayQuote, normalizeLegs, type LegMarket, type Mode } from "@/lib/parlayQuote";
import { QuoteError } from "@/lib/parlay/quote";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// A quote is a batched Kalshi call plus pure pricing; give it headroom over the ~10s default in
// case Kalshi is slow, but it never writes anything.
export const maxDuration = 20;

// Price a would-be parlay for the builder. Auth + rate limited; reads live marginals server-side
// (mids in the default mode, executable asks in realistic mode) so the client's numbers are never
// trusted. Returns the correlation-aware price plus the independence baseline (overview contract 3).
export async function POST(req: NextRequest) {
  if (!rateLimit("parlayquote:" + clientIp(req), 120, 60_000)) {
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

  const admin = createAdminClient();
  const { data: acct } = await admin.from("accounts").select("realistic").eq("id", user.id).single();
  const mode: Mode = acct?.realistic ? "realistic" : "default";

  const tickers = parsed.legs.map((l) => l.ticker);
  let quotes: Record<string, import("@/lib/kalshi/market").Outcome>;
  try {
    quotes = await fetchQuotes(tickers);
  } catch {
    return NextResponse.json({ error: "market data unavailable" }, { status: 502 });
  }

  // Join each leg to its live quote in leg order. A ticker Kalshi no longer returns is treated
  // as non-buyable and reported back so the builder can prune it.
  const legMarkets: LegMarket[] = parsed.legs.map((l) => {
    const o = quotes[l.ticker];
    // Prefer the board card's clean title/group over the market-level fields (a score market's
    // own title is the question, not the game).
    const info = boardOutcomeInfo(l.ticker);
    return {
      ticker: l.ticker,
      side: l.side,
      yesBidC: o?.yes_bid_c ?? null,
      noBidC: o?.no_bid_c ?? null,
      yesMidC: o?.yes_mid_c ?? null,
      noMidC: o?.no_mid_c ?? null,
      yesAskC: o?.yes_ask_c ?? null,
      noAskC: o?.no_ask_c ?? null,
      team: o?.team ?? "",
      matchup: info?.matchup || o?.matchup || "",
      group: info?.group,
      tradeable: !!o?.tradeable,
    };
  });

  let built: ReturnType<typeof buildParlayQuote>;
  try {
    built = buildParlayQuote(legMarkets, mode);
  } catch (e) {
    // The engine refuses impossible combos and sub-floor longshots (Fix 4): a clean 400 the
    // builder renders, not a 500.
    if (e instanceof QuoteError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
  if (!built.ok) {
    return NextResponse.json(
      { error: "some legs are not currently buyable", invalid: built.invalid },
      { status: 400 },
    );
  }
  return NextResponse.json(built.built.quote);
}
