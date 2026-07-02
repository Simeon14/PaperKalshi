import { NextRequest, NextResponse } from "next/server";
import { fetchQuotes } from "@/lib/kalshi/board";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// Batched price refresh for a set of tickers (the markets currently on the user's screen, or
// the open trade ticket). One Kalshi call regardless of count, shared across pollers by a 1s
// server-side cache; order execution never reads this (the trade route pulls its own no-store
// quote). Public market data, so instead of auth it is per-IP rate limited.
export async function GET(req: NextRequest) {
  if (!rateLimit("quotes:" + clientIp(req), 600, 60_000)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }
  const tickers = (req.nextUrl.searchParams.get("tickers") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tickers.length) return NextResponse.json({ quotes: {} });
  try {
    return NextResponse.json({ quotes: await fetchQuotes(tickers) });
  } catch {
    return NextResponse.json({ quotes: {} }, { status: 502 });
  }
}
