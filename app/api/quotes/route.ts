import { NextRequest, NextResponse } from "next/server";
import { fetchQuotes } from "@/lib/kalshi/board";

// Batched price refresh for a set of tickers (the markets currently on the user's screen, or
// the open buy ticket). One Kalshi call regardless of count. Public market data; no auth.
export async function GET(req: NextRequest) {
  const tickers = (req.nextUrl.searchParams.get("tickers") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  if (!tickers.length) return NextResponse.json({ quotes: {} });
  try {
    return NextResponse.json({ quotes: await fetchQuotes(tickers, fresh) });
  } catch {
    return NextResponse.json({ quotes: {} }, { status: 502 });
  }
}
