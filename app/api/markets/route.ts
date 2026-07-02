import { NextRequest, NextResponse } from "next/server";
import { cardsForCategory } from "@/lib/kalshi/board";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// Hobby-plan ceiling. The trending walk continues AFTER the response (via after() in
// board.ts) and needs this runway; the default ~10s killed it before the cache ever filled.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!rateLimit("markets:" + clientIp(req), 120, 60_000)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }
  const category = req.nextUrl.searchParams.get("category") ?? "mlb";
  try {
    const board = await cardsForCategory(category);
    if (!board) return NextResponse.json({ error: "unknown category" }, { status: 400 });
    // ageMs lets the client compare this board against its own live quote patches without
    // needing client and server clocks to agree.
    return NextResponse.json({ category, cards: board.cards, ageMs: Date.now() - board.at });
  } catch {
    return NextResponse.json({ category, cards: [], error: "market data unavailable" }, { status: 502 });
  }
}
